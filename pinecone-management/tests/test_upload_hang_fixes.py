import sys
import threading
import time
from pathlib import Path

import pinecone_bulk
import pinecone_gui


class _Var:
    def __init__(self, value):
        self._value = value

    def get(self):
        return self._value


def _gui_for_build_cmd():
    app = object.__new__(pinecone_gui.App)
    app.index_name_var = _Var("peace")
    app.namespace_var = _Var("")
    app.doc_type_var = _Var("auto-detect")
    app.tags_var = _Var("")
    app.dry_run = _Var(False)
    app.recursive = _Var(True)
    app.prune_by_source = _Var(False)
    app.force_reupload = _Var(False)
    app.collection_var = _Var("")
    app.auto_tags_from_path = _Var(False)
    app.namespace_from_top_folder = _Var(False)
    app.collection_from_top_folder = _Var(False)
    app.doc_type_from_folder = _Var(False)
    app.client_embed = _Var(True)
    return app


def test_gui_launches_bulk_script_unbuffered():
    app = _gui_for_build_cmd()

    cmd = app._build_cmd(["C:/Knowledge"])

    assert cmd[0] == pinecone_gui.sys.executable
    assert cmd[1] == "-u"
    assert Path(cmd[2]).name == "pinecone_bulk.py"
    assert "--index-name" in cmd
    # client_embed=True (the new GUI default) means local embedding — no
    # opt-out flag should be emitted.
    assert "--paid-embed" not in cmd


def test_gui_build_cmd_emits_paid_embed_when_unchecked():
    app = _gui_for_build_cmd()
    app.client_embed = _Var(False)

    cmd = app._build_cmd(["C:/Knowledge"])

    assert "--paid-embed" in cmd


def test_iter_supported_files_deduplicates_and_preserves_roots(tmp_path):
    root = tmp_path / "library"
    nested = root / "notes"
    nested.mkdir(parents=True)
    first = root / "alpha.md"
    second = nested / "beta.txt"
    unsupported = root / "ignore.docx"
    first.write_text("# Alpha\n\nbody", encoding="utf-8")
    second.write_text("beta body", encoding="utf-8")
    unsupported.write_text("ignored", encoding="utf-8")

    targets = pinecone_bulk.iter_supported_files([str(root), str(first)], recursive=True)

    assert targets == [(first, root), (second, root)]


def test_fetch_existing_ids_uses_configurable_batch_size(monkeypatch):
    ids = [f"id-{i}" for i in range(1100)]
    call_sizes = []

    class Response:
        ok = True

        def json(self):
            return {"vectors": {}}

    def fake_get(url, headers, params, timeout):
        call_sizes.append(len([value for key, value in params if key == "ids"]))
        return Response()

    monkeypatch.setattr(pinecone_bulk.requests, "get", fake_get)

    found = pinecone_bulk.fetch_existing_ids(
        "example-host",
        "notes",
        ids,
        batch_size=500,
    )

    assert found == set()
    assert call_sizes == [500, 500, 100]


def test_vector_upsert_batches_respect_payload_limit():
    vectors = [
        {
            "id": f"id-{i}",
            "values": [0.1, 0.2, 0.3, 0.4],
            "metadata": {"text": "x" * 80, "source": f"doc-{i}.txt"},
        }
        for i in range(4)
    ]

    batches = pinecone_bulk.vector_upsert_batches(vectors, max_payload_bytes=260)

    assert len(batches) > 1
    assert [vector["id"] for batch in batches for vector in batch] == [
        "id-0",
        "id-1",
        "id-2",
        "id-3",
    ]
    for batch in batches:
        payload = {"vectors": batch}
        assert len(pinecone_bulk.json.dumps(payload).encode("utf-8")) <= 260


# ── Local-embed hang regression tests ───────────────────────────────────────

def _fake_records(n=8):
    return [
        {
            "_id":         f"hang-{i}",
            "text":        f"sample text chunk number {i}",
            "source":      "test.txt",
            "title":       "Test",
            "doc_type":    "notes",
            "section":     "",
            "chunk_index": i,
            "chunk_count": n,
        }
        for i in range(n)
    ]


def _patch_embed(monkeypatch, embed_sub=2):
    """Replace the sentence-transformers model with instant fake embeddings."""
    monkeypatch.setattr(pinecone_bulk, "_LOCAL_DEVICE", "cpu")
    monkeypatch.setattr(
        pinecone_bulk, "local_embed_passages",
        lambda texts: [[0.1] * 4 for _ in texts],
    )
    # Force a small sub-batch so the encoding loop runs multiple iterations
    # and fills the upload queue, stressing sentinel delivery.
    monkeypatch.setattr(pinecone_bulk, "_device_embed_batch", lambda _d: embed_sub)


def test_upsert_batch_local_completes_with_slow_uploads(monkeypatch):
    """
    upsert_batch_local must always return even when each upload call takes
    long enough to fill the queue while the encoding loop is still running.

    The old code tried to deliver the sentinel with a single 30-second
    queue.put; if the uploader was busy for longer the sentinel was never
    received and the uploader blocked forever on queue.get().

    We simulate the race by making uploads take 1 s each and using 8 records
    with embed_sub=2 (four encode→queue cycles).  The whole run should finish
    well under 15 s.
    """
    UPLOAD_DELAY  = 1.0   # seconds — slow enough to keep the queue full
    TEST_TIMEOUT  = 20    # seconds — a real hang would never return here

    _patch_embed(monkeypatch)

    monkeypatch.setattr(
        pinecone_bulk, "_upload_embedded_batch",
        lambda body, host: (
            time.sleep(UPLOAD_DELAY) or
            {"success": True, "retries": 0, "retry_reasons": [], "delay_applied": 0.0}
        ),
    )

    result_box = []

    def _run():
        result_box.append(
            pinecone_bulk.upsert_batch_local(_fake_records(8), "fake-host", "ns")
        )

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=TEST_TIMEOUT)

    assert not t.is_alive(), (
        f"upsert_batch_local hung: did not return in {TEST_TIMEOUT}s — "
        "sentinel delivery or join-timeout bug."
    )
    assert result_box, "function returned no result"
    assert result_box[0]["success"] is True, result_box[0]


def test_upsert_batch_local_sentinel_delivered_when_queue_full(monkeypatch):
    """
    Verify the sentinel (stop signal) reaches the uploader thread even when
    every queue slot is occupied at the moment encoding finishes.

    Strategy: patch the sentinel timeout constant to near-zero so the old
    single-shot put would always time out, then confirm the new retry-loop
    still delivers it and the function returns successfully.
    """
    UPLOAD_DELAY  = 0.3   # s — long enough to keep the queue full reliably
    TEST_TIMEOUT  = 15

    _patch_embed(monkeypatch, embed_sub=2)   # 8 records → 4 payloads

    upload_count = []

    def _slow_upload(body, host):
        upload_count.append(1)
        time.sleep(UPLOAD_DELAY)
        return {"success": True, "retries": 0, "retry_reasons": [], "delay_applied": 0.0}

    monkeypatch.setattr(pinecone_bulk, "_upload_embedded_batch", _slow_upload)

    # Shrink the module-level timeout constant so the OLD single-shot sentinel
    # put would fail (the new sentinel retry loop ignores this constant and
    # uses its own 5 s per-attempt timeout, so it is unaffected).
    monkeypatch.setattr(pinecone_bulk, "UPLOAD_QUEUE_PUT_TIMEOUT", 0.01)

    result_box = []

    def _run():
        result_box.append(
            pinecone_bulk.upsert_batch_local(_fake_records(8), "fake-host", "ns")
        )

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=TEST_TIMEOUT)

    assert not t.is_alive(), (
        f"upsert_batch_local hung with near-zero UPLOAD_QUEUE_PUT_TIMEOUT: "
        f"did not return in {TEST_TIMEOUT}s."
    )
    assert result_box, "function returned no result"
    assert result_box[0]["success"] is True, result_box[0]
    # All 8 records → 4 payloads (embed_sub=2, 8/2=4)
    assert len(upload_count) == 4


# ── Ingestion default-flip tests (local embedding is now the default) ──────

def _run_dry_run_main(monkeypatch, tmp_path, extra_args=()):
    """Run pinecone_bulk.main() against one temp file in --dry-run mode
    (no network calls: index_host/index_dim are hardcoded, and the upload
    path is skipped entirely) and return the captured stdout."""
    doc = tmp_path / "sample.txt"
    doc.write_text("hello world " * 20, encoding="utf-8")

    argv = ["pinecone_bulk.py", str(doc), "--index-name", "peace",
            "--dry-run", *extra_args]
    monkeypatch.setattr(sys, "argv", argv)
    monkeypatch.setattr(pinecone_bulk, "_LOCAL_MODEL", None)

    pinecone_bulk.main()


def test_bulk_defaults_to_local_embed_without_flags(monkeypatch, tmp_path, capsys):
    _run_dry_run_main(monkeypatch, tmp_path)
    out = capsys.readouterr().out
    assert "Embed : LOCAL" in out


def test_paid_embed_flag_opts_out_of_local(monkeypatch, tmp_path, capsys):
    _run_dry_run_main(monkeypatch, tmp_path, extra_args=["--paid-embed"])
    out = capsys.readouterr().out
    assert "Embed : Pinecone integrated" in out


def test_client_embed_flag_still_accepted_as_noop(monkeypatch, tmp_path, capsys):
    _run_dry_run_main(monkeypatch, tmp_path, extra_args=["--client-embed"])
    out = capsys.readouterr().out
    assert "Embed : LOCAL" in out
    assert "[note] --client-embed is deprecated" in out
