import pinecone_mcp


class _FakeResponse:
    def __init__(self, ok=True, status_code=200, json_data=None, text=""):
        self.ok = ok
        self.status_code = status_code
        self._json_data = json_data or {}
        self.text = text

    def json(self):
        return self._json_data


def _patch_host_and_meta(monkeypatch, dimension=1024):
    monkeypatch.setattr(pinecone_mcp, "_resolve_host", lambda index_name: "fake-host")
    monkeypatch.setattr(pinecone_mcp, "_fetch_index_meta",
                         lambda index_name: {"host": "fake-host", "dimension": dimension, "metric": "cosine"})


def _patch_local_embed(monkeypatch, calls):
    def fake_local_embed_query(text, dimension):
        calls.append(("local_embed", text, dimension))
        return [0.1] * dimension
    monkeypatch.setattr(pinecone_mcp, "_local_embed_query", fake_local_embed_query)


# ── _normalize_match truncation ──────────────────────────────────────────────

def test_normalize_match_truncates_text_by_default():
    long_text = "word " * 300  # ~1500 chars
    match = {"id": "a", "score": 0.9, "metadata": {"text": long_text, "title": "T"}}

    result = pinecone_mcp._normalize_match(match)

    assert len(result["text"]) <= 501
    assert result["text"].endswith("…")


def test_normalize_match_full_text_opt_out():
    long_text = "word " * 300
    match = {"id": "a", "score": 0.9, "metadata": {"text": long_text, "title": "T"}}

    result = pinecone_mcp._normalize_match(match, full_text=True)

    assert result["text"] == long_text


def test_normalize_match_max_chars_zero_means_no_truncation():
    long_text = "word " * 300
    match = {"id": "a", "score": 0.9, "metadata": {"text": long_text}}

    result = pinecone_mcp._normalize_match(match, max_chars=0)

    assert result["text"] == long_text


# ── tool_search default/opt-in embedding path ───────────────────────────────

def test_tool_search_defaults_to_local_embed(monkeypatch):
    pinecone_mcp._cache_clear()
    _patch_host_and_meta(monkeypatch)
    calls = []
    _patch_local_embed(monkeypatch, calls)

    def fake_request(method, url, **kwargs):
        calls.append(("request", method, url))
        assert "/records/" not in url  # paid endpoint must never be hit
        return _FakeResponse(ok=True, json_data={"matches": [
            {"id": "x1", "score": 0.5, "metadata": {"text": "hello", "title": "T"}}
        ]})

    monkeypatch.setattr(pinecone_mcp, "_request_with_retry", fake_request)

    result = pinecone_mcp.tool_search("peace", "test query", namespace="ns1")

    assert result["embedding"] == "local"
    assert result["count"] == 1
    assert any(c[0] == "local_embed" for c in calls)
    assert any(c[0] == "request" and c[2].endswith("/query") for c in calls)


def test_tool_search_paid_embed_opt_in_uses_integrated_inference(monkeypatch):
    pinecone_mcp._cache_clear()
    _patch_host_and_meta(monkeypatch)
    calls = []
    _patch_local_embed(monkeypatch, calls)

    def fake_request(method, url, **kwargs):
        calls.append(("request", method, url))
        assert "/records/" in url
        return _FakeResponse(ok=True, json_data={"result": {"hits": [
            {"_id": "x1", "_score": 0.5, "fields": {"text": "hello", "title": "T"}}
        ]}})

    monkeypatch.setattr(pinecone_mcp, "_request_with_retry", fake_request)

    result = pinecone_mcp.tool_search("peace", "test query", namespace="ns1", paid_embed=True)

    assert result["embedding"] == "paid"
    assert result["count"] == 1
    assert not any(c[0] == "local_embed" for c in calls)  # never embedded locally


def test_tool_search_cache_hit_skips_second_embed_call(monkeypatch):
    pinecone_mcp._cache_clear()
    _patch_host_and_meta(monkeypatch)
    calls = []
    _patch_local_embed(monkeypatch, calls)

    def fake_request(method, url, **kwargs):
        calls.append(("request", method, url))
        return _FakeResponse(ok=True, json_data={"matches": [
            {"id": "x1", "score": 0.5, "metadata": {"text": "hello"}}
        ]})

    monkeypatch.setattr(pinecone_mcp, "_request_with_retry", fake_request)

    first = pinecone_mcp.tool_search("peace", "repeat me", namespace="ns1")
    assert first.get("cached") is not True
    embed_calls_after_first = sum(1 for c in calls if c[0] == "local_embed")

    second = pinecone_mcp.tool_search("peace", "repeat me", namespace="ns1")
    embed_calls_after_second = sum(1 for c in calls if c[0] == "local_embed")

    assert second["cached"] is True
    assert embed_calls_after_second == embed_calls_after_first  # no re-embed


def test_tool_upsert_clears_query_cache(monkeypatch):
    pinecone_mcp._cache_clear()
    _patch_host_and_meta(monkeypatch)
    _patch_local_embed(monkeypatch, [])

    def fake_search_request(method, url, **kwargs):
        return _FakeResponse(ok=True, json_data={"matches": [
            {"id": "x1", "score": 0.5, "metadata": {"text": "hello"}}
        ]})

    monkeypatch.setattr(pinecone_mcp, "_request_with_retry", fake_search_request)
    result = pinecone_mcp.tool_search("peace", "cache me", namespace="ns1")
    assert result.get("cached") is not True
    assert pinecone_mcp._cache_get(
        pinecone_mcp._cache_key("peace", "cache me", "ns1", None, 5, 500, False, False, True)
    ) is not None

    def fake_upsert_request(method, url, **kwargs):
        return _FakeResponse(ok=True, json_data={})

    monkeypatch.setattr(pinecone_mcp, "_request_with_retry", fake_upsert_request)
    pinecone_mcp.tool_upsert("peace", [{"_id": "a", "text": "hi"}])

    assert pinecone_mcp._cache_get(
        pinecone_mcp._cache_key("peace", "cache me", "ns1", None, 5, 500, False, False, True)
    ) is None


# ── Local reranking ──────────────────────────────────────────────────────────

class _FakeCrossEncoder:
    def __init__(self, score_map):
        self.score_map = score_map  # text -> score

    def predict(self, pairs):
        return [self.score_map.get(text, 0.0) for _, text in pairs]


def test_tool_search_rerank_reorders_by_cross_encoder_score(monkeypatch):
    pinecone_mcp._cache_clear()
    _patch_host_and_meta(monkeypatch)
    _patch_local_embed(monkeypatch, [])

    # Dense similarity ranks "b" first, but the (fake) cross-encoder prefers "a".
    def fake_request(method, url, **kwargs):
        return _FakeResponse(ok=True, json_data={"matches": [
            {"id": "b", "score": 0.9, "metadata": {"text": "about finance and budgets"}},
            {"id": "a", "score": 0.5, "metadata": {"text": "about cooking recipes"}},
        ]})

    monkeypatch.setattr(pinecone_mcp, "_request_with_retry", fake_request)
    fake_model = _FakeCrossEncoder({
        "about finance and budgets": 0.1,
        "about cooking recipes": 0.9,
    })
    monkeypatch.setattr(pinecone_mcp, "_get_reranker", lambda: fake_model)

    result = pinecone_mcp.tool_search("peace", "cooking recipes", namespace="ns1", limit=2)

    assert result["reranked"] is True
    assert [r["id"] for r in result["results"]] == ["a", "b"]


def test_tool_search_rerank_false_skips_reranker_entirely(monkeypatch):
    pinecone_mcp._cache_clear()
    _patch_host_and_meta(monkeypatch)
    _patch_local_embed(monkeypatch, [])

    def fake_request(method, url, **kwargs):
        return _FakeResponse(ok=True, json_data={"matches": [
            {"id": "b", "score": 0.9, "metadata": {"text": "b text"}},
            {"id": "a", "score": 0.5, "metadata": {"text": "a text"}},
        ]})

    monkeypatch.setattr(pinecone_mcp, "_request_with_retry", fake_request)

    def _boom():
        raise AssertionError("reranker should not be loaded when rerank=False")
    monkeypatch.setattr(pinecone_mcp, "_get_reranker", _boom)

    result = pinecone_mcp.tool_search("peace", "query", namespace="ns1", limit=2, rerank=False)

    assert result["reranked"] is False
    assert [r["id"] for r in result["results"]] == ["b", "a"]


def test_tool_search_rerank_falls_back_gracefully_when_unavailable(monkeypatch):
    pinecone_mcp._cache_clear()
    _patch_host_and_meta(monkeypatch)
    _patch_local_embed(monkeypatch, [])

    def fake_request(method, url, **kwargs):
        return _FakeResponse(ok=True, json_data={"matches": [
            {"id": "a", "score": 0.9, "metadata": {"text": "a text"}},
        ]})

    monkeypatch.setattr(pinecone_mcp, "_request_with_retry", fake_request)
    # conftest's autouse fixture already simulates "sentence-transformers not
    # installed" for _get_reranker; this test asserts the resulting shape.

    result = pinecone_mcp.tool_search("peace", "query", namespace="ns1")

    assert result["reranked"] is False
    assert result["count"] == 1
