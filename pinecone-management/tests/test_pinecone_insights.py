import json
import time

import pinecone_insights


COOKING_TEXTS = [
    "This chicken roast recipe starts with searing the chicken in a hot skillet.",
    "For this pasta recipe, cook the noodles then toss them with olive oil and garlic.",
    "The bread recipe requires kneading the dough for ten minutes before it rests.",
    "This soup recipe simmers vegetables and broth together for a comforting dinner.",
    "The dessert recipe calls for melting chocolate and folding it into whipped cream.",
    "This grilling recipe marinates the steak overnight before cooking over charcoal.",
]
FINANCE_TEXTS = [
    "The quarterly finance report shows revenue growth and controlled operating expenses.",
    "This finance memo outlines the new budget allocation across departments.",
    "The finance team reconciled the invoice ledger against outstanding vendor payments.",
    "A finance review of the investment portfolio recommended rebalancing toward bonds.",
    "The finance department flagged an expense discrepancy in the quarterly audit.",
    "This finance update covers interest rate changes and their impact on loan pricing.",
]


def _make_chunks(texts, source_prefix):
    return [
        {"id": f"{source_prefix}-{i}", "text": t, "source": f"{source_prefix}.md",
         "title": source_prefix, "doc_type": "notes", "tags": "", "collection": ""}
        for i, t in enumerate(texts)
    ]


# ── Topic modeling (no network calls; feeds synthetic chunk data directly) ──

def test_tfidf_nmf_topics_separates_distinct_themes():
    chunks = _make_chunks(COOKING_TEXTS, "cooking") + _make_chunks(FINANCE_TEXTS, "finance")

    topics = pinecone_insights._tfidf_nmf_topics(chunks, n_topics=2)

    assert len(topics) == 2
    all_terms = {t.lower() for topic in topics for t in topic["top_terms"]}
    cooking_words = {"recipe", "chicken", "soup", "steak", "vegetables", "dough", "skillet"}
    finance_words = {"finance", "budget", "revenue", "expense", "invoice", "portfolio", "audit"}
    assert all_terms & cooking_words
    assert all_terms & finance_words

    # Each topic should be dominated by one source, not a mix of both themes.
    for topic in topics:
        assert topic["sample_sources"] in (["cooking.md"], ["finance.md"])
    for topic in topics:
        assert topic["chunk_count"] > 0
        assert topic["excerpts"]


def test_tfidf_nmf_topics_handles_empty_input():
    assert pinecone_insights._tfidf_nmf_topics([], n_topics=8) == []


def test_tfidf_nmf_topics_caps_n_topics_to_available_chunks():
    chunks = _make_chunks(COOKING_TEXTS[:2], "cooking")
    topics = pinecone_insights._tfidf_nmf_topics(chunks, n_topics=8)
    assert len(topics) <= 2


# ── Cache staleness ──────────────────────────────────────────────────────────

def test_is_cache_stale_missing_file(tmp_path):
    missing = tmp_path / "nope.json"
    assert pinecone_insights._is_cache_stale(missing, "idx", "ns", ttl_seconds=999999) is True


def test_is_cache_stale_within_ttl_and_matching_count(monkeypatch, tmp_path):
    cache_file = tmp_path / "cache.json"
    cache_file.write_text(json.dumps({
        "generated_at": time.time(),
        "total_vector_count": 42,
    }), encoding="utf-8")
    monkeypatch.setattr(pinecone_insights, "_fetch_total_vector_count", lambda idx, ns: 42)

    assert pinecone_insights._is_cache_stale(cache_file, "idx", "ns", ttl_seconds=999999) is False


def test_is_cache_stale_on_count_mismatch(monkeypatch, tmp_path):
    cache_file = tmp_path / "cache.json"
    cache_file.write_text(json.dumps({
        "generated_at": time.time(),
        "total_vector_count": 42,
    }), encoding="utf-8")
    monkeypatch.setattr(pinecone_insights, "_fetch_total_vector_count", lambda idx, ns: 43)

    assert pinecone_insights._is_cache_stale(cache_file, "idx", "ns", ttl_seconds=999999) is True


def test_is_cache_stale_on_expired_ttl(tmp_path):
    cache_file = tmp_path / "cache.json"
    cache_file.write_text(json.dumps({
        "generated_at": time.time() - 1000,
        "total_vector_count": 42,
    }), encoding="utf-8")

    assert pinecone_insights._is_cache_stale(cache_file, "idx", "ns", ttl_seconds=10) is True


# ── End-to-end caching (fetch monkeypatched — no network) ──────────────────

def test_summarize_namespace_caches_and_skips_refetch(monkeypatch, tmp_path):
    monkeypatch.setattr(pinecone_insights, "CACHE_DIR", tmp_path)
    chunks = _make_chunks(COOKING_TEXTS, "cooking") + _make_chunks(FINANCE_TEXTS, "finance")
    fetch_calls = []

    def fake_fetch_chunks(index_name, namespace="", filter_json=None,
                           max_records=5000, include_values=False):
        fetch_calls.append(1)
        return chunks

    monkeypatch.setattr(pinecone_insights, "_fetch_chunks", fake_fetch_chunks)
    monkeypatch.setattr(pinecone_insights, "_fetch_total_vector_count", lambda idx, ns: len(chunks))

    first = pinecone_insights.summarize_namespace("peace", namespace="test-ns", n_topics=2)
    assert first["cached"] is False
    assert len(fetch_calls) == 1
    assert len(first["topics"]) == 2

    second = pinecone_insights.summarize_namespace("peace", namespace="test-ns", n_topics=2)
    assert second["cached"] is True
    assert len(fetch_calls) == 1  # not re-fetched — served from cache
    assert second["topics"] == first["topics"]


def test_summarize_namespace_refresh_forces_recompute(monkeypatch, tmp_path):
    monkeypatch.setattr(pinecone_insights, "CACHE_DIR", tmp_path)
    chunks = _make_chunks(COOKING_TEXTS, "cooking")
    fetch_calls = []

    def fake_fetch_chunks(index_name, namespace="", filter_json=None,
                           max_records=5000, include_values=False):
        fetch_calls.append(1)
        return chunks

    monkeypatch.setattr(pinecone_insights, "_fetch_chunks", fake_fetch_chunks)
    monkeypatch.setattr(pinecone_insights, "_fetch_total_vector_count", lambda idx, ns: len(chunks))

    pinecone_insights.summarize_namespace("peace", namespace="test-ns", n_topics=1)
    pinecone_insights.summarize_namespace("peace", namespace="test-ns", n_topics=1, refresh=True)

    assert len(fetch_calls) == 2
