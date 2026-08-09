#!/usr/bin/env python3
"""
Pinecone bulk upload script — targets the 'peace' index.
Embeds locally by default (sentence-transformers, multilingual-e5-large
family, 1024 dim) so uploads cost zero embedding tokens. Pass --paid-embed
to use Pinecone's integrated (token-billed) embedding instead.
Supports .md, .txt, .rst, and .pdf files.

Usage:
  python ~/.claude/pinecone_bulk.py <paths...> [options]
  (paths can be folders, individual files, or any mix of both)

Options:
  --doc-type    book|kb|notes|markdown  (auto-detected if omitted)
  --tags        comma-separated tags to apply to all records
  --dry-run     preview chunks without uploading
  --no-recursive  scan top-level folder only
  --paid-embed  use Pinecone's integrated embedding instead of free local embedding

Examples:
  python ~/.claude/pinecone_bulk.py "C:/Books" --doc-type book --tags "philosophy,stoicism"
  python ~/.claude/pinecone_bulk.py "C:/Notes" --dry-run
"""

import os, sys, re, time, json, hashlib, argparse, random, unicodedata
from pathlib import Path
from collections import defaultdict

from pinecone_shared import (
    PINECONE_API_KEY,
    CHUNK_WORDS,
    OVERLAP_WORDS,
    MIN_CHUNK_WORDS,
    DIM_TO_LOCAL_MODEL,
    e5_passage_prefix,
)

# ── Config ───────────────────────────────────────────────────────────────────
BATCH_SIZE       = 96    # max records per upsert call (Pinecone inference limit)
STREAM_FLUSH_RECORDS = 1000  # upload namespace buckets before memory grows unbounded
FETCH_EXISTING_BATCH_SIZE = 500
MAX_VECTOR_PAYLOAD_BYTES = 1_800_000  # Pinecone hard limit is 2MB; keep margin
UPLOAD_QUEUE_PUT_TIMEOUT = 30

# ── Rate Limiting ────────────────────────────────────────────────────────────
MAX_RETRIES      = 3     # max retry attempts per batch
INITIAL_RETRY_DELAY = 1  # initial backoff delay in seconds
MAX_BACKOFF      = 60    # maximum backoff delay in seconds
JITTER_FACTOR    = 0.1   # 10% random jitter to avoid thundering herd
# ─────────────────────────────────────────────────────────────────────────────

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: pip install requests")


# ── Local embedding (optional) ───────────────────────────────────────────────
# Only loaded when --client-embed is used.
# LOCAL_MODEL_ID is auto-selected at runtime to match the index dimension;
# the default below is overridden by main() before any embedding starts.

LOCAL_MODEL_ID = "intfloat/multilingual-e5-large"   # 1024-dim default
_LOCAL_MODEL = None
_LOCAL_DEVICE = None  # cached device string so callers can query it

# DIM_TO_LOCAL_MODEL (index dimension -> matching intfloat e5 model) is
# imported from pinecone_shared above so bulk/mcp/search_server stay in sync.


def _pick_device():
    """Pick the fastest available compute device. CUDA > MPS > CPU."""
    try:
        import torch
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _device_embed_batch(device: str) -> int:
    """Return a sensible encode batch size for the given device.

    GPU (CUDA): large batches fill VRAM and amortise kernel launch overhead.
    MPS: Apple Silicon — moderate batch; MPS memory is unified so 128 is safe.
    CPU: keep smaller to avoid paging; sentence-transformers will multi-thread
         internally via torch.set_num_threads().
    """
    if device == "cuda":
        return 256
    if device == "mps":
        return 128
    return 32  # CPU — conservative; avoids OOM on machines with <16 GB RAM


def _ensure_local_model():
    """Lazy-load sentence-transformers model. Cached for reuse across batches.

    Picks the best device (CUDA > MPS > CPU). Applies fp16 on CUDA/CPU
    (roughly 2× throughput); skips fp16 on MPS where it can be unstable.
    Sets torch thread count to all logical cores on CPU paths.
    """
    global _LOCAL_MODEL, _LOCAL_DEVICE
    if _LOCAL_MODEL is not None:
        return _LOCAL_MODEL
    try:
        from sentence_transformers import SentenceTransformer
        import torch
    except ImportError:
        sys.exit(
            "Local embedding requires sentence-transformers (torch>=2.0).\n"
            "  Install:  pip install sentence-transformers\n"
            "  (First run will download model weights on first use.)"
        )

    # Disable HuggingFace Hub download progress bars BEFORE loading.
    # HF Hub uses \r (carriage return only, no \n) to update download progress
    # in place.  When stdout is piped to the GUI the line-reader blocks waiting
    # for a \n that only arrives when the entire file finishes downloading —
    # potentially gigabytes later.  Disabling these bars keeps the pipe clear
    # so the GUI stays responsive throughout the download.
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    # Suppress the "tokenizers parallelism" fork-safety warning that otherwise
    # clutters the console when running inside a subprocess.
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    device = _pick_device()
    _LOCAL_DEVICE = device

    # Use all logical cores for CPU encoding; sentence-transformers honours this.
    if device == "cpu":
        torch.set_num_threads(os.cpu_count() or 8)

    print(f"Loading local embedding model: {LOCAL_MODEL_ID}  (device: {device})")
    print("(first-run: downloading model weights — may take several minutes)...")
    sys.stdout.flush()
    model = SentenceTransformer(LOCAL_MODEL_ID, device=device)

    # Half precision: ~2× faster on GPU and on AVX-512 CPUs, negligible quality
    # loss for retrieval. Skip on Apple Silicon MPS where fp16 path can be flaky.
    if device != "mps":
        try:
            model.half()
            print(f"  fp16 enabled on {device}.")
        except Exception:
            pass  # If hardware can't do fp16 cleanly, stay in fp32.

    _LOCAL_MODEL = model
    embed_batch = _device_embed_batch(device)
    print(f"Model loaded.  Encode batch size: {embed_batch}  (device: {device})")
    return _LOCAL_MODEL


def local_embed_passages(texts: list) -> list:
    """Encode document chunks. e5 models require the 'passage: ' prefix for
    indexing and 'query: ' for retrieval — Pinecone integrated-embed handles
    this automatically; here we add it ourselves so vectors match.

    Batch size is chosen per-device at load time for maximum throughput:
      CUDA  → 256   (fills VRAM, amortises kernel overhead)
      MPS   → 128   (unified memory, moderate)
      CPU   → 32    (thread-parallel inside torch; keeps memory safe)
    """
    model = _ensure_local_model()
    embed_batch = _device_embed_batch(_LOCAL_DEVICE or "cpu")
    prefixed = [e5_passage_prefix(t) for t in texts]
    vecs = model.encode(
        prefixed,
        batch_size=embed_batch,
        normalize_embeddings=True,
        show_progress_bar=len(prefixed) > embed_batch,  # show bar for multi-batch runs
        convert_to_numpy=True,
    )
    return [v.tolist() for v in vecs]


# ── Rate Limiting Helpers ────────────────────────────────────────────────────

def exponential_backoff(retry_count: int) -> float:
    """
    Calculate exponential backoff delay with +/- JITTER_FACTOR jitter.
    Formula: clamp(INITIAL_RETRY_DELAY * 2^retry_count + jitter, 0.1, MAX_BACKOFF),
    where jitter ~ uniform(-JITTER_FACTOR, +JITTER_FACTOR) * base_delay.
    """
    base_delay = INITIAL_RETRY_DELAY * (2 ** retry_count)
    jitter = base_delay * random.uniform(-JITTER_FACTOR, JITTER_FACTOR)
    delay = min(base_delay + jitter, MAX_BACKOFF)
    return max(0.1, delay)  # Never less than 100ms


def get_retry_delay(response) -> float:
    """
    Extract retry delay from response headers or use exponential backoff.
    Respects server-provided Retry-After header if present.
    """
    if response.status_code == 429:
        # Check for Retry-After header (in seconds or HTTP-date format)
        retry_after = response.headers.get("Retry-After", "")
        if retry_after:
            try:
                # Try parsing as integer (seconds)
                return float(retry_after)
            except ValueError:
                # Try parsing as HTTP-date (RFC 7231)
                try:
                    from email.utils import parsedate_to_datetime
                    retry_time = parsedate_to_datetime(retry_after).timestamp()
                    return max(0.1, retry_time - time.time())
                except Exception:
                    pass
    return -1.0


# ── Chunking ─────────────────────────────────────────────────────────────────

def word_chunks(words: list) -> list:
    """Split a word list into overlapping chunks. Returns list of strings."""
    chunks = []
    i = 0
    while i < len(words):
        chunk = words[i : i + CHUNK_WORDS]
        if len(chunk) >= MIN_CHUNK_WORDS:
            chunks.append(" ".join(chunk))
        i += CHUNK_WORDS - OVERLAP_WORDS
    return chunks


def chunk_markdown(text: str) -> list:
    """
    Split markdown on headings (# / ## / ###).
    Each chunk is prefixed with its nearest heading for better embedding context.
    Returns list of (section_heading, chunk_text) tuples.
    """
    sections = re.split(r"\n(?=#{1,3} )", text)
    result = []
    for section in sections:
        lines = section.strip().split("\n")
        heading = lines[0].lstrip("#").strip() if lines[0].startswith("#") else ""
        body = "\n".join(lines[1:]).strip()
        if not body:
            continue
        words = body.split()
        prefix = f"{heading}: " if heading else ""
        if len(words) <= CHUNK_WORDS:
            result.append((heading, prefix + body))
        else:
            for chunk in word_chunks(words):
                result.append((heading, prefix + chunk))
    return result


def chunk_plain(text: str) -> list:
    """
    Chunk plain text by paragraphs then words with overlap.
    Returns list of ('', chunk_text) tuples.
    """
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip()]
    buffer = []
    results = []
    for para in paragraphs:
        buffer.extend(para.split())
        while len(buffer) >= CHUNK_WORDS:
            results.append(("", " ".join(buffer[:CHUNK_WORDS])))
            buffer = buffer[CHUNK_WORDS - OVERLAP_WORDS:]
    if len(buffer) >= MIN_CHUNK_WORDS:
        results.append(("", " ".join(buffer)))
    return results


def parse_frontmatter(text: str) -> tuple:
    """
    Strip YAML frontmatter from markdown and return (meta dict, body text).
    Handles simple key:value pairs and list items (- "value").
    Falls back to PyYAML if installed; otherwise uses regex.
    """
    match = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, re.DOTALL)
    if not match:
        return {}, text

    raw_fm = match.group(1)
    body   = text[match.end():]
    meta   = {}

    try:
        import yaml
        meta = yaml.safe_load(raw_fm) or {}
    except Exception:
        # Fall back to regex — handles malformed YAML (e.g. colons in title values)
        current_key = None
        for line in raw_fm.splitlines():
            list_item = re.match(r'^\s+-\s+"?([^"]+)"?\s*$', line)
            kv        = re.match(r'^(\w[\w\s]*?):\s*(.*)', line)
            if list_item and current_key:
                if not isinstance(meta.get(current_key), list):
                    meta[current_key] = []
                meta[current_key].append(list_item.group(1).strip())
            elif kv:
                current_key      = kv.group(1).strip()
                meta[current_key] = kv.group(2).strip()

    # Normalise tags → always a flat list of strings
    raw_tags = meta.get("tags", [])
    if isinstance(raw_tags, str):
        raw_tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
    elif isinstance(raw_tags, list):
        raw_tags = [str(t).strip().strip('"') for t in raw_tags if t]
    meta["tags"] = raw_tags

    return meta, body


_PYPDF_OK = None  # tri-state: None = not yet checked, True = importable, False = missing


def _ensure_pypdf() -> bool:
    """Check pypdf availability once. On first miss, print a loud warning."""
    global _PYPDF_OK
    if _PYPDF_OK is not None:
        return _PYPDF_OK
    try:
        import pypdf  # noqa: F401
        _PYPDF_OK = True
    except ImportError:
        _PYPDF_OK = False
        print("\n" + "=" * 70)
        print("  PDF SUPPORT NOT INSTALLED — every .pdf in this run will be skipped.")
        print("  Fix:  pip install pypdf")
        print("=" * 70 + "\n")
    return _PYPDF_OK


def sanitize_text(text: str) -> str:
    """Replace lone surrogate characters with U+FFFD.

    pypdf can produce lone surrogates when extracting text from PDFs with
    malformed or non-standard Unicode encoding. Python allows surrogates in
    str objects but they crash UTF-8 encoding, JSON serialisation, and
    hashlib — which would abort the entire upload run without this guard.
    """
    return text.encode("utf-8", "replace").decode("utf-8")


def read_pdf(path: Path) -> str:
    if not _ensure_pypdf():
        return ""
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        pages = [page.extract_text() or "" for page in reader.pages]
        return sanitize_text("\n\n".join(pages))
    except Exception as e:
        print(f"  [pdf-error] {path.name}: {e}")
        return ""


def iter_supported_files(raw_paths: list, recursive: bool = True,
                         supported: set = None) -> list:
    """Return unique supported files as (file_path, root_folder) pairs.

    Folder inputs use the folder as their root so path-derived metadata keeps
    working. Direct file inputs use the file parent as their root.
    """
    supported = supported or {".md", ".txt", ".rst", ".pdf"}
    pattern = "**/*" if recursive else "*"
    targets: list[tuple[Path, Path]] = []
    seen: set[Path] = set()

    for raw in raw_paths:
        p = Path(raw)
        if not p.exists():
            sys.exit(f"Error: path not found: {p}")
        if p.is_dir():
            for f in sorted(p.glob(pattern)):
                if f.is_file() and f.suffix.lower() in supported:
                    rf = f.resolve()
                    if rf not in seen:
                        seen.add(rf)
                        targets.append((f, p))
        elif p.is_file():
            if p.suffix.lower() not in supported:
                print(f"  Skipping unsupported file: {p.name}")
                continue
            rf = p.resolve()
            if rf not in seen:
                seen.add(rf)
                targets.append((p, p.parent))
        else:
            sys.exit(f"Error: path is neither file nor folder: {p}")

    return targets


def input_path_summary(raw_paths: list, supported: set = None) -> tuple:
    """Return display-only folder/direct-file counts for the selected inputs."""
    supported = supported or {".md", ".txt", ".rst", ".pdf"}
    folders_scanned: list[Path] = []
    files_added_directly: list[Path] = []
    seen: set[Path] = set()

    for raw in raw_paths:
        p = Path(raw)
        if p.is_dir():
            folders_scanned.append(p)
        elif p.is_file() and p.suffix.lower() in supported:
            rf = p.resolve()
            if rf not in seen:
                seen.add(rf)
                files_added_directly.append(p)

    return folders_scanned, files_added_directly


# ── Path-derived metadata ─────────────────────────────────────────────────────

def slugify(s: str) -> str:
    """Lowercase, ascii-fold, collapse whitespace and underscores into hyphens.
    Used to turn folder names ("Mental Health") into clean tag/namespace
    values ("mental-health")."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^\w\s-]", "", s).strip().lower()
    s = re.sub(r"[\s_-]+", "-", s)
    return s.strip("-")


def path_derived_metadata(file_path: Path, root_folder: Path):
    """For a file at root_folder/A/B/C/x.md, return ('a', ['a', 'b', 'c']).
    Files directly inside root_folder return (None, [])."""
    try:
        rel = file_path.relative_to(root_folder)
    except ValueError:
        return None, []
    folder_parts = [p for p in rel.parts[:-1] if p]  # exclude filename
    if not folder_parts:
        return None, []
    slugged = [slugify(p) for p in folder_parts if slugify(p)]
    if not slugged:
        return None, []
    return slugged[0], slugged


# Maps folder-name slugs to doc_type values. Plurals collapse to singular,
# and common synonyms (videos / podcasts) collapse to 'transcript' since
# that is what they end up being once chunked.
DOC_TYPE_FOLDER_MAP = {
    "book":        "book",   "books":        "book",
    "paper":       "paper",  "papers":       "paper",
    "article":     "article","articles":     "article",
    "transcript":  "transcript", "transcripts": "transcript",
    "podcast":     "transcript", "podcasts":   "transcript",
    "video":       "transcript", "videos":     "transcript",
    "youtube":     "transcript",
    "note":        "notes",  "notes":        "notes",
    "summary":     "summary","summaries":    "summary",
    "kb":          "kb",
}


def infer_doc_type_from_path(file_path: Path, root_folder: Path):
    """Walk the file's folder slugs and return a doc_type if any folder name
    matches DOC_TYPE_FOLDER_MAP. Returns None if nothing matched."""
    _, slugs = path_derived_metadata(file_path, root_folder)
    for slug in slugs:
        if slug in DOC_TYPE_FOLDER_MAP:
            return DOC_TYPE_FOLDER_MAP[slug]
    return None


# ── File processing ───────────────────────────────────────────────────────────

def process_file(path: Path, doc_type_override, tags: list,
                 root_folder: Path = None,
                 auto_tags_from_path: bool = False,
                 namespace_from_top_folder: bool = False,
                 collection_from_top_folder: bool = False,
                 doc_type_from_folder: bool = False,
                 default_namespace: str = "",
                 collection: str = "") -> list:
    """Read, chunk, and build Pinecone records for a single file.

    Doc-type precedence (first match wins):
      1. doc_type_override (explicit --doc-type flag)
      2. doc_type_from_folder match against DOC_TYPE_FOLDER_MAP, if enabled
      3. file-extension default (.pdf -> book, .md -> markdown, .txt/.rst -> notes)
    """
    suffix = path.suffix.lower()

    fm_meta   = {}
    source    = str(path).replace("\\", "/")
    timestamp = int(path.stat().st_mtime)

    # Compute folder-derived doc_type once if enabled.
    folder_doc_type = None
    if doc_type_from_folder and root_folder is not None:
        folder_doc_type = infer_doc_type_from_path(path, root_folder)

    if suffix == ".pdf":
        text     = read_pdf(path)
        chunks   = chunk_plain(text)
        doc_type = doc_type_override or folder_doc_type or "book"
    elif suffix == ".md":
        raw      = path.read_text(encoding="utf-8", errors="ignore")
        fm_meta, body = parse_frontmatter(raw)
        chunks   = chunk_markdown(body)
        doc_type = doc_type_override or folder_doc_type or "markdown"
        # Use frontmatter createdAt as timestamp if present
        created  = fm_meta.get("createdAt", "")
        if created:
            try:
                from email.utils import parsedate_to_datetime
                timestamp = int(parsedate_to_datetime(created).timestamp())
            except Exception:
                pass  # keep file mtime
    elif suffix in (".txt", ".rst"):
        text     = path.read_text(encoding="utf-8", errors="ignore")
        chunks   = chunk_plain(text)
        doc_type = doc_type_override or folder_doc_type or "notes"
    else:
        return []

    if not chunks:
        return []

    # Title: frontmatter > filename
    fm_title  = str(fm_meta.get("title", "")).strip()
    title     = fm_title or path.stem.replace("-", " ").replace("_", " ").title()

    # Path-derived metadata (used for auto-tags + auto-namespace).
    top_folder, intermediate_slugs = (None, [])
    if root_folder is not None:
        top_folder, intermediate_slugs = path_derived_metadata(path, root_folder)

    # Tags: merge frontmatter + CLI + (optionally) folder slugs, deduplicated.
    fm_tags = fm_meta.get("tags", [])
    path_tags = intermediate_slugs if auto_tags_from_path else []
    all_tags = list(dict.fromkeys(fm_tags + tags + path_tags))

    # Resolve target namespace per record. Falls back to default_namespace
    # (the --namespace flag) when there is no top folder for this file.
    target_ns = top_folder if (namespace_from_top_folder and top_folder) else default_namespace

    # Resolve collection: explicit --collection wins; otherwise derive from top folder.
    target_collection = collection or (top_folder if (collection_from_top_folder and top_folder) else "")

    # Drop too-short chunks before assigning indices so chunk_index/chunk_count
    # describe what is actually emitted, not what was considered.
    kept = [(s, t) for (s, t) in chunks if len(t.split()) >= MIN_CHUNK_WORDS]
    total = len(kept)

    records = []
    for i, (section, chunk_text) in enumerate(kept):
        # Content-based hash ID: identical text across any files dedupes on upsert.
        # sanitize_text() is a safety net in case a non-PDF path produces surrogates.
        chunk_text = sanitize_text(chunk_text)
        uid = hashlib.sha1(chunk_text.encode("utf-8")).hexdigest()[:24]
        record = {
            "_id":         uid,
            "text":        chunk_text,
            "source":      source,
            "title":       title,
            "doc_type":    doc_type,
            "section":     section,
            "chunk_index": i,
            "chunk_count": total,
            "timestamp":   timestamp,
            # Internal field — stripped before upsert. Tells the upload loop
            # which namespace this record should land in.
            "_namespace":  target_ns,
        }
        if all_tags:
            record["tags"] = ",".join(all_tags)
        if target_collection:
            record["collection"] = target_collection
        records.append(record)

    return records


# ── Pinecone API helpers ──────────────────────────────────────────────────────

def resolve_index_host(index_input: str) -> str:
    """
    If index_input looks like a full host, returns it.
    Otherwise fetches the host from the Pinecone API based on the index name.
    """
    # Quick heuristic: if it looks like a domain, use it directly
    if "." in index_input:
        if "://" in index_input:
            index_input = index_input.split("://")[-1]
        return index_input.strip("/")
        
    url = "https://api.pinecone.io/indexes"
    headers = {
        "Api-Key": PINECONE_API_KEY,
        "X-Pinecone-Api-Version": "2024-07"
    }
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        if not resp.ok:
            sys.exit(f"Error fetching indexes from API: HTTP {resp.status_code} {resp.text}")
        
        indexes = resp.json().get("indexes", [])
        for idx in indexes:
            if idx.get("name") == index_input:
                return idx.get("host")
                
        sys.exit(f"Error: Index '{index_input}' not found in your Pinecone project.")
    except Exception as e:
        sys.exit(f"Error resolving index host: {e}")


def get_index_dimension(index_input: str) -> int:
    """Look up dimension for an index name. Returns 1024 if it can't be resolved
    (multilingual-e5-large default, the typical integrated-embedding case)."""
    if "." in index_input:
        return 1024  # host given directly, can't introspect cheaply
    try:
        resp = requests.get(
            "https://api.pinecone.io/indexes",
            headers={"Api-Key": PINECONE_API_KEY, "X-Pinecone-Api-Version": "2024-07"},
            timeout=15,
        )
        if resp.ok:
            for idx in resp.json().get("indexes", []):
                if idx.get("name") == index_input:
                    return int(idx.get("dimension", 1024))
    except Exception:
        pass
    return 1024


def resolve_index_info(index_input: str) -> tuple:
    """Return (host, dimension) for an index name in a single API call.

    Using this instead of calling resolve_index_host() and get_index_dimension()
    separately avoids a second round-trip to the Pinecone API (each has a 15-second
    timeout, so doing them back-to-back can cause up to 30 s of silent startup).
    """
    if "." in index_input:
        # Looks like a direct host URL — return as-is, dimension unknown.
        if "://" in index_input:
            index_input = index_input.split("://")[-1]
        return index_input.strip("/"), 1024

    url = "https://api.pinecone.io/indexes"
    headers = {
        "Api-Key":                PINECONE_API_KEY,
        "X-Pinecone-Api-Version": "2024-07",
    }
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        if not resp.ok:
            sys.exit(
                f"Error fetching indexes from API: HTTP {resp.status_code} {resp.text}"
            )
        for idx in resp.json().get("indexes", []):
            if idx.get("name") == index_input:
                host = idx.get("host", "")
                dim  = int(idx.get("dimension", 1024))
                return host, dim
        sys.exit(
            f"Error: Index '{index_input}' not found in your Pinecone project."
        )
    except SystemExit:
        raise
    except Exception as e:
        sys.exit(f"Error resolving index: {e}")


def query_ids_by_filter(index_host: str, namespace: str, filter_json: dict,
                        dimension: int, top_k: int = 10000) -> list:
    """Return record IDs in a namespace matching a metadata filter.
    Used by --prune-by-source to find existing records to delete before re-upload.
    """
    url = f"https://{index_host}/query"
    body = {
        "vector":          [0.0] * dimension,
        "top_k":           min(top_k, 10000),
        "filter":          filter_json,
        "includeMetadata": False,
    }
    if namespace:
        body["namespace"] = namespace
    headers = {
        "Api-Key":                 PINECONE_API_KEY,
        "Content-Type":            "application/json",
        "X-Pinecone-API-Version":  "2025-04",
    }
    try:
        resp = requests.post(url, headers=headers, json=body, timeout=30)
        if not resp.ok:
            print(f"  [prune-warn] could not list records for filter {filter_json}: HTTP {resp.status_code}")
            return []
        return [m.get("id") for m in resp.json().get("matches", []) if m.get("id")]
    except Exception as e:
        print(f"  [prune-warn] query failed: {e}")
        return []


def delete_ids(index_host: str, namespace: str, ids: list) -> bool:
    """Delete records by ID. Pinecone caps a single delete at 1000 IDs."""
    if not ids:
        return True
    url = f"https://{index_host}/vectors/delete"
    headers = {
        "Api-Key":                 PINECONE_API_KEY,
        "Content-Type":            "application/json",
        "X-Pinecone-API-Version":  "2025-04",
    }
    ok = True
    for i in range(0, len(ids), 1000):
        batch = ids[i:i + 1000]
        body = {"ids": batch}
        if namespace:
            body["namespace"] = namespace
        try:
            resp = requests.post(url, headers=headers, json=body, timeout=30)
            if not resp.ok:
                print(f"  [prune-error] delete failed: HTTP {resp.status_code} — {resp.text[:200]}")
                ok = False
        except Exception as e:
            print(f"  [prune-error] delete request failed: {e}")
            ok = False
    return ok


def fetch_existing_ids(index_host: str, namespace: str, ids: list,
                       batch_size: int = FETCH_EXISTING_BATCH_SIZE) -> set:
    """Return the subset of `ids` that already exist in the index/namespace.
    Used to skip re-embedding chunks we've already uploaded (saves money + time).
    Pinecone's /vectors/fetch caps at ~1000 IDs per call, so we batch.
    """
    if not ids:
        return set()
    headers = {
        "Api-Key":                PINECONE_API_KEY,
        "X-Pinecone-API-Version": "2025-04",
    }
    base_url = f"https://{index_host}/vectors/fetch"
    found: set = set()
    batch_size = max(1, min(int(batch_size), 1000))
    for i in range(0, len(ids), batch_size):
        chunk = ids[i:i + batch_size]
        params = [("ids", _id) for _id in chunk]
        if namespace:
            params.append(("namespace", namespace))
        try:
            resp = requests.get(base_url, headers=headers, params=params, timeout=30)
            if not resp.ok:
                # Don't fail the whole upload over an existence check — just warn
                # and treat all IDs in this batch as "unknown" (will be upserted).
                print(f"  [skip-check-warn] HTTP {resp.status_code}: {resp.text[:160]}")
                continue
            data = resp.json()
            vectors = data.get("vectors") or {}
            found.update(vectors.keys())
        except Exception as e:
            print(f"  [skip-check-warn] {e}")
            continue
    return found


def record_payload_size(record: dict) -> int:
    """Return the UTF-8 JSON size for one vector entry."""
    return len(json.dumps(record).encode("utf-8"))


def vector_upsert_batches(vectors: list, max_payload_bytes: int = MAX_VECTOR_PAYLOAD_BYTES) -> list:
    """Split vector entries into batches that fit under a JSON payload limit."""
    batches = []
    current = []

    for vector in vectors:
        single_size = record_payload_size(vector)
        if single_size > max_payload_bytes:
            print(f"  [warn] vector '{vector.get('id')}' exceeds payload limit "
                  f"({single_size} bytes > {max_payload_bytes}); skipping.")
            continue
        candidate = current + [vector]
        candidate_size = len(json.dumps({"vectors": candidate}).encode("utf-8"))
        if current and candidate_size > max_payload_bytes:
            batches.append(current)
            current = [vector]
        else:
            current = candidate

    if current:
        batches.append(current)
    return batches


def prune_existing_sources(index_host: str, namespace: str, sources: list,
                           dimension: int) -> dict:
    """For each source path, find existing records and delete them.
    Returns a summary dict so the caller can report what was pruned."""
    summary = {"sources": len(sources), "records_deleted": 0, "errors": 0}
    for src in sources:
        ids = query_ids_by_filter(
            index_host, namespace,
            filter_json={"source": {"$eq": src}},
            dimension=dimension,
        )
        if not ids:
            continue
        if delete_ids(index_host, namespace, ids):
            summary["records_deleted"] += len(ids)
            print(f"  [prune] {src}  ->  deleted {len(ids)} stale records")
        else:
            summary["errors"] += 1
    return summary


# ── Pinecone upsert ───────────────────────────────────────────────────────────

def _upload_embedded_batch(payload_body: str, index_host: str) -> dict:
    """POST a pre-serialised JSON payload to /vectors/upsert with retry.
    Separated so the producer/consumer pipeline can call it from a thread."""
    url = f"https://{index_host}/vectors/upsert"
    headers = {
        "Api-Key":                 PINECONE_API_KEY,
        "Content-Type":            "application/json",
        "X-Pinecone-API-Version":  "2025-04",
    }
    result = {"success": False, "retries": 0, "retry_reasons": [], "delay_applied": 0.0}
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = requests.post(url, headers=headers, data=payload_body, timeout=60)
            if resp.ok:
                result["success"] = True
                return result
            if resp.status_code >= 500 or resp.status_code == 429:
                if attempt < MAX_RETRIES:
                    delay = exponential_backoff(attempt)
                    reason = f"HTTP {resp.status_code}"
                    result["retry_reasons"].append(reason)
                    result["retries"] += 1
                    result["delay_applied"] += delay
                    print(f"    [retry {attempt + 1}/{MAX_RETRIES}] {reason}, waiting {delay:.2f}s...")
                    time.sleep(delay)
                    continue
                result["retry_reasons"].append(f"HTTP {resp.status_code} (max retries exhausted)")
                print(f"  [error] HTTP {resp.status_code}: {resp.text[:600]}")
                return result
            # Detect dimension mismatch — extract the correct dim from the message
            # so the caller can swap models and retry without guessing.
            if resp.status_code == 400 and "dimension of the index" in resp.text:
                import re as _re
                m = _re.search(r"dimension of the index (\d+)", resp.text)
                if m:
                    result["dim_mismatch"] = int(m.group(1))
                    return result  # not retryable — wrong model, not a transient error
            print(f"  [error] HTTP {resp.status_code}: {resp.text[:600]}")
            return result
        except requests.RequestException as e:
            if attempt < MAX_RETRIES:
                delay = exponential_backoff(attempt)
                result["retry_reasons"].append(str(e)[:50])
                result["retries"] += 1
                result["delay_applied"] += delay
                print(f"    [retry {attempt + 1}/{MAX_RETRIES}] {str(e)[:50]}, waiting {delay:.2f}s...")
                time.sleep(delay)
                continue
            result["retry_reasons"].append(f"Exception: {str(e)[:50]}")
            print(f"  [error] {e}")
            return result
    return result


def upsert_batch_local(records: list, index_host: str, namespace: str) -> dict:
    """
    Embed + upload a batch of records using the local sentence-transformers model.

    Pipeline: embedding runs on the main thread; the HTTP upload is dispatched
    to a background thread via a queue so the *next* encode can start while the
    *current* upload is in flight. This overlaps GPU/CPU compute with network
    I/O and gives a meaningful throughput boost on large batches.

    Vectors are fully compatible with Pinecone's integrated-embed query path
    because we use the same underlying model (multilingual-e5-large) and the
    required 'passage: ' prefix.
    """
    import queue
    import threading as _threading

    if not records:
        return {"success": True, "records_count": 0, "retries": 0,
                "retry_reasons": [], "delay_applied": 0.0}

    result = {
        "success": False,
        "records_count": len(records),
        "retries": 0,
        "retry_reasons": [],
        "delay_applied": 0.0,
    }

    # Determine per-device sub-batch size for the encoder.
    embed_sub = _device_embed_batch(_LOCAL_DEVICE or _pick_device())
    # We process the caller's batch in encoder-sized sub-batches so that
    # embedding and uploading can overlap.
    upload_queue: queue.Queue = queue.Queue(maxsize=2)
    upload_errors: list = []
    queued_payloads = 0

    def uploader():
        """Drain upload_queue and POST each payload. Runs in a daemon thread."""
        while True:
            item = upload_queue.get()
            try:
                if item is None:      # sentinel — encoder is done
                    break
                payload_body, sub_count = item
                up = _upload_embedded_batch(payload_body, index_host)
                result["retries"] += up.get("retries", 0)
                result["retry_reasons"].extend(up.get("retry_reasons", []))
                result["delay_applied"] += up.get("delay_applied", 0.0)
                if not up["success"]:
                    upload_errors.append(f"{sub_count} vector(s) failed to upload")
                    if up.get("dim_mismatch"):
                        # Signal encoder loop to stop; caller will swap model and retry.
                        upload_errors.append(f"dim_mismatch:{up['dim_mismatch']}")
            except Exception as exc:
                upload_errors.append(f"uploader exception: {exc}")
            finally:
                upload_queue.task_done()

    upload_thread = _threading.Thread(target=uploader, daemon=True)
    upload_thread.start()

    def enqueue_upload(payload_body: str, vector_count: int) -> bool:
        while upload_thread.is_alive():
            try:
                upload_queue.put((payload_body, vector_count),
                                 timeout=UPLOAD_QUEUE_PUT_TIMEOUT)
                return True
            except queue.Full:
                continue
        upload_errors.append("uploader thread stopped before accepting payload")
        return False

    # Encode sub-batches and hand them to the uploader immediately.
    total_sub = max(1, (len(records) + embed_sub - 1) // embed_sub)
    for i in range(0, len(records), embed_sub):
        if upload_errors:
            break
        sub = records[i:i + embed_sub]
        sub_num = i // embed_sub + 1
        print(f"  [embed] sub-batch {sub_num}/{total_sub}: "
              f"encoding {len(sub)} record(s) on {_LOCAL_DEVICE or 'cpu'}...")
        sys.stdout.flush()
        texts = [r["text"] for r in sub]
        vectors = local_embed_passages(texts)

        vector_entries = [
            {
                "id":       r["_id"],
                "values":   vec,
                "metadata": {k: v for k, v in r.items()
                             if not k.startswith("_")},
            }
            for r, vec in zip(sub, vectors)
        ]

        for vector_batch in vector_upsert_batches(
            vector_entries,
            max_payload_bytes=MAX_VECTOR_PAYLOAD_BYTES - 256,
        ):
            payload = {"vectors": vector_batch}
            if namespace:
                payload["namespace"] = namespace
            if not enqueue_upload(json.dumps(payload), len(vector_batch)):
                break
            queued_payloads += 1

    # Deliver the sentinel to tell the uploader to stop.
    # Must retry in a loop: if the uploader is mid-retry on a slow network
    # call (up to per_payload_timeout seconds), the queue stays full and a
    # single 30 s put attempt would fail, leaving the uploader blocked
    # forever on queue.get() after it drains the real payloads.
    while upload_thread.is_alive():
        try:
            upload_queue.put(None, timeout=5)
            break   # sentinel delivered
        except queue.Full:
            continue

    # The queue holds at most maxsize=2 payloads when the encoding loop
    # finishes.  Each payload takes at most per_payload_timeout seconds to
    # upload (including all retries + backoff).  Cap the join here; do not
    # scale by queued_payloads which can be very large for big batches.
    per_payload_timeout = (MAX_RETRIES + 1) * 60 + MAX_BACKOFF
    join_timeout = max(120, 2 * per_payload_timeout + 60)
    upload_thread.join(timeout=join_timeout)
    if upload_thread.is_alive():
        upload_errors.append(
            f"uploader thread did not finish within {join_timeout}s timeout"
        )

    if upload_errors:
        result["success"] = False
        result["retry_reasons"].extend(str(e) for e in upload_errors)
        for e in upload_errors:
            if isinstance(e, str) and e.startswith("dim_mismatch:"):
                result["dim_mismatch"] = int(e.split(":")[1])
                break
    else:
        result["success"] = True
    return result


def upsert_batch(records: list, index_host: str, namespace: str) -> dict:
    """
    POST records to the index using integrated embedding with retry logic.
    Pinecone embeds the 'text' field automatically (multilingual-e5-large).
    
    Returns dict with keys:
      - success: bool (True if all records uploaded)
      - records_count: int (number of records in batch)
      - retries: int (number of retries needed)
      - retry_reasons: list (reasons for each retry)
      - delay_applied: float (total delay applied between retries)
    """
    if namespace:
        from urllib.parse import quote
        url = f"https://{index_host}/records/namespaces/{quote(namespace)}/upsert"
    else:
        url = f"https://{index_host}/records/upsert"
        
    headers = {
        "Api-Key":                 PINECONE_API_KEY,
        "Content-Type":            "application/x-ndjson",
        "X-Pinecone-API-Version":  "2025-04",
    }
    
    ndjson_data = "\n".join(json.dumps(r) for r in records)
    
    result = {
        "success": False,
        "records_count": len(records),
        "retries": 0,
        "retry_reasons": [],
        "delay_applied": 0.0,
        "quota_exhausted": False,
        "inference_not_configured": False,
    }

    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = requests.post(url, headers=headers, data=ndjson_data, timeout=60)

            if resp.ok:
                result["success"] = True
                return result

            # Detect monthly embedding quota exhaustion — not retryable, signal caller.
            if resp.status_code == 429:
                body_lower = resp.text.lower()
                if "resource_exhausted" in body_lower or "embedding token limit" in body_lower:
                    result["quota_exhausted"] = True
                    result["retry_reasons"].append("quota_exhausted")
                    return result

            # Detect index without integrated inference — not retryable, signal caller.
            if resp.status_code == 400:
                if "integrated inference is not configured" in resp.text.lower():
                    result["inference_not_configured"] = True
                    result["retry_reasons"].append("inference_not_configured")
                    return result

            # Handle rate limiting (429) and server errors (5xx)
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt < MAX_RETRIES:
                    # Determine retry delay
                    server_delay = get_retry_delay(resp)
                    delay = server_delay if server_delay is not None and server_delay >= 0 else exponential_backoff(attempt)

                    reason = f"HTTP {resp.status_code}"
                    if server_delay is not None and server_delay >= 0:
                        reason += f" (server Retry-After: {server_delay:.1f}s)"
                    
                    result["retry_reasons"].append(reason)
                    result["retries"] += 1
                    result["delay_applied"] += delay
                    
                    print(f"    [retry {attempt + 1}/{MAX_RETRIES}] {reason}, waiting {delay:.2f}s...")
                    time.sleep(delay)
                    continue
                else:
                    reason = f"HTTP {resp.status_code} (max retries exhausted)"
                    result["retry_reasons"].append(reason)
                    print(f"  [error] {reason}: {resp.text[:600]}")
                    return result
            
            # Non-retryable error (4xx other than 429)
            print(f"  [error] HTTP {resp.status_code}: {resp.text[:300]}")
            return result
            
        except requests.Timeout:
            if attempt < MAX_RETRIES:
                reason = "Timeout"
                result["retry_reasons"].append(reason)
                result["retries"] += 1
                delay = exponential_backoff(attempt)
                result["delay_applied"] += delay
                print(f"    [retry {attempt + 1}/{MAX_RETRIES}] {reason}, waiting {delay:.2f}s...")
                time.sleep(delay)
                continue
            else:
                result["retry_reasons"].append("Timeout (max retries exhausted)")
                print(f"  [error] Request timeout after {MAX_RETRIES} retries")
                return result
                
        except requests.RequestException as e:
            if attempt < MAX_RETRIES:
                reason = str(e)[:50]
                result["retry_reasons"].append(reason)
                result["retries"] += 1
                delay = exponential_backoff(attempt)
                result["delay_applied"] += delay
                print(f"    [retry {attempt + 1}/{MAX_RETRIES}] {reason}, waiting {delay:.2f}s...")
                time.sleep(delay)
                continue
            else:
                result["retry_reasons"].append(f"Exception (max retries exhausted): {str(e)[:50]}")
                print(f"  [error] {e}")
                return result
    
    return result


# ── Source listing ────────────────────────────────────────────────────────────

def list_uploaded_sources(index_host: str, namespace: str = "", limit: int = 50) -> None:
    """Page through the index, collect unique sources, and print sorted by timestamp."""
    from datetime import datetime as _dt

    headers = {
        "Api-Key": PINECONE_API_KEY,
        "X-Pinecone-API-Version": "2025-04",
    }
    ns_label = namespace or "(default)"
    print(f"Scanning index for uploaded sources  [namespace: {ns_label}] …")

    # Step 1: list all vector IDs via the pagination endpoint.
    all_ids: list = []
    list_url = f"https://{index_host}/vectors/list"
    pagination_token = None

    while True:
        params: dict = {"limit": 100}
        if namespace:
            params["namespace"] = namespace
        if pagination_token:
            params["paginationToken"] = pagination_token
        try:
            resp = requests.get(list_url, headers=headers, params=params, timeout=30)
        except requests.RequestException as e:
            print(f"[error] List request failed: {e}")
            return
        if not resp.ok:
            print(f"[error] HTTP {resp.status_code}: {resp.text[:200]}")
            return
        data = resp.json()
        all_ids.extend(v["id"] for v in data.get("vectors", []))
        pagination_token = (data.get("pagination") or {}).get("next")
        if not pagination_token:
            break
        if len(all_ids) % 1000 == 0:
            print(f"  … {len(all_ids):,} IDs so far")

    if not all_ids:
        print("No vectors found.")
        return
    print(f"  {len(all_ids):,} vectors found. Fetching metadata …")

    # Step 2: fetch metadata in batches of 200.
    sources: dict = {}   # source_path → {title, collection, timestamp}
    fetch_url = f"https://{index_host}/vectors/fetch"

    for i in range(0, len(all_ids), 200):
        batch = all_ids[i:i + 200]
        params_list = [("ids", id_) for id_ in batch]
        if namespace:
            params_list.append(("namespace", namespace))
        try:
            resp = requests.get(fetch_url, headers=headers, params=params_list, timeout=30)
        except requests.RequestException:
            continue
        if not resp.ok:
            continue
        for vdata in resp.json().get("vectors", {}).values():
            meta = vdata.get("metadata", {})
            source = meta.get("source", "")
            if not source:
                continue
            ts = int(meta.get("timestamp") or 0)
            if source not in sources or ts > sources[source]["timestamp"]:
                sources[source] = {
                    "title":      meta.get("title") or Path(source).stem,
                    "collection": meta.get("collection", ""),
                    "timestamp":  ts,
                }

    if not sources:
        print("No source metadata found (vectors may lack metadata fields).")
        return

    sorted_sources = sorted(sources.values(), key=lambda x: x["timestamp"], reverse=True)
    shown = sorted_sources[:limit]

    print(f"\nLast {len(shown)} of {len(sources)} uploaded sources (most recent first):\n")
    for s in shown:
        date = (_dt.fromtimestamp(s["timestamp"]).strftime("%Y-%m-%d")
                if s["timestamp"] else "unknown   ")
        coll = f"  [{s['collection']}]" if s["collection"] else ""
        title = (s["title"] or "untitled")[:50]
        print(f"  {date}  {title:<52}{coll}")

    if len(sources) > limit:
        print(f"\n  … and {len(sources) - limit} more. Pass --limit N to see more.")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # On Windows, stdout defaults to cp1252 which crashes on smart quotes,
    # arrows, accented filenames, etc. Force UTF-8 so user content can't
    # take the script down mid-run.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        description="Bulk upload documents into the Pinecone 'peace' index."
    )
    parser.add_argument(
        "paths", nargs="*",
        help="One or more folders and/or individual files to upload. "
             "Folders are scanned (recursively unless --no-recursive); files "
             "are uploaded directly. Not required when --list-sources is used."
    )
    parser.add_argument(
        "--list-sources", action="store_true",
        help="List unique sources already uploaded to the index, sorted by most recent first."
    )
    parser.add_argument(
        "--limit", type=int, default=50,
        help="Number of sources to show with --list-sources (default: 50)."
    )
    parser.add_argument(
        "--summarize-namespace", action="store_true",
        help="Print a local topic-model summary (top terms, excerpts, chunk/source "
             "counts per topic) for --namespace instead of uploading. Free and cached "
             "(scikit-learn required: pip install scikit-learn)."
    )
    parser.add_argument(
        "--n-topics", type=int, default=8,
        help="Number of topics to extract with --summarize-namespace (default: 8)."
    )
    parser.add_argument(
        "--refresh-summary", action="store_true",
        help="Force --summarize-namespace to recompute even if a fresh cache exists."
    )
    parser.add_argument(
        "--doc-type", choices=["book", "kb", "notes", "markdown"],
        default=None, help="Override auto-detected document type"
    )
    parser.add_argument(
        "--tags", default="",
        help="Comma-separated tags applied to every record (e.g. 'philosophy,stoicism')"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Preview chunks and first record without uploading"
    )
    parser.add_argument(
        "--no-recursive", action="store_true",
        help="Only scan the top-level folder, not subfolders"
    )
    parser.add_argument(
        "--index-name", "--index-host", dest="index_name", required=True,
        help="Pinecone Index name or host URL (auto-resolves host if name is provided). --index-host is accepted as an alias."
    )
    parser.add_argument(
        "--namespace", default="",
        help="Pinecone Namespace to upsert into (creates if it doesn't exist)"
    )
    parser.add_argument(
        "--max-rps", type=float, default=None,
        help="Optional: max requests per second (proactive throttling, default: no limit)"
    )
    parser.add_argument(
        "--prune-by-source", action="store_true",
        help="Before uploading, delete existing records whose 'source' metadata matches "
             "any file in this run. Use this when re-uploading edited files so stale "
             "chunks don't accumulate. Implies one extra query+delete per source file."
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Re-upload (re-embed) every chunk even if its ID already exists in the "
             "index. Default behaviour skips already-present chunks to avoid paying "
             "embedding costs twice for unchanged content."
    )
    parser.add_argument(
        "--collection", default="",
        help="Stamp every record with this 'collection' metadata value. Use this "
             "to label a whole upload batch (e.g. 'recall-04-05') so it can be "
             "listed/filtered/deleted as a unit later."
    )
    parser.add_argument(
        "--auto-tags-from-path", action="store_true",
        help="Derive tags from the folder structure of each file (slugified). "
             "E.g. Health/Fitness/foo.md gets tags 'health, fitness' added."
    )
    parser.add_argument(
        "--namespace-from-top-folder", action="store_true",
        help="Use the first subfolder name as the target namespace for each file "
             "(slugified). Files at the root of the upload folder fall back to --namespace."
    )
    parser.add_argument(
        "--collection-from-top-folder", action="store_true",
        help="Automatically set the 'collection' metadata field to the top-level "
             "subfolder name for each file. Useful for tagging chunks by book/topic "
             "so they can be filtered by collection at query time. "
             "Explicit --collection overrides this per run."
    )
    parser.add_argument(
        "--doc-type-from-folder", action="store_true",
        help="If any folder in a file's path matches a known doc_type "
             "(books, papers, transcripts, podcasts, videos, articles, notes, "
             "summaries, kb), use that as the record's doc_type. The explicit "
             "--doc-type flag still wins over this; this only overrides the "
             "extension-based default."
    )
    parser.add_argument(
        "--client-embed", action="store_true",
        help="Deprecated no-op: local embedding is now the default, this flag "
             "is accepted for backward compatibility and does nothing. Use "
             "--paid-embed to opt back into Pinecone's integrated embedding."
    )
    parser.add_argument(
        "--paid-embed", action="store_true",
        help="Use Pinecone's integrated embedding (multilingual-e5-large) and "
             "consume embedding tokens against the shared monthly quota, "
             "instead of the default free local embedding. Automatically "
             "falls back to local embedding if quota is exhausted or the "
             "index has no integrated inference configured."
    )
    args = parser.parse_args()

    if args.client_embed and not args.paid_embed:
        print("[note] --client-embed is deprecated and has no effect — "
              "local embedding is now the default. Pass --paid-embed if you "
              "want Pinecone's integrated (token-billed) embedding instead.")

    if not args.dry_run and not PINECONE_API_KEY:
        sys.exit("Error: PINECONE_API_KEY environment variable is not set.")

    # Resolve host + dimension in a single API call.  Dry runs skip the network.
    if args.dry_run:
        index_host, index_dim = "(dry-run)", 1024
    else:
        index_host, index_dim = resolve_index_info(args.index_name)

    # --list-sources: report uploaded assets and exit — no upload needed.
    if args.list_sources:
        if args.dry_run:
            sys.exit("Error: --list-sources cannot be combined with --dry-run (needs a real index connection).")
        list_uploaded_sources(index_host, namespace=args.namespace, limit=args.limit)
        return

    # --summarize-namespace: local topic-model summary and exit — no upload needed.
    if args.summarize_namespace:
        if args.dry_run:
            sys.exit("Error: --summarize-namespace cannot be combined with --dry-run (needs a real index connection).")
        import pinecone_insights
        summary = pinecone_insights.summarize_namespace(
            args.index_name, namespace=args.namespace,
            n_topics=args.n_topics, refresh=args.refresh_summary,
        )
        cache_note = " (from cache)" if summary.get("cached") else ""
        print(f"\nTopics for namespace '{args.namespace or '(default)'}'{cache_note}:")
        print(f"  {summary['records_scanned']} chunk(s) scanned"
              f"{' (truncated — raise --limit or scope with a filter)' if summary.get('truncated') else ''}, "
              f"{summary['total_vector_count']} total in namespace.\n")
        for t in summary["topics"]:
            print(f"  [{t['chunk_count']} chunks, {t['source_count']} source(s)] "
                  f"{', '.join(t['top_terms'])}")
            for excerpt in t["excerpts"]:
                print(f"      - {excerpt}")
        return

    # ── Auto-select the local model to match the index dimension ──────────────
    # Pinecone rejects vectors whose dimension doesn't match the index.
    # The dimension was fetched above at no extra cost (same API call).
    # Local embedding is the default (no flag needed); --paid-embed opts out.
    if not args.paid_embed and not args.dry_run:
        global LOCAL_MODEL_ID, _LOCAL_MODEL
        chosen_model = DIM_TO_LOCAL_MODEL.get(index_dim)
        if chosen_model is None:
            sys.exit(
                f"Error: index '{args.index_name}' is {index_dim}-dim but no "
                f"matching intfloat/e5 model is available for local embedding.\n"
                f"Supported dimensions: {sorted(DIM_TO_LOCAL_MODEL.keys())}.\n"
                f"Either pass --paid-embed to use Pinecone integrated embedding "
                f"or recreate the index with a supported dimension."
            )
        if chosen_model != LOCAL_MODEL_ID:
            LOCAL_MODEL_ID = chosen_model
            _LOCAL_MODEL = None   # force reload if model was already cached

    tags      = [t.strip() for t in args.tags.split(",") if t.strip()]
    supported = {".md", ".txt", ".rst", ".pdf"}

    if not args.paths:
        sys.exit("Error: at least one path is required unless --list-sources is used.")

    # Discover files via the helper — handles deduplication and path validation.
    targets = iter_supported_files(args.paths, recursive=not args.no_recursive,
                                   supported=supported)
    folders_scanned, files_added_directly = input_path_summary(args.paths, supported)

    if not targets:
        sys.exit("No supported files found in the provided paths.")

    print(f"\nIndex : {args.index_name} ({index_host})")
    if not args.paid_embed:
        _dev = _LOCAL_DEVICE or "cpu"
        _embed_str = (f"LOCAL  {LOCAL_MODEL_ID}  "
                      f"(free — {_dev.upper()}, batch {_device_embed_batch(_dev)})")
    else:
        _embed_str = "Pinecone integrated (consumes embedding tokens)"
    print(f"Embed : {_embed_str}")
    if args.namespace_from_top_folder:
        print(f"Namespace strategy : per-record from top subfolder (fallback: '{args.namespace}')")
    else:
        print(f"Namespace : '{args.namespace}'")
    if args.collection_from_top_folder:
        print(f"Collection strategy: per-record from top subfolder (overridden by --collection if set)")
    if args.collection:
        print(f"Collection : '{args.collection}'")
    if args.auto_tags_from_path:
        print("Auto-tags : enabled (folder names -> tags)")
    if args.doc_type_from_folder:
        print("Auto doc_type : enabled (folder name -> doc_type via DOC_TYPE_FOLDER_MAP)")
    if folders_scanned:
        print(f"Folders : {len(folders_scanned)} ({', '.join(str(f) for f in folders_scanned)})")
    if files_added_directly:
        print(f"Files (direct) : {len(files_added_directly)}")
    print(f"Total files : {len(targets)} found\n")

    # ── Shared state for the streaming process-and-flush loop ────────────────
    # Records accumulate per namespace; when a bucket reaches STREAM_FLUSH_RECORDS
    # it is uploaded immediately so the process never holds one giant list in RAM.
    buckets: dict = defaultdict(list)          # ns -> pending records
    pruned_sources: dict = defaultdict(set)    # ns -> source paths already pruned this run
    errored_files: list = []
    total_chunks = 0
    grand_uploaded = 0
    grand_failed = 0
    grand_skipped = 0
    grand_pruned  = 0
    grand_start   = time.time()
    use_local_embed = not args.paid_embed
    # index_dim was resolved at startup (same API call as the host); no need to
    # re-fetch it when _flush_bucket needs it for --prune-by-source.

    def _get_dim():
        return index_dim

    def _flush_bucket(ns: str, flush_records: list) -> None:
        """Upload one slice of a namespace bucket.
        Called when the bucket hits STREAM_FLUSH_RECORDS or at end-of-run."""
        nonlocal grand_uploaded, grand_failed, grand_skipped, grand_pruned, use_local_embed
        global LOCAL_MODEL_ID, _LOCAL_MODEL
        if not flush_records:
            return
        ns_label = ns or "(default)"
        print(f"\n=== Namespace '{ns_label}' — uploading {len(flush_records)} record(s) ===")

        # Prune stale records for any source we haven't yet pruned this run.
        if args.prune_by_source:
            new_sources = sorted(
                {r["source"] for r in flush_records if r.get("source")}
                - pruned_sources[ns]
            )
            if new_sources:
                print(f"  Pruning stale records for {len(new_sources)} source(s)...")
                ps = prune_existing_sources(index_host, ns, new_sources, _get_dim())
                if ps["records_deleted"]:
                    print(f"  Pruned {ps['records_deleted']} record(s) "
                          f"({ps['errors']} error(s)).")
                    grand_pruned += ps["records_deleted"]
                pruned_sources[ns].update(new_sources)

        # Skip already-uploaded chunks (unless --force or --prune-by-source).
        if not args.force and not args.prune_by_source:
            ids = [r["_id"] for r in flush_records]
            print(f"  Checking which of {len(ids)} chunks already exist...")
            existing = fetch_existing_ids(index_host, ns, ids)
            if existing:
                before = len(flush_records)
                flush_records = [r for r in flush_records if r["_id"] not in existing]
                skipped = before - len(flush_records)
                grand_skipped += skipped
                print(f"  Skipping {skipped} already present, "
                      f"uploading {len(flush_records)} new.")
            else:
                print("  No existing chunks found — uploading all.")

        if not flush_records:
            print("  Nothing new to upload in this namespace.")
            return

        ns_uploaded = 0
        ns_failed = 0
        total_batches = (len(flush_records) + BATCH_SIZE - 1) // BATCH_SIZE
        for i in range(0, len(flush_records), BATCH_SIZE):
            batch_start = time.time()
            batch = flush_records[i:i + BATCH_SIZE]
            batch_num = i // BATCH_SIZE + 1
            upsert_fn = upsert_batch_local if use_local_embed else upsert_batch
            result = upsert_fn(batch, index_host, ns)

            # Auto-fallback: Pinecone monthly embedding quota exhausted → switch to local.
            if result.get("quota_exhausted"):
                print("\n  [!] Pinecone integrated embedding quota exhausted for this month.")
                print("  [!] Switching to local sentence-transformers embedding (free, same model).\n")
                use_local_embed = True
                result = upsert_batch_local(batch, index_host, ns)

            # Auto-fallback: index has no integrated inference model → switch to local.
            elif result.get("inference_not_configured"):
                print("\n  [!] This index does not have integrated inference configured.")
                print("  [!] Switching to local sentence-transformers embedding automatically.\n")
                use_local_embed = True
                # Pick the model whose output dimension matches the index.
                # _get_dim() may return 1024 as a fallback when only a host URL was
                # given; the dim_mismatch path below self-corrects if that happens.
                dim = _get_dim()
                chosen = DIM_TO_LOCAL_MODEL.get(dim)
                if chosen and chosen != LOCAL_MODEL_ID:
                    print(f"  [!] Index is {dim}-dim — using {chosen} (was {LOCAL_MODEL_ID}).\n")
                    LOCAL_MODEL_ID = chosen
                    _LOCAL_MODEL = None  # force reload on next encode call
                result = upsert_batch_local(batch, index_host, ns)

            # Self-correcting dimension fix: the server told us the real dimension
            # via the 400 error message. Swap to the matching model and retry once.
            if result.get("dim_mismatch"):
                correct_dim = result["dim_mismatch"]
                chosen = DIM_TO_LOCAL_MODEL.get(correct_dim)
                if chosen:
                    if chosen != LOCAL_MODEL_ID:
                        print(f"\n  [!] Index requires {correct_dim}-dim vectors.")
                        print(f"  [!] Reloading {chosen} (was {LOCAL_MODEL_ID}) and retrying.\n")
                        LOCAL_MODEL_ID = chosen
                        _LOCAL_MODEL = None
                    use_local_embed = True
                    result = upsert_batch_local(batch, index_host, ns)
                else:
                    print(f"\n  [!] Index requires {correct_dim}-dim vectors but no matching "
                          f"local model is configured.\n")

            if result["success"]:
                ns_uploaded += len(batch)
                status_msg = f"  Batch {batch_num}/{total_batches}: {len(batch)} records OK"
                if result["retries"] > 0:
                    status_msg += f" ({result['retries']} retries)"
                print(status_msg)
            else:
                ns_failed += len(batch)
                print(f"  Batch {batch_num}/{total_batches}: FAILED")
                if result["retry_reasons"]:
                    print(f"    Retry chain: {' -> '.join(result['retry_reasons'])}")

            if args.max_rps and batch_num < total_batches:
                min_batch_delay = 1.0 / args.max_rps
                elapsed_b = time.time() - batch_start
                remaining_b = min_batch_delay - elapsed_b
                if remaining_b > 0:
                    time.sleep(remaining_b)
            else:
                time.sleep(0.01)

        grand_uploaded += ns_uploaded
        grand_failed += ns_failed
        print(f"  Namespace '{ns_label}': {ns_uploaded} uploaded, {ns_failed} failed.")

    # ── Process files one at a time ───────────────────────────────────────────
    for f, root in targets:
        try:
            records = process_file(
                f, args.doc_type, tags,
                root_folder=root,
                auto_tags_from_path=args.auto_tags_from_path,
                namespace_from_top_folder=args.namespace_from_top_folder,
                collection_from_top_folder=args.collection_from_top_folder,
                doc_type_from_folder=args.doc_type_from_folder,
                default_namespace=args.namespace,
                collection=args.collection,
            )
        except Exception as e:
            try:
                display = f.relative_to(root)
            except ValueError:
                display = f
            print(f"  {display}  ->  ERROR: {e}")
            errored_files.append((str(display), str(e)))
            continue
        status = f"{len(records)} chunks" if records else "skipped"
        try:
            display = f.relative_to(root)
        except ValueError:
            display = f
        print(f"  {display}  ->  {status}")
        total_chunks += len(records)

        # Route each record into its namespace bucket.
        for r in records:
            ns = r.pop("_namespace", args.namespace)
            buckets[ns].append(r)

        # Flush any bucket that has grown past the bounded threshold.
        # Skipped in dry-run so all records stay available for the preview.
        if not args.dry_run:
            for ns in list(buckets):
                if len(buckets[ns]) >= STREAM_FLUSH_RECORDS:
                    _flush_bucket(ns, list(buckets[ns]))
                    buckets[ns] = []

    print(f"\nTotal records scanned: {total_chunks}")

    # ── Dry-run preview ───────────────────────────────────────────────────────
    if args.dry_run:
        all_records_preview = [r for recs in buckets.values() for r in recs]
        print("\n[dry-run] Sample record (first chunk):")
        if all_records_preview:
            sample = dict(all_records_preview[0])
            sample["text"] = sample["text"][:200] + "..."
            print(json.dumps(sample, indent=2))
        if args.namespace_from_top_folder:
            ns_counts: dict = defaultdict(int)
            for ns, recs in buckets.items():
                ns_counts[ns or "(default)"] += len(recs)
            print("\n[dry-run] Records per namespace:")
            for ns, count in sorted(ns_counts.items(), key=lambda x: -x[1]):
                print(f"  {ns:40s}  {count}")
        print("\n[dry-run] No data was uploaded.")
        return

    # ── Final flush of any records not yet uploaded ───────────────────────────
    def _print_summary() -> None:
        """Print the run-final summary. Called from both exit paths."""
        elapsed = time.time() - grand_start
        print(f"\nDone — {grand_uploaded} uploaded, {grand_failed} failed, "
              f"{grand_skipped} skipped (already present), {grand_pruned} pruned.")
        print(f"Total time: {elapsed:.1f}s across {len(buckets)} namespace(s).")
        if errored_files:
            print(f"\n{len(errored_files)} file(s) could not be processed "
                  f"(skipped, not uploaded):")
            for name, reason in errored_files:
                print(f"  {name}  ->  {reason}")

    remaining_buckets = {ns: recs for ns, recs in buckets.items() if recs}
    if not remaining_buckets:
        # All records were either flushed mid-run or there were none to begin with.
        if total_chunks == 0:
            print("Nothing to upload.")
        _print_summary()
        return

    if args.prune_by_source:
        print("Note: streaming mode — deletes/uploads began during file scanning. "
              "An interrupt may leave the index partially updated.")
    print(f"\nFlushing remaining records across {len(remaining_buckets)} namespace(s).")
    for ns, records in sorted(remaining_buckets.items(), key=lambda x: -len(x[1])):
        _flush_bucket(ns, records)

    _print_summary()


if __name__ == "__main__":
    main()
