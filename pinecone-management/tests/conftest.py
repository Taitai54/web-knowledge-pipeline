import pytest


@pytest.fixture(autouse=True)
def _no_real_reranker_download(monkeypatch):
    """Prevent any test from downloading the real cross-encoder model.
    Tests that want to exercise the reranking path explicitly monkeypatch
    pinecone_mcp._get_reranker to a stub with a .predict() method; every
    other test gets the graceful "not installed" fallback for free."""
    try:
        import pinecone_mcp
    except ImportError:
        return

    def _unavailable():
        raise RuntimeError(
            "Local reranking requires sentence-transformers.\n"
            "  Install:  pip install sentence-transformers"
        )

    monkeypatch.setattr(pinecone_mcp, "_get_reranker", _unavailable, raising=False)
