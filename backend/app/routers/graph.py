'''
给星云总览页提供数据：
点nodes,边edges,星团clusters，粗星团coarse_clusters，统计信息meta
'''
from fastapi import APIRouter, Query
from app.core.loader import store
from app.core.config import DATA_VERSION

router = APIRouter()

@router.get("/nebula")
def get_nebula(
    cluster_id: str | None = None,
    focus_only: bool = False,
    include_edges: bool = True,
):
    nodes = store.nebula_nodes

    if cluster_id:
        nodes = [n for n in nodes if n.get("cluster_id") == cluster_id]

    if focus_only:
        nodes = [n for n in nodes if n.get("is_focus") is True]

    node_ids = {n.get("node_id") or n.get("play_id") for n in nodes}

    if include_edges:
        edges = [
            e for e in store.nebula_edges
            if e.get("source") in node_ids and e.get("target") in node_ids
        ]
    else:
        edges = []

    return {
        "data_version": DATA_VERSION,
        "nodes": nodes,
        "edges": edges,
        "clusters": store.clusters,
        "coarse_clusters": store.coarse_clusters,
        "meta": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "cluster_count": len(store.clusters),
        },
    }