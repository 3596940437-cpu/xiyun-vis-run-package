'''
索引工具函数
'''

from collections import defaultdict
from typing import Any


def index_by(items: list[dict[str, Any]], key: str) -> dict[str, dict[str, Any]]:

    result = {}

    for item in items:
        value = item.get(key)

        if value is None:
            continue

        result[str(value)] = item

    return result


def group_by(items: list[dict[str, Any]], key: str) -> dict[str, list[dict[str, Any]]]:

    result = defaultdict(list)

    for item in items:
        value = item.get(key)

        if value is None:
            continue

        result[str(value)].append(item)

    return dict(result)


def build_edges_by_node_id(edges: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:

    result = defaultdict(list)

    for edge in edges:
        source = edge.get("source")
        target = edge.get("target")

        if source:
            result[str(source)].append(edge)

        if target:
            result[str(target)].append(edge)

    return dict(result)