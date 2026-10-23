import search_server


def test_candidate_limit_matches_mcp_pool():
    assert search_server.candidate_limit(5, True) == 20
    assert search_server.candidate_limit(8, True) == 30
    assert search_server.candidate_limit(5, False) == 5
    assert search_server.candidate_limit(50, False) == 20


def test_list_namespace_rows_sorts_by_count_and_skips_blank():
    rows = search_server.list_namespace_rows({
        "namespaces": {
            "": {"vectorCount": 3},
            "books": {"vectorCount": 10},
            "general": {"vectorCount": 0},
            "ai-technology": {"vectorCount": 10},
        }
    })
    assert [row["name"] for row in rows] == ["ai-technology", "books", "general"]
    assert rows[0]["vectorCount"] == 10
    assert rows[2]["vectorCount"] == 0


def test_index_rows_map_dimension_to_local_model_and_put_default_first():
    rows = search_server.index_rows([
        {"name": "gravity-claw", "dimension": 1536, "host": "g.pinecone.io", "status": {"state": "Ready"}},
        {"name": "multimodal-rag", "dimension": 768, "host": "m.pinecone.io", "status": {"state": "Ready"}},
        {"name": "peace", "dimension": 1024, "host": "https://p.pinecone.io", "status": {"state": "Ready"},
         "embed": {"model": "multilingual-e5-large"}},
        {"name": "llama", "dimension": 1024, "host": "l.pinecone.io", "status": {"state": "Initializing"},
         "embed": {"model": "llama-text-embed-v2"}},
    ], "peace")
    by_name = {row["name"]: row for row in rows}
    assert rows[0]["name"] == "peace"
    assert by_name["peace"]["model"] == "intfloat/multilingual-e5-large"
    assert by_name["peace"]["host"] == "https://p.pinecone.io"
    assert by_name["multimodal-rag"]["model"] == "intfloat/multilingual-e5-base"
    assert by_name["multimodal-rag"]["host"] == "https://m.pinecone.io"
    assert by_name["gravity-claw"]["model"] == ""
    assert "1536" in by_name["gravity-claw"]["reason"]
    assert by_name["llama"]["model"] == ""
    assert by_name["llama"]["ready"] is False


def test_index_rows_read_2026_schemas():
    rows = search_server.index_rows([
        {"name": "peace-docs", "host": "d.pinecone.io", "status": {"state": "Ready"}, "schema": {"fields": {
            "text": {"type": "string", "full_text_search": {"language": "en"}},
            "embedding": {"type": "dense_vector", "dimension": 1024,
                          "description": "embed_model=Qwen/Qwen3-Embedding-0.6B"},
        }}},
        {"name": "peace", "host": "p.pinecone.io", "schema": {"fields": {
            "text": {"type": "semantic_text", "model": "multilingual-e5-large", "dimension": 1024},
        }}},
        {"name": "multimodal-rag", "host": "m.pinecone.io", "schema": {"fields": {
            "_values": {"type": "dense_vector", "dimension": 768},
            "_sparse_values": {"type": "sparse_vector"},
        }}},
        {"name": "hosted-llama", "host": "h.pinecone.io", "schema": {"fields": {
            "text": {"type": "semantic_text", "model": "llama-text-embed-v2", "dimension": 1024},
        }}},
    ], "peace")
    by_name = {row["name"]: row for row in rows}
    assert by_name["peace-docs"]["kind"] == "document"
    assert by_name["peace-docs"]["denseField"] == "embedding"
    assert by_name["peace-docs"]["textField"] == "text"
    assert by_name["peace"]["textField"] == ""
    assert by_name["peace-docs"]["model"] == "Qwen/Qwen3-Embedding-0.6B"
    assert by_name["peace"]["kind"] == "vector"
    assert by_name["peace"]["model"] == "intfloat/multilingual-e5-large"
    assert by_name["multimodal-rag"]["kind"] == "vector"
    assert by_name["multimodal-rag"]["model"] == "intfloat/multilingual-e5-base"
    assert by_name["hosted-llama"]["model"] == ""
    assert "llama-text-embed-v2" in by_name["hosted-llama"]["reason"]


def test_parse_namespaces_accepts_list_or_legacy_string():
    assert search_server.parse_namespaces({"namespaces": [" books ", "", "books", "general"]}) == ["books", "general"]
    assert search_server.parse_namespaces({"namespace": "books"}) == ["books"]
    assert search_server.parse_namespaces({"namespaces": [], "namespace": "general"}) == ["general"]
    assert search_server.parse_namespaces({}) == []
    many = [f"ns{i}" for i in range(20)]
    assert len(search_server.parse_namespaces({"namespaces": many})) == search_server.MAX_NAMESPACES


def test_fuse_ranked_merges_by_rank_and_keeps_dense_score():
    meaning = [("a", 0.9, {"text": "A"}, "books", "meaning"), ("b", 0.8, {"text": "B"}, "books", "meaning")]
    keyword = [("c", 14.0, {"text": "C"}, "books", "keyword"), ("b", 12.0, {"text": "B"}, "books", "keyword")]
    other_ns = [("d", 0.7, {"text": "D"}, "general", "meaning")]
    fused = search_server.fuse_ranked([meaning, keyword, other_ns], 10)
    by_id = {entry["id"]: entry for entry in fused}
    assert fused[0]["id"] == "b"
    assert by_id["b"]["methods"] == ["meaning", "keyword"]
    assert by_id["b"]["score"] == 0.8
    assert by_id["c"]["score"] is None
    assert by_id["d"]["namespace"] == "general"
    assert len(search_server.fuse_ranked([meaning, keyword, other_ns], 2)) == 2
