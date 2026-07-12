'''
给星团详情面板提供数据：
星团基本信息，星团解释，星团内所有剧目节点，代表剧目详情，高亮对象
'''

from fastapi import APIRouter, HTTPException
from app.core.loader import store

router = APIRouter()

@router.get("/{cluster_id}")
def get_cluster(cluster_id: str):
    cluster = store.cluster_by_id.get(cluster_id)
    explanation = store.cluster_explanation_by_id.get(cluster_id)
    nodes = store.nodes_by_cluster_id.get(cluster_id, [])

    if not cluster and not explanation and not nodes:
        raise HTTPException(status_code=404, detail="cluster_id not found")

    compact_nodes = [
        {
            "play_id": n.get("play_id"),
            "node_id": n.get("node_id"),
            "play_group_id": n.get("play_group_id"),
            "version_id": n.get("version_id"),
            "title": n.get("title"),
            "source_name": n.get("source_name"),
            "themes": n.get("themes", []),
            "main_roles": n.get("main_roles", []),
            "role_type_counts": n.get("role_type_counts"),
            "x": n.get("x"),
            "y": n.get("y"),
            "similarity_reason": n.get("similarity_reason"),
            "highlight": {
                "type": "play",
                "id": n.get("play_id"),
            },
        }
        for n in nodes
    ]

    rep_ids = (cluster or {}).get("representative_play_ids", [])
    representative_plays = [
        store.node_by_play_id[pid]
        for pid in rep_ids
        if pid in store.node_by_play_id
    ]

    return {
        "cluster": cluster,
        "explanation": explanation,
        "nodes": compact_nodes,
        "representative_plays": representative_plays,
        "highlight": {
            "type": "cluster",
            "id": cluster_id,
        },
    }