'''
聚合版本传承报告数据：
从版本河流、版本差异卡和星云节点中提取全局传承线索。
'''

from collections import Counter
from fastapi import APIRouter
from app.core.loader import store

router = APIRouter()

DIFF_COLUMNS = [
    {"id": "source_diversity", "label": "来源差异"},
    {"id": "role_add_missing_count", "label": "角色增删"},
    {"id": "role_change_count", "label": "行当变化"},
    {"id": "keyword_change_count", "label": "关键词漂移"},
    {"id": "text_delta_weight", "label": "文本规模变化"},
]


def _safe_abs(value):
    return abs(value) if isinstance(value, (int, float)) else 0


def _version_sources(river):
    sources = []
    for version in (river or {}).get("versions") or []:
        source = version.get("source_name") or "未知来源"
        sources.append(source)
    return sources


def _representative_play_id(group_id, river):
    versions = (river or {}).get("versions") or []
    for version in versions:
        play_id = version.get("play_id")
        if play_id:
            return play_id
    for node in store.nodes_by_group_id.get(group_id, []):
        if node.get("play_id"):
            return node.get("play_id")
    return None


def _diff_stats(diff_card):
    stats = {
        "role_change_count": 0,
        "role_add_missing_count": 0,
        "keyword_change_count": 0,
        "text_delta_total": 0,
    }
    for diff in (diff_card or {}).get("diffs") or []:
        stats["role_change_count"] += len(diff.get("role_type_changes") or [])
        stats["role_add_missing_count"] += len(diff.get("added_roles") or [])
        stats["role_add_missing_count"] += len(diff.get("missing_roles") or [])
        stats["keyword_change_count"] += len(diff.get("added_keywords") or [])
        stats["keyword_change_count"] += len(diff.get("missing_keywords") or [])
        text_delta = diff.get("text_delta") or {}
        stats["text_delta_total"] += _safe_abs(text_delta.get("text_length_delta"))
    return stats


def _build_reason(title, version_count, source_names, stats):
    reasons = []
    if version_count >= 4:
        reasons.append(f"保留了 {version_count} 个版本")
    elif version_count > 1:
        reasons.append(f"含 {version_count} 个版本")
    if len(source_names) >= 3:
        reasons.append(f"跨 {len(source_names)} 种来源")
    if stats["role_add_missing_count"]:
        reasons.append(f"角色增删 {stats['role_add_missing_count']} 处")
    if stats["role_change_count"]:
        reasons.append(f"行当变化 {stats['role_change_count']} 处")
    if stats["keyword_change_count"]:
        reasons.append(f"关键词差异 {stats['keyword_change_count']} 项")
    if not reasons:
        reasons.append("版本记录较完整")
    return f"《{title}》" + "，".join(reasons) + "，适合作为版本传承样本。"


@router.get("/version-lineage")
def get_version_lineage_report():
    source_counter = Counter()
    source_group_counter = Counter()
    rows = []

    group_ids = {
        item.get("play_group_id")
        for item in [*store.version_rivers, *store.version_diff_cards]
        if item.get("play_group_id")
    }

    for group_id in group_ids:
        river = store.version_river_by_group_id.get(group_id) or {}
        diff_card = store.version_diff_by_group_id.get(group_id) or {}
        versions = river.get("versions") or []
        source_names = sorted(set(_version_sources(river)))
        for source in _version_sources(river):
            source_counter[source] += 1
        for source in source_names:
            source_group_counter[source] += 1

        version_count = len(versions) or len(store.nodes_by_group_id.get(group_id, []))
        if version_count <= 1:
            continue

        stats = _diff_stats(diff_card)
        text_delta_weight = min(stats["text_delta_total"] / 5000, 6)
        source_diversity = len(source_names)
        diff_score = (
            version_count * 2
            + source_diversity * 2
            + stats["role_change_count"] * 1.5
            + stats["role_add_missing_count"]
            + stats["keyword_change_count"] * 0.5
            + text_delta_weight
        )
        title = (
            river.get("canonical_title")
            or diff_card.get("canonical_title")
            or (versions[0] or {}).get("title")
            or "未知剧目"
        )

        metric_values = {
            "source_diversity": source_diversity,
            "role_add_missing_count": stats["role_add_missing_count"],
            "role_change_count": stats["role_change_count"],
            "keyword_change_count": stats["keyword_change_count"],
            "text_delta_weight": round(text_delta_weight, 2),
        }

        rows.append({
            "play_group_id": group_id,
            "canonical_title": title,
            "representative_play_id": _representative_play_id(group_id, river),
            "version_count": version_count,
            "source_names": source_names,
            "source_diversity": source_diversity,
            "diff_score": round(diff_score, 2),
            "role_change_count": stats["role_change_count"],
            "role_add_missing_count": stats["role_add_missing_count"],
            "keyword_change_count": stats["keyword_change_count"],
            "text_delta_total": stats["text_delta_total"],
            "metric_values": metric_values,
            "reason": _build_reason(title, version_count, source_names, stats),
        })

    ranked = sorted(rows, key=lambda item: item["diff_score"], reverse=True)
    visible_rows = ranked[:12]
    max_values = {
        col["id"]: max([row["metric_values"][col["id"]] for row in visible_rows] or [1])
        for col in DIFF_COLUMNS
    }

    matrix_rows = []
    for row in visible_rows:
        cells = []
        for col in DIFF_COLUMNS:
            raw = row["metric_values"][col["id"]]
            max_value = max_values[col["id"]] or 1
            cells.append({
                "column_id": col["id"],
                "value": raw,
                "intensity": round(min(raw / max_value, 1), 3),
            })
        matrix_rows.append({
            "play_group_id": row["play_group_id"],
            "canonical_title": row["canonical_title"],
            "representative_play_id": row["representative_play_id"],
            "cells": cells,
        })

    diff_group_count = sum(
        1 for row in rows
        if row["role_change_count"] or row["role_add_missing_count"] or row["keyword_change_count"] or row["text_delta_total"]
    )

    return {
        "summary": {
            "multi_version_group_count": len(rows),
            "source_count": len(source_counter),
            "max_version_count": max([row["version_count"] for row in rows] or [0]),
            "diff_group_count": diff_group_count,
        },
        "ranked_groups": visible_rows,
        "diff_matrix": {
            "columns": DIFF_COLUMNS,
            "rows": matrix_rows,
        },
        "source_distribution": [
            {
                "source_name": source,
                "group_count": source_group_counter[source],
                "version_count": count,
            }
            for source, count in source_counter.most_common(10)
        ],
    }
