"""
Local search server for markdown-to-action-plan.
Embeds queries using sentence-transformers (free, no Pinecone credits)
then queries Pinecone with the pre-computed vector.

Usage:
    python search_server.py

Runs on http://localhost:8765
"""

import json
import os
import sys
import traceback
import requests
from flask import Flask, request, Response

from pinecone_shared import DIM_TO_LOCAL_MODEL, e5_query_prefix, get_api_key

PINECONE_API_KEY = get_api_key() or os.environ.get("PINECONE_API_KEY", "")
PINECONE_INDEX = os.environ.get("PINECONE_INDEX", "peace")
PORT = int(os.environ.get("SEARCH_SERVER_PORT", "8765"))

app = Flask(__name__)

_model = None
_host = None
_dimension = None


def ok(data: dict, status: int = 200) -> Response:
    body = json.dumps(data)
    r = Response(body, status=status, mimetype="application/json")
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return r


def err(message: str, status: int = 500) -> Response:
    print(f"[search_server] ERROR {status}: {message}", flush=True)
    return ok({"error": message}, status)


def get_host():
    global _host, _dimension
    if _host is None:
        print("[search_server] Fetching Pinecone host…", flush=True)
        from pinecone import Pinecone
        pc = Pinecone(api_key=PINECONE_API_KEY)
        info = pc.describe_index(PINECONE_INDEX)
        raw = info.host
        _host = raw if raw.startswith("http") else f"https://{raw}"
        _dimension = int(getattr(info, "dimension", 1024) or 1024)
        print(f"[search_server] Pinecone host: {_host}  (dimension: {_dimension})", flush=True)
    return _host


def get_model():
    global _model
    if _model is None:
        get_host()  # populates _dimension
        model_name = DIM_TO_LOCAL_MODEL.get(_dimension, "intfloat/multilingual-e5-large")
        print(f"[search_server] Loading {model_name} (first request only)…", flush=True)
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(model_name)
        print("[search_server] Model loaded.", flush=True)
    return _model


@app.route("/health")
def health():
    return ok({"status": "ok"})


@app.route("/search", methods=["POST", "OPTIONS"])
def search():
    if request.method == "OPTIONS":
        r = Response("", status=204)
        r.headers["Access-Control-Allow-Origin"] = "*"
        r.headers["Access-Control-Allow-Headers"] = "Content-Type"
        r.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        return r

    print("[search_server] /search called", flush=True)

    try:
        raw = request.get_data(as_text=True) or "{}"
        print(f"[search_server] body: {raw[:200]}", flush=True)
        try:
            data = json.loads(raw)
        except Exception:
            return err("Request body is not valid JSON", 400)

        query = str(data.get("query", "")).strip()
        namespace = str(data.get("namespace", "")).strip()
        top_k = min(int(data.get("topK", 8)), 20)

        print(f"[search_server] query={query!r} ns={namespace!r} top_k={top_k}", flush=True)

        if not query:
            return err("query is required", 400)
        if not namespace:
            return err("namespace is required", 400)
        if not PINECONE_API_KEY:
            return err("PINECONE_API_KEY not set", 500)

        model = get_model()
        vec = model.encode([e5_query_prefix(query)], normalize_embeddings=True)[0].tolist()
        print(f"[search_server] vector computed (dim={len(vec)})", flush=True)

        host = get_host()
        resp = requests.post(
            f"{host}/query",
            headers={"Api-Key": PINECONE_API_KEY, "Content-Type": "application/json"},
            json={
                "vector": vec,
                "top_k": top_k,
                "includeMetadata": True,
                "namespace": namespace,
            },
            timeout=15,
        )
        print(f"[search_server] Pinecone status: {resp.status_code}", flush=True)

        if not resp.ok:
            return err(f"Pinecone error {resp.status_code}: {resp.text[:300]}", 500)

        matches = resp.json().get("matches", [])
        chunks = []
        for m in matches:
            meta = m.get("metadata") or {}
            chunks.append({
                "id": m.get("id", ""),
                "score": m.get("score", 0),
                "title": meta.get("title") or meta.get("source") or m.get("id", "Source"),
                "source": meta.get("source", ""),
                "text": meta.get("text", ""),
                "docType": meta.get("doc_type", ""),
                "section": meta.get("section", ""),
            })

        print(f"[search_server] returning {len(chunks)} chunks", flush=True)
        return ok({"chunks": chunks})

    except BaseException as e:
        traceback.print_exc(file=sys.stdout)
        sys.stdout.flush()
        return err(str(e), 500)


if __name__ == "__main__":
    if not PINECONE_API_KEY:
        print("ERROR: PINECONE_API_KEY environment variable not set.", file=sys.stderr)
        sys.exit(1)
    print(f"[search_server] Starting on http://localhost:{PORT}", flush=True)
    print("[search_server] First search will load the embedding model (~1-2 min).", flush=True)
    app.run(host="0.0.0.0", port=PORT, debug=False, use_reloader=False)
