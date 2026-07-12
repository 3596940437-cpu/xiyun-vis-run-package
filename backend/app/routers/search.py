'''
给非AI搜索框提供数据：
用户输入关键词后，它会在剧名、角色、行当、主题、来源、摘要、文本片段里查找，
合并成按剧目排序的搜索结果，并返回可以高亮星云节点的 play_id
'''
from fastapi import APIRouter, Query
from app.core.loader import store

router = APIRouter()

def contains(value, q: str) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return q in value.lower()
    if isinstance(value, list):
        return any(contains(v, q) for v in value)
    if isinstance(value, dict):
        return any(contains(k, q) or contains(v, q) for k, v in value.items())
    return q in str(value).lower()

def add_result(results, play_id, score, matched_field, snippet):
    if not play_id:
        return

    node = store.node_by_play_id.get(play_id)
    play = store.play_by_id.get(play_id)

    title = None
    if node:
        title = node.get("title")
    if not title and play:
        title = play.get("title") or play.get("title_clean")

    if play_id not in results:
        results[play_id] = {
            "type": "play",
            "title": title,
            "play_id": play_id,
            "play_group_id": (node or play or {}).get("play_group_id"),
            "version_id": (node or play or {}).get("version_id"),
            "cluster_id": (node or {}).get("cluster_id"),
            "score": 0,
            "matched_fields": [],
            "snippet": snippet,
            "highlight": {
                "type": "play",
                "id": play_id,
            },
        }

    results[play_id]["score"] += score

    if matched_field not in results[play_id]["matched_fields"]:
        results[play_id]["matched_fields"].append(matched_field)

@router.get("")
def search(q: str = Query(..., min_length=1), limit: int = 30):
    query = q.strip().lower()
    results = {}

    for n in store.nebula_nodes:
        play_id = n.get("play_id")

        if contains(n.get("title"), query) or contains(n.get("title_clean"), query):
            add_result(
                results,
                play_id,
                100,
                "title",
                f'{n.get("title")}｜{n.get("source_name")}｜{"、".join(n.get("themes", []))}',
            )

        if contains(n.get("main_roles"), query):
            add_result(results, play_id, 80, "main_roles", "命中主要角色")

        if contains(n.get("themes"), query):
            add_result(results, play_id, 60, "themes", "命中主题标签")

        if contains(n.get("source_name"), query):
            add_result(results, play_id, 40, "source_name", "命中来源")

        if contains(n.get("role_type_counts"), query):
            add_result(results, play_id, 50, "role_type_counts", "命中行当结构")

    for p in store.plays:
        play_id = p.get("play_id")

        if contains(p.get("text_summary"), query):
            add_result(results, play_id, 50, "text_summary", p.get("text_summary"))

        if contains(p.get("plot_keywords"), query):
            add_result(results, play_id, 50, "plot_keywords", "命中情节关键词")

        if contains(p.get("character_keywords"), query):
            add_result(results, play_id, 50, "character_keywords", "命中角色关键词")

        if contains(p.get("source_note"), query):
            add_result(results, play_id, 30, "source_note", "命中来源说明")

    for r in store.roles:
        play_id = r.get("play_id")

        if contains(r, query):
            add_result(results, play_id, 45, "roles", "命中角色或行当字段")

    for ch in store.text_chunks:
        play_id = ch.get("play_id")

        if contains(ch.get("keywords"), query):
            add_result(results, play_id, 40, "text_chunks.keywords", "命中文本片段关键词")

        if contains(ch.get("role_names"), query):
            add_result(results, play_id, 45, "text_chunks.role_names", "命中文本片段角色")

        if contains(ch.get("text"), query):
            text = ch.get("text") or ""
            idx = text.lower().find(query)
            snippet = text[max(0, idx - 30): idx + 80] if idx >= 0 else text[:100]
            add_result(results, play_id, 35, "text_chunks.text", snippet)

    items = sorted(results.values(), key=lambda x: x["score"], reverse=True)
    items = items[:limit]

    return {
        "query": q,
        "items": items,
        "meta": {
            "count": len(items),
        },
    }