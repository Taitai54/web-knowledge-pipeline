"""
Local search server for the web knowledge pipeline RAG chat.
Embeds queries with sentence-transformers (no Pinecone embedding credits),
reranks with the same local cross-encoder as pinecone_mcp.py, then queries
any Pinecone index in the account that a local model can embed for: vector
indexes by dimension (e5), document indexes by the model recorded in their
schema (e.g. Qwen3-Embedding-0.6B for peace-docs) via the documents API.
A search can span several namespaces; on document indexes with a full-text
field it also runs BM25 keyword search. All ranked lists are fused by rank
before reranking.

Usage:
    python search_server.py

Runs on http://localhost:8765
The process warms the default index's embedding model and the reranker at
startup; other indexes load their model the first time they are selected.
"""

import json
import os
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

from pinecone_shared import DIM_TO_LOCAL_MODEL, e5_query_prefix, get_api_key

import requests
from flask import Flask, request, Response

PINECONE_API_KEY = get_api_key() or os.environ.get("PINECONE_API_KEY", "")
PINECONE_INDEX = os.environ.get("PINECONE_INDEX", "peace")
PORT = int(os.environ.get("SEARCH_SERVER_PORT", "8765"))
CONTROL_PLANE = "https://api.pinecone.io"
API_VERSION = "2026-07"
INDEX_LIST_TTL_SECONDS = 60
EMBED_MODEL_TAG = "embed_model="
QWEN_EMBED_MODEL = "Qwen/Qwen3-Embedding-0.6B"
HOSTED_TO_LOCAL_MODEL = {"multilingual-e5-large": "intfloat/multilingual-e5-large"}
LOCAL_QUERY_MODELS = set(DIM_TO_LOCAL_MODEL.values()) | {QWEN_EMBED_MODEL}
DOCUMENT_FIELDS = ("text", "title", "source", "doc_type", "section")
MAX_NAMESPACES = 8
MAX_KEYWORD_CHARS = 2000
RRF_K = 60

app = Flask(__name__)

_init_lock = threading.RLock()
_index_cache = {"at": 0.0, "rows": []}
_models = {}
_model_states = {}
_model_errors = {}
_RERANK_STATE = "cold"


def candidate_limit(top_k: int, rerank: bool) -> int:
    """Match pinecone_mcp: a larger pool when reranking, clamped to 20–30."""
    top_k = min(max(int(top_k), 1), 20)
    if not rerank:
        return top_k
    return min(max(top_k * 4, 20), 30)


def list_namespace_rows(stats: dict) -> list:
    raw = stats.get("namespaces") or {}
    rows = []
    for name, info in raw.items():
        label = str(name).strip()
        if not label:
            continue
        count = int((info or {}).get("vectorCount") or 0)
        rows.append({"name": label, "vectorCount": count})
    rows.sort(key=lambda row: (-row["vectorCount"], row["name"].lower()))
    return rows


def _schema_parts(item: dict) -> tuple:
    """(kind, dense_field, dimension, recorded_model, hosted_model, text_field) from a control-plane index.

    Mirrors pinecone-management's parse_index_model: 2026-07 responses carry schema.fields;
    document indexes name their own dense_vector field and record the model that built them
    as "embed_model=<id>" in its description. Older responses have top-level dimension/embed.
    text_field is the first full-text (BM25) string field, or "".
    """
    fields = ((item.get("schema") or {}).get("fields")) or {}
    dense_name, dense, semantic, text_field = "", None, None, ""
    for name, field in fields.items():
        ftype = (field or {}).get("type")
        if ftype == "dense_vector" and dense is None:
            dense_name, dense = name, field
        elif ftype == "semantic_text" and semantic is None:
            semantic = field
        elif ftype == "string" and field.get("full_text_search") is not None and not text_field:
            text_field = name
    if dense is None and semantic is not None and semantic.get("dimension"):
        dense_name, dense = "_values", semantic
    if dense is None and "dimension" in item:
        dense_name, dense = "_values", {"dimension": item.get("dimension")}
    is_document = bool(text_field) or dense_name not in ("", "_values")
    description = str((dense or {}).get("description") or "")
    recorded = description[len(EMBED_MODEL_TAG):].strip() if description.startswith(EMBED_MODEL_TAG) else ""
    hosted = str((semantic or {}).get("model") or (item.get("embed") or {}).get("model") or "")
    return (
        "document" if is_document else "vector",
        dense_name if is_document else "",
        int((dense or {}).get("dimension") or 0),
        recorded,
        hosted,
        text_field if is_document else "",
    )


def index_rows(raw: list, default_index: str) -> list:
    """Control-plane index list -> rows with the local query model each one needs."""
    rows = []
    for item in raw:
        name = str(item.get("name") or "")
        if not name:
            continue
        kind, dense_field, dimension, recorded, hosted, text_field = _schema_parts(item)
        if recorded:
            model = recorded
        elif hosted:
            model = HOSTED_TO_LOCAL_MODEL.get(hosted, "")
        else:
            model = DIM_TO_LOCAL_MODEL.get(dimension, "")
        reason = ""
        if not model:
            reason = (f"Index embeds with {hosted}; no local query model" if hosted
                      else f"No local query model for {dimension}-dimension vectors")
        elif model not in LOCAL_QUERY_MODELS:
            reason = f"Index was built with {model}; local search does not support it"
            model = ""
        host = str(item.get("host") or "")
        rows.append({
            "name": name,
            "dimension": dimension,
            "host": host if host.startswith("http") else f"https://{host}",
            "ready": (item.get("status") or {}).get("state") == "Ready",
            "model": model,
            "reason": reason,
            "kind": kind,
            "denseField": dense_field,
            "textField": text_field,
        })
    rows.sort(key=lambda row: (row["name"] != default_index, row["name"].lower()))
    return rows


def encode_query(model_name: str, model, text: str) -> list:
    if model_name == QWEN_EMBED_MODEL:
        return model.encode([text], prompt_name="query", normalize_embeddings=True)[0].tolist()
    return model.encode([e5_query_prefix(text)], normalize_embeddings=True)[0].tolist()


def _documents_search(info: dict, namespace: str, score_by: dict, pool: int) -> list:
    resp = requests.post(
        f"{info['host']}/namespaces/{quote(namespace, safe='')}/documents/search",
        headers={"Api-Key": PINECONE_API_KEY, "Content-Type": "application/json",
                 "X-Pinecone-API-Version": API_VERSION},
        json={"top_k": pool, "score_by": [score_by], "include_fields": list(DOCUMENT_FIELDS)},
        timeout=20,
    )
    print(f"[search_server] Pinecone {score_by['type']} {namespace!r}: {resp.status_code}", flush=True)
    if not resp.ok:
        raise RuntimeError(f"Pinecone error {resp.status_code}: {resp.text[:300]}")
    return [(m.get("_id", ""), m.get("_score", 0), m) for m in resp.json().get("matches", [])]


def keyword_matches(info: dict, namespace: str, text: str, pool: int) -> list:
    """BM25 matches as (id, score, fields) from a document index's full-text field."""
    return _documents_search(
        info, namespace, {"type": "text", "fields": [info["textField"]], "query": text[:MAX_KEYWORD_CHARS]}, pool,
    )


def parse_namespaces(data: dict) -> list:
    """`namespaces` list (or legacy `namespace` string) -> unique, non-blank names, capped."""
    raw = data.get("namespaces")
    if not isinstance(raw, list) or not raw:
        raw = [data.get("namespace", "")]
    names = []
    for item in raw:
        name = str(item or "").strip()
        if name and name not in names:
            names.append(name)
    return names[:MAX_NAMESPACES]


def fuse_ranked(lists: list, limit: int) -> list:
    """Reciprocal-rank fusion of ranked lists of (id, score, fields, namespace, method).

    Keyword (BM25) scores depend on each namespace's term statistics and aren't on the
    dense scale, so lists are merged by rank. Returns dicts with the dense score (None
    when only keyword search found the chunk) and which methods matched.
    """
    merged = {}
    for ranked in lists:
        for rank, (match_id, score, fields, namespace, method) in enumerate(ranked):
            key = match_id or f"{namespace}:{rank}:{method}"
            entry = merged.setdefault(key, {"id": match_id, "fused": 0.0, "score": None,
                                            "fields": fields, "namespace": namespace, "methods": []})
            entry["fused"] += 1.0 / (RRF_K + rank + 1)
            if method == "meaning" and entry["score"] is None:
                entry["score"] = score
            if method not in entry["methods"]:
                entry["methods"].append(method)
    ordered = sorted(merged.values(), key=lambda entry: entry["fused"], reverse=True)
    return ordered[:limit]


def query_matches(info: dict, namespace: str, vector: list, pool: int) -> list:
    """Top matches as (id, score, fields) from either the vectors or documents API."""
    if info["kind"] == "document":
        return _documents_search(
            info, namespace, {"type": "dense_vector", "fields": [info["denseField"]], "values": vector}, pool,
        )

    resp = requests.post(
        f"{info['host']}/query",
        headers={"Api-Key": PINECONE_API_KEY, "Content-Type": "application/json"},
        json={"vector": vector, "top_k": pool, "includeMetadata": True, "namespace": namespace},
        timeout=20,
    )
    print(f"[search_server] Pinecone status: {resp.status_code}", flush=True)
    if not resp.ok:
        raise RuntimeError(f"Pinecone error {resp.status_code}: {resp.text[:300]}")
    return [(m.get("id", ""), m.get("score", 0), m.get("metadata") or {}) for m in resp.json().get("matches", [])]


def ok(data: dict, status: int = 200) -> Response:
    body = json.dumps(data)
    r = Response(body, status=status, mimetype="application/json")
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return r


def err(message: str, status: int = 500) -> Response:
    print(f"[search_server] ERROR {status}: {message}", flush=True)
    return ok({"error": message}, status)


def list_indexes(force: bool = False) -> list:
    if not force and _index_cache["rows"] and time.time() - _index_cache["at"] < INDEX_LIST_TTL_SECONDS:
        return _index_cache["rows"]
    resp = requests.get(
        f"{CONTROL_PLANE}/indexes",
        headers={"Api-Key": PINECONE_API_KEY, "X-Pinecone-API-Version": API_VERSION},
        timeout=20,
    )
    if not resp.ok:
        raise RuntimeError(f"Pinecone error {resp.status_code}: {resp.text[:300]}")
    rows = index_rows(resp.json().get("indexes") or [], PINECONE_INDEX)
    _index_cache.update(at=time.time(), rows=rows)
    return rows


def index_info(name: str) -> dict:
    wanted = (name or PINECONE_INDEX).strip()
    for force in (False, True):
        for row in list_indexes(force=force):
            if row["name"] == wanted:
                return row
    raise ValueError(f"Index '{wanted}' was not found in this Pinecone project")


def load_model(model_name: str):
    if model_name in _models:
        return _models[model_name]
    _model_states[model_name] = "loading"
    with _init_lock:
        if model_name in _models:
            return _models[model_name]
        print(f"[search_server] Loading {model_name}…", flush=True)
        try:
            from sentence_transformers import SentenceTransformer

            _models[model_name] = SentenceTransformer(model_name)
        except Exception as exc:
            _model_states[model_name] = "error"
            _model_errors[model_name] = str(exc)
            raise
        _model_states[model_name] = "ready"
        _model_errors.pop(model_name, None)
        print(f"[search_server] {model_name} loaded.", flush=True)
    return _models[model_name]


def warm_model_in_background(model_name: str) -> None:
    if _model_states.get(model_name, "cold") != "cold":
        return
    _model_states[model_name] = "loading"

    def run():
        try:
            load_model(model_name)
        except Exception as exc:
            print(f"[search_server] model warm failed: {exc}", flush=True)

    threading.Thread(target=run, daemon=True).start()


def fetch_namespace_rows(host: str) -> list:
    resp = requests.post(
        f"{host}/describe_index_stats",
        headers={"Api-Key": PINECONE_API_KEY, "Content-Type": "application/json"},
        json={},
        timeout=20,
    )
    if not resp.ok:
        raise RuntimeError(f"Pinecone error {resp.status_code}: {resp.text[:300]}")
    return list_namespace_rows(resp.json())


def _warm_startup():
    global _RERANK_STATE
    _RERANK_STATE = "loading"
    try:
        info = index_info(PINECONE_INDEX)
        if info["model"]:
            load_model(info["model"])
    except Exception as exc:
        print(f"[search_server] default index warm failed: {exc}", flush=True)
    try:
        from pinecone_mcp import _get_reranker

        _get_reranker()
        _RERANK_STATE = "ready"
        print("[search_server] Reranker loaded.", flush=True)
    except Exception as exc:
        _RERANK_STATE = "unavailable"
        print(f"[search_server] rerank unavailable: {exc}", flush=True)
    print("[search_server] Ready for chat.", flush=True)


def _as_bool(value, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"0", "false", "no", "off"}


@app.route("/health")
def health():
    name = (request.args.get("index") or PINECONE_INDEX).strip()
    try:
        info = index_info(name)
    except Exception as exc:
        return ok({"status": "ok", "model": "error", "rerank": _RERANK_STATE, "index": name, "error": str(exc)})
    if not info["model"]:
        return ok({"status": "ok", "model": "unsupported", "rerank": _RERANK_STATE, "index": name,
                   "error": info["reason"]})
    warm_model_in_background(info["model"])
    return ok({
        "status": "ok",
        "model": _model_states.get(info["model"], "cold"),
        "rerank": _RERANK_STATE,
        "index": name,
        "error": _model_errors.get(info["model"], ""),
    })


@app.route("/indexes")
def indexes():
    if not PINECONE_API_KEY:
        return err("PINECONE_API_KEY not set", 500)
    try:
        rows = list_indexes()
    except Exception as exc:
        traceback.print_exc(file=sys.stdout)
        return err(str(exc), 500)
    return ok({
        "default": PINECONE_INDEX,
        "indexes": [{key: row[key] for key in ("name", "dimension", "ready", "model", "reason")} for row in rows],
    })


@app.route("/namespaces")
def namespaces():
    if not PINECONE_API_KEY:
        return err("PINECONE_API_KEY not set", 500)
    name = (request.args.get("index") or PINECONE_INDEX).strip()
    try:
        rows = fetch_namespace_rows(index_info(name)["host"])
    except Exception as exc:
        traceback.print_exc(file=sys.stdout)
        return err(str(exc), 500)
    return ok({"index": name, "namespaces": rows})


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
        namespaces = parse_namespaces(data)
        index_name = str(data.get("index") or PINECONE_INDEX).strip()
        top_k = min(max(int(data.get("topK", 8)), 1), 20)
        rerank = _as_bool(data.get("rerank"), True)

        print(f"[search_server] query={query!r} index={index_name!r} ns={namespaces!r} top_k={top_k}", flush=True)

        if not query:
            return err("query is required", 400)
        if not namespaces:
            return err("namespace is required", 400)
        if not PINECONE_API_KEY:
            return err("PINECONE_API_KEY not set", 500)

        try:
            info = index_info(index_name)
        except ValueError as exc:
            return err(str(exc), 400)
        if not info["model"]:
            return err(info["reason"], 400)

        model = load_model(info["model"])
        vec = encode_query(info["model"], model, query)
        print(f"[search_server] vector computed (dim={len(vec)})", flush=True)

        pool = candidate_limit(top_k, rerank)
        hybrid = bool(info.get("textField"))
        jobs = [(ns, "meaning") for ns in namespaces] + ([(ns, "keyword") for ns in namespaces] if hybrid else [])

        def run(job):
            ns, method = job
            if method == "keyword":
                found = keyword_matches(info, ns, query, pool)
            else:
                found = query_matches(info, ns, vec, pool)
            return [(match_id, score, meta, ns, method) for match_id, score, meta in found]

        lists, errors = [], []
        with ThreadPoolExecutor(max_workers=min(8, len(jobs))) as executor:
            for job, future in zip(jobs, [executor.submit(run, job) for job in jobs]):
                try:
                    lists.append(future.result())
                except Exception as exc:
                    errors.append({"namespace": job[0], "method": job[1], "error": str(exc)[:300]})
        if not lists:
            return err(errors[0]["error"] if errors else "Search failed", 500)

        chunks = []
        for entry in fuse_ranked(lists, pool):
            meta = entry["fields"]
            chunks.append({
                "id": entry["id"],
                "score": entry["score"],
                "title": meta.get("title") or meta.get("source") or entry["id"] or "Source",
                "source": meta.get("source", ""),
                "text": meta.get("text", ""),
                "docType": meta.get("doc_type", ""),
                "section": meta.get("section", ""),
                "namespace": entry["namespace"],
                "matchedBy": entry["methods"],
            })

        did_rerank = False
        if rerank and chunks:
            try:
                from pinecone_mcp import _rerank_results

                chunks, did_rerank = _rerank_results(query, chunks, top_k)
            except Exception as exc:
                print(f"[search_server] rerank skipped: {exc}", flush=True)
                chunks = chunks[:top_k]
        else:
            chunks = chunks[:top_k]

        print(f"[search_server] returning {len(chunks)} chunks reranked={did_rerank}", flush=True)
        return ok({"chunks": chunks, "reranked": did_rerank, "hybrid": hybrid,
                   "namespaces": namespaces, "errors": errors})

    except BaseException as e:
        traceback.print_exc(file=sys.stdout)
        sys.stdout.flush()
        return err(str(e), 500)


if __name__ == "__main__":
    if not PINECONE_API_KEY:
        print("ERROR: PINECONE_API_KEY environment variable not set.", file=sys.stderr)
        sys.exit(1)
    print(f"[search_server] Starting on http://localhost:{PORT}", flush=True)
    print("[search_server] Warming embedding model and reranker…", flush=True)
    threading.Thread(target=_warm_startup, daemon=True).start()
    app.run(host="0.0.0.0", port=PORT, debug=False, use_reloader=False)
