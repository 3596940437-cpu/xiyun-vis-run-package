'''
给剧目详情页提供数据：
剧目的基础信息、角色、证据片段、版本摘要、相邻剧目和高亮信息
'''

'''
给版本传承页提供数据：
版本时间河
角色变形谱基础数据
版本距离矩阵
情节差异卡片
版本节点列表
'''

from fastapi import APIRouter, HTTPException
from app.core.loader import store

router = APIRouter()

def compact_chunk(ch):
    evidence = ch.get("evidence") or {}
    return {
        "chunk_id": ch.get("chunk_id"),
        "text": ch.get("text"),
        "chunk_type": ch.get("chunk_type"),
        "scene_id": ch.get("scene_id"),
        "keywords": ch.get("keywords", []),
        "role_names": ch.get("role_names", []),
        "evidence": {
            "section": evidence.get("section"),
            "source_note": evidence.get("source_note"),
        },
    }

def build_neighbors(play_id: str, limit: int = 8):
    edges = store.edges_by_node_id.get(play_id, [])
    edges = sorted(edges, key=lambda e: e.get("weight", 0), reverse=True)

    result = []
    for e in edges[:limit]:
        other_id = e.get("target") if e.get("source") == play_id else e.get("source")
        node = store.node_by_play_id.get(other_id)
        if not node:
            continue

        result.append({
            "play_id": other_id,
            "title": node.get("title"),
            "cluster_id": node.get("cluster_id"),
            "weight": e.get("weight"),
            "distance": e.get("distance"),
            "relation_type": e.get("relation_type"),
            "reasons": e.get("reasons", []),
            "similarity_reason": node.get("similarity_reason"),
            "highlight": {
                "type": "play",
                "id": other_id,
            },
        })

    return result

@router.get("/{play_id}")
def get_play(play_id: str):
    play = store.play_by_id.get(play_id)
    node = store.node_by_play_id.get(play_id)

    if not play and not node:
        raise HTTPException(status_code=404, detail="play_id not found")

    merged = {}
    if play:
        merged.update(play)
    if node:
        merged.update({
            "play_id": node.get("play_id"),
            "play_group_id": node.get("play_group_id"),
            "version_id": node.get("version_id"),
            "title": node.get("title"),
            "title_clean": node.get("title_clean"),
            "source_name": node.get("source_name"),
            "cluster_id": node.get("cluster_id"),
            "coarse_cluster_id": node.get("coarse_cluster_id"),
            "themes": node.get("themes", []),
            "main_roles": node.get("main_roles", []),
            "similarity_reason": node.get("similarity_reason"),
            "quality": node.get("quality"),
        })

    group_id = merged.get("play_group_id")

    chunks = store.chunks_by_play_id.get(play_id, [])
    roles = store.roles_by_play_id.get(play_id, [])

    return {
        "play": merged,
        "roles": roles,
        "text_evidence_preview": [compact_chunk(ch) for ch in chunks[:5]],
        "version_summary": store.version_river_by_group_id.get(group_id),
        "neighbors": build_neighbors(play_id),
        "highlight": {
            "type": "play",
            "id": play_id,
        },
    }
    

@router.get("/{play_id}/versions")
def get_play_versions(play_id: str):
    node = store.node_by_play_id.get(play_id)
    play = store.play_by_id.get(play_id)

    if not node and not play:
        raise HTTPException(status_code=404, detail="play_id not found")

    group_id = None
    if node:
        group_id = node.get("play_group_id")
    if not group_id and play:
        group_id = play.get("play_group_id")

    if not group_id:
        raise HTTPException(status_code=404, detail="play_group_id not found")

    version_nodes = store.nodes_by_group_id.get(group_id, [])

    compact_nodes = [
        {
            "play_id": n.get("play_id"),
            "version_id": n.get("version_id"),
            "title": n.get("title"),
            "source_name": n.get("source_name"),
            "version_label": n.get("version_label"),
            "role_count": n.get("role_count"),
            "role_type_counts": n.get("role_type_counts"),
            "quality": n.get("quality"),
            "highlight": {
                "type": "play",
                "id": n.get("play_id"),
            },
        }
        for n in version_nodes
    ]

    river = store.version_river_by_group_id.get(group_id)
    matrix = store.version_matrix_by_group_id.get(group_id)
    diff_card = store.version_diff_by_group_id.get(group_id)

    return {
        "play_id": play_id,
        "play_group_id": group_id,
        "canonical_title": (
            (river or {}).get("canonical_title")
            or (diff_card or {}).get("canonical_title")
            or (node or {}).get("title")
        ),
        "river": river,
        "matrix": matrix,
        "diff_card": diff_card,
        "version_nodes": compact_nodes,
        "highlight": {
            "type": "play_group",
            "id": group_id,
        },
    }