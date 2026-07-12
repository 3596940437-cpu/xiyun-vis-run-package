'''
把数据集里的JSON文件读进后端内存,并整理成方便接口查询的索引
'''

import json
from pathlib import Path
from typing import Any

from app.core.config import DERIVED_DIR
from app.core.indexes import index_by, group_by, build_edges_by_node_id


def load_json(name: str, default: Any):
    path = DERIVED_DIR / name

    if not path.exists():
        return default

    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


class DataStore:
    def __init__(self):
        # A 的数据
        self.plays = load_json("plays.json", [])
        self.play_groups = load_json("play_groups.json", [])
        self.roles = load_json("roles.json", [])
        self.sources = load_json("sources.json", [])
        self.versions = load_json("versions.json", [])
        self.text_chunks = load_json("text_chunks.json", [])

        # B 的数据
        self.nebula_nodes = load_json("nebula_nodes.json", [])
        self.nebula_edges = load_json("nebula_edges.json", [])
        self.clusters = load_json("clusters.json", [])
        self.coarse_clusters = load_json("coarse_clusters.json", [])
        self.cluster_explanations = load_json("cluster_explanations.json", [])
        self.version_rivers = load_json("version_rivers.json", [])
        self.version_matrices = load_json("version_matrices.json", [])
        self.version_diff_cards = load_json("version_diff_cards.json", [])

        # 建索引
        self.build_indexes()

    def build_indexes(self):
        # 根据 play_id 找剧目基础信息
        self.play_by_id = index_by(self.plays, "play_id")

        # 根据 play_id 找星云节点
        self.node_by_play_id = index_by(self.nebula_nodes, "play_id")

        # 根据 cluster_id 找星团基础信息
        self.cluster_by_id = index_by(self.clusters, "cluster_id")

        # 根据 cluster_id 找星团解释
        self.cluster_explanation_by_id = index_by(
            self.cluster_explanations,
            "cluster_id"
        )

        # 根据 play_group_id 找版本河流
        self.version_river_by_group_id = index_by(
            self.version_rivers,
            "play_group_id"
        )

        # 根据 play_group_id 找版本矩阵
        self.version_matrix_by_group_id = index_by(
            self.version_matrices,
            "play_group_id"
        )

        # 根据 play_group_id 找版本差异卡片
        self.version_diff_by_group_id = index_by(
            self.version_diff_cards,
            "play_group_id"
        )

        # 根据 play_group_id 找同名剧目的全部版本节点
        self.nodes_by_group_id = group_by(
            self.nebula_nodes,
            "play_group_id"
        )

        # 根据 cluster_id 找星团内全部节点
        self.nodes_by_cluster_id = group_by(
            self.nebula_nodes,
            "cluster_id"
        )

        # 根据 play_id 找角色列表
        self.roles_by_play_id = group_by(
            self.roles,
            "play_id"
        )

        # 根据 play_id 找文本证据片段
        self.chunks_by_play_id = group_by(
            self.text_chunks,
            "play_id"
        )

        # 根据节点 ID 找相邻边
        self.edges_by_node_id = build_edges_by_node_id(
            self.nebula_edges
        )


store = DataStore()