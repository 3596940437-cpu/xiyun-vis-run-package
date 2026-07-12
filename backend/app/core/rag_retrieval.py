"""
RAG 检索层
负责：
1. 根据 query_info 中的 intent 判断需要检索哪些 A/B 证据源
2. 根据 targets 中的 play_id、play_group_id、cluster_id 做定向证据召回
3. 根据 terms 在对应证据源中做关键词字段打分检索
4. 对版本差异类结构化数据生成可读的自然语言证据摘要
5. 对 evidence 进行补充元信息、合并去重、按意图优先级排序
6. 返回可用于构造大模型 prompt 和前端展示的 evidence 列表
"""


from __future__ import annotations

from typing import Any

from app.core.loader import store
from app.core.rag_utils import (
    get_by_path,
    normalize_for_match,
    value_to_text,
    score_record,
    evidence_from_record,
)


# 1. 证据源配置
# field_weights：用于关键词检索打分
# excerpt_paths：用于构造 evidence.excerpt
SOURCE_CONFIGS: dict[str, dict[str, Any]] = {
    # A：plays.json
    "play_summary": {
        "data_attr": "plays",
        "field_weights": {
            "text_summary": 8,
            "semantic_text": 7,
            "plot_keywords": 8,
            "character_keywords": 8,
            "source_note": 4,
            "opening_text_excerpt": 5,
        },
        "excerpt_paths": [
            "text_summary",
            "semantic_text",
            "plot_keywords",
            "character_keywords",
            "source_note",
            "opening_text_excerpt",
        ],
    },

    # A：text_chunks.json
    "text_chunk": {
        "data_attr": "text_chunks",
        "field_weights": {
            "text": 8,
            "chunk_type": 2,
            "scene_id": 2,
            "keywords": 8,
            "role_names": 8,
            "character_keys": 1,
            "evidence.section": 3,
            "evidence.source_note": 3,
        },
        "excerpt_paths": [
            "text",
            "keywords",
            "role_names",
            "chunk_type",
            "scene_id",
            "evidence.section",
            "evidence.source_note",
        ],
    },

    # A：roles.json
    "role_evidence": {
        "data_attr": "roles",
        "field_weights": {
            "evidence.source_block": 7,
            "evidence.page": 3,
            "evidence.raw_text": 8,
            "scene_ids": 2,
            "first_scene_id": 2,
            "last_scene_id": 2,
        },
        "excerpt_paths": [
            "evidence.raw_text",
            "evidence.source_block",
            "evidence.page",
            "scene_ids",
            "first_scene_id",
            "last_scene_id",
        ],
    },

    # B：nebula_nodes.json
    # 星云节点、相近原因、来源、主题、角色、行当结构
    "nebula_node": {
        "data_attr": "nebula_nodes",
        "field_weights": {
            "title": 8,
            "title_clean": 8,
            "themes": 7,
            "main_roles": 7,
            "source_name": 5,
            "role_type_counts": 5,
            "similarity_reason": 8,
        },
        "excerpt_paths": [
            "title",
            "themes",
            "main_roles",
            "source_name",
            "role_type_counts",
            "similarity_reason",
        ],
    },

    # B：cluster_explanations.json
    # 星团解释证据
    "cluster_explanation": {
        "data_attr": "cluster_explanations",
        "field_weights": {
            "cluster_name": 8,
            "summary": 9,
            "evidence.representative_titles": 6,
            "evidence.top_themes": 6,
            "evidence.top_genealogy_tags": 6,
            "evidence.top_motif_tags": 6,
            "evidence.top_keywords": 6,
            "evidence.top_role_types": 5,
            "evidence.top_sources": 5,
        },
        "excerpt_paths": [
            "cluster_name",
            "summary",
            "evidence.representative_titles",
            "evidence.top_themes",
            "evidence.top_genealogy_tags",
            "evidence.top_motif_tags",
            "evidence.top_keywords",
            "evidence.top_role_types",
            "evidence.top_sources",
        ],
    },

    # B：version_diff_cards.json
    # 版本差异卡片
    "version_diff_card": {
        "data_attr": "version_diff_cards",
        "field_weights": {
            "canonical_title": 8,
            "reference_title": 7,
            "diffs": 9,
        },
        "excerpt_paths": [
            "canonical_title",
            "reference_title",
            "diffs",
        ],
    },

    # B：version_rivers.json
    # 版本河流
    "version_river": {
        "data_attr": "version_rivers",
        "field_weights": {
            "canonical_title": 8,
            "versions": 8,
        },
        "excerpt_paths": [
            "canonical_title",
            "versions",
        ],
    },

    # B：version_matrices.json
    # 版本距离矩阵
    "version_matrix": {
        "data_attr": "version_matrices",
        "field_weights": {
            "canonical_title": 8,
            "labels": 7,
            "matrix": 4,
        },
        "excerpt_paths": [
            "canonical_title",
            "labels",
            "matrix",
        ],
    },
}


# 2. intent 到证据源的映射
INTENT_SOURCE_MAP: dict[str, list[str]] = {
    "version_diff": [
        "version_diff_card",
        "version_river",
        "version_matrix",
    ],
    "cluster_explain": [
        "cluster_explanation",
        "nebula_node",
    ],
    "role_fact": [
        "role_evidence",
        "text_chunk",
        "play_summary",
    ],
    "recommendation": [
        "nebula_node",
        "cluster_explanation",
        "play_summary",
        "text_chunk",
    ],
    "similarity_reason": [
        "nebula_node",
        "cluster_explanation",
    ],
    "plot_summary": [
        "play_summary",
        "text_chunk",
    ],
    "source_fact": [
        "play_summary",
        "text_chunk",
        "nebula_node",
        "version_river",
        "version_diff_card",
    ],
    "general": [
        "play_summary",
        "text_chunk",
        "role_evidence",
        "nebula_node",
        "cluster_explanation",
    ],
}


INTENT_SOURCE_PRIORITY: dict[str, dict[str, int]] = {
    "role_fact": {
        "role_evidence": 70,
        "text_chunk": 30,
        "play_summary": 10,
        "nebula_node": 5,
    },
    "plot_summary": {
        "play_summary": 70,
        "text_chunk": 45,
        "nebula_node": 10,
    },
    "version_diff": {
        "version_diff_card": 90,
        "version_river": 70,
        "version_matrix": 60,
        "play_summary": 10,
        "nebula_node": 5,
    },
    "cluster_explain": {
        "cluster_explanation": 90,
        "nebula_node": 60,
    },
    "similarity_reason": {
        "nebula_node": 80,
        "cluster_explanation": 60,
    },
    "source_fact": {
        "play_summary": 50,
        "text_chunk": 45,
        "nebula_node": 35,
        "version_river": 30,
        "version_diff_card": 30,
    },
    "recommendation": {
        "nebula_node": 60,
        "cluster_explanation": 50,
        "play_summary": 35,
        "text_chunk": 25,
    },
    "general": {
        "play_summary": 30,
        "text_chunk": 25,
        "role_evidence": 20,
        "nebula_node": 15,
        "cluster_explanation": 10,
    },
}


TARGET_REQUIRED_INTENTS = {
    "version_diff",
    "cluster_explain",
    "similarity_reason",
    "plot_summary",
    "source_fact",
}


# 3. 基础工具函数

def get_data_list(source_type: str) -> list[dict[str, Any]]:
    """
    根据 source_type 取对应的 store 数据列表。
    """
    config = SOURCE_CONFIGS[source_type]
    data_attr = config["data_attr"]
    data = getattr(store, data_attr, [])

    if isinstance(data, list):
        return data

    return []


def get_intent_names(query_info: dict[str, Any]) -> list[str]:
    """
    从 query_info 中取 intent 名称列表。
    """
    intents = query_info.get("intents") or []

    result: list[str] = []

    for item in intents:
        intent_name = item.get("intent")

        if intent_name and intent_name not in result:
            result.append(intent_name)

    if not result:
        result.append("general")

    return result


def get_sources_for_intents(intent_names: list[str]) -> list[str]:
    """
    根据 intent 列表决定要检索哪些证据源。
    """
    result: list[str] = []

    for intent_name in intent_names:
        source_types = INTENT_SOURCE_MAP.get(intent_name)

        if not source_types:
            source_types = INTENT_SOURCE_MAP["general"]

        for source_type in source_types:
            if source_type not in result:
                result.append(source_type)

    return result


def build_excerpt_value(
    record: dict[str, Any],
    excerpt_paths: list[str],
) -> Any:
    """
    从记录中抽取用于 evidence.excerpt 的内容。
    """
    values: list[Any] = []

    for path in excerpt_paths:
        value = get_by_path(record, path)

        if value:
            values.append(value)

    if not values:
        return record

    if len(values) == 1:
        return values[0]

    return values


# 根据 play_id 补充 title
def find_play_title_by_id(play_id: str | None) -> str | None:
    if not play_id:
        return None

    for play in get_data_list("play_summary"):
        if play.get("play_id") == play_id:
            return play.get("title")

    return None


# 版本类证据摘要：把 B 的结构化 JSON 转成 AI 和前端都能读懂的自然语言 evidence
INTERNAL_ID_PREFIXES = (
    "char_",
    "play_",
    "version_",
    "group_",
    "chunk_",
    "cluster_",
)


def is_internal_identifier(value: Any) -> bool:
    text = str(value or "").strip()
    return text.startswith(INTERNAL_ID_PREFIXES)


def clean_name(value: Any) -> str:
    text = str(value or "").strip()

    if not text:
        return ""

    if is_internal_identifier(text):
        return ""

    return text


def unique_names(values: Any, limit: int = 8) -> list[str]:
    """
    从 list / tuple / set / 单值中提取可展示名称，自动过滤内部 ID。
    """
    if values is None:
        return []

    if not isinstance(values, (list, tuple, set)):
        values = [values]

    result: list[str] = []

    for value in values:
        name = clean_name(value)

        if not name:
            continue

        if name not in result:
            result.append(name)

        if len(result) >= limit:
            break

    return result


def names_from_count_items(items: Any, limit: int = 8) -> list[str]:
    """
    从 [{"name": "...", "count": 2}] 这类结构中提取 name。
    """
    if not isinstance(items, list):
        return []

    result: list[str] = []

    for item in items:
        if isinstance(item, dict):
            name = clean_name(item.get("name"))
        else:
            name = clean_name(item)

        if not name:
            continue

        if name not in result:
            result.append(name)

        if len(result) >= limit:
            break

    return result


def join_names(names: list[str], empty: str = "无明确记录") -> str:
    cleaned = unique_names(names, limit=20)

    if not cleaned:
        return empty

    return "、".join(cleaned)


def role_type_counts_to_text(value: Any) -> str:
    if not isinstance(value, dict):
        return ""

    parts: list[str] = []

    for role_type, count in value.items():
        role_type_text = clean_name(role_type)

        if not role_type_text:
            continue

        if isinstance(count, int):
            parts.append(f"{role_type_text}{count}个")
        elif count:
            parts.append(f"{role_type_text}{count}")

    return "、".join(parts)


def find_nebula_node_by_version_id(version_id: str | None) -> dict[str, Any] | None:
    """
    根据 version_id 在 nebula_nodes 中找到对应版本节点，用来补充角色、行当结构和来源。
    """
    if not version_id:
        return None

    for node in get_data_list("nebula_node"):
        if node.get("version_id") == version_id:
            return node

    return None


def find_source_by_version_id(version_id: str | None) -> str:
    node = find_nebula_node_by_version_id(version_id)

    if node:
        source_name = clean_name(node.get("source_name"))

        if source_name:
            return source_name

    return ""


def build_version_river_summary(record: dict[str, Any]) -> str:
    """
    把 version_rivers.json 中的版本列表转成可读摘要。
    """
    title = record.get("canonical_title") or record.get("title") or "该剧目"
    version_count = record.get("version_count")
    versions = record.get("versions") or []

    lines: list[str] = [f"《{title}》版本列表："]

    if version_count:
        lines.append(f"当前剧目组包含 {version_count} 个版本。")

    for version in versions[:8]:
        if not isinstance(version, dict):
            continue

        source_name = clean_name(version.get("source_name")) or "来源未标明"
        role_count = version.get("role_count")
        version_index = version.get("version_index")
        version_id = version.get("version_id")
        node = find_nebula_node_by_version_id(version_id)

        roles_text = ""
        role_types_text = ""

        if node:
            roles = unique_names(node.get("main_roles") or [], limit=8)
            role_types = role_type_counts_to_text(node.get("role_type_counts"))

            if roles:
                roles_text = f"，主要角色包括{join_names(roles)}"

            if role_types:
                role_types_text = f"，行当结构为{role_types}"

        role_count_text = f"，角色数为 {role_count}" if role_count is not None else ""
        index_text = f"第 {version_index} 个版本" if version_index else "一个版本"

        lines.append(
            f"{index_text}来源为《{source_name}》{role_count_text}{roles_text}{role_types_text}。"
        )

    return "\n".join(lines)


def build_role_type_change_text(change: dict[str, Any]) -> str:
    from_type = clean_name(change.get("from"))
    to_type = clean_name(change.get("to"))

    if not from_type or not to_type:
        return ""

    # B 的 version_diff_cards 里 character_key 多数是内部 ID，不能直接展示角色名。
    # 这里只说明“有角色”发生行当标注变化，避免暴露 char_xxx。
    return f"有角色行当由{from_type}变为{to_type}"


def get_added_missing_roles(diff: dict[str, Any]) -> tuple[list[str], list[str]]:
    """
    优先使用 text_delta 里的 added_chunk_roles / missing_chunk_roles。
    如果没有可展示角色名，就回退到 text_profile / reference_text_profile 的 top_chunk_roles。
    """
    text_delta = diff.get("text_delta") or {}
    text_profile = diff.get("text_profile") or {}
    reference_text_profile = diff.get("reference_text_profile") or {}

    added_roles = unique_names(text_delta.get("added_chunk_roles") or [], limit=8)
    missing_roles = unique_names(text_delta.get("missing_chunk_roles") or [], limit=8)

    if not added_roles:
        added_roles = names_from_count_items(
            text_profile.get("top_chunk_roles"),
            limit=5,
        )

    if not missing_roles:
        missing_roles = names_from_count_items(
            reference_text_profile.get("top_chunk_roles"),
            limit=5,
        )

    return added_roles, missing_roles


def get_keyword_delta(diff: dict[str, Any]) -> tuple[list[str], list[str]]:
    text_delta = diff.get("text_delta") or {}

    added_keywords = unique_names(
        text_delta.get("added_chunk_keywords")
        or diff.get("added_keywords")
        or [],
        limit=5,
    )
    missing_keywords = unique_names(
        text_delta.get("missing_chunk_keywords")
        or diff.get("missing_keywords")
        or [],
        limit=5,
    )

    return added_keywords, missing_keywords


def get_text_delta_parts(diff: dict[str, Any]) -> list[str]:
    text_delta = diff.get("text_delta") or {}
    result: list[str] = []

    delta_fields = [
        ("chunk_count_delta", "片段数量变化"),
        ("text_length_delta", "文本长度变化"),
        ("singing_cue_delta", "唱段提示变化"),
        ("spoken_cue_delta", "对白提示变化"),
        ("stage_direction_hint_delta", "舞台提示变化"),
    ]

    for field, label in delta_fields:
        value = text_delta.get(field)

        if isinstance(value, int) and value != 0:
            result.append(f"{label}{value:+d}")

    return result


def build_version_diff_summary(record: dict[str, Any], max_diffs: int = 5) -> str:
    """
    把 version_diff_cards.json 中的 diffs 转成可读摘要。
    重点提取：来源差异、角色增减/弱化、行当变化、关键词变化、文本规模变化。
    """
    title = record.get("canonical_title") or record.get("title") or "该剧目"
    reference_title = record.get("reference_title") or title
    reference_version_id = record.get("reference_version_id")
    reference_source = find_source_by_version_id(reference_version_id)
    diffs = record.get("diffs") or []

    lines: list[str] = [f"《{title}》版本差异对比："]

    if reference_source:
        lines.append(f"当前差异以《{reference_source}》来源本作为参照。")
    else:
        lines.append(f"当前差异以《{reference_title}》中的一个版本作为参照。")

    for diff in diffs[:max_diffs]:
        if not isinstance(diff, dict):
            continue

        source_difference = diff.get("source_difference") or {}
        reference_source_name = clean_name(source_difference.get("reference"))
        current_source = clean_name(source_difference.get("current"))

        added_roles, missing_roles = get_added_missing_roles(diff)
        added_keywords, missing_keywords = get_keyword_delta(diff)
        role_type_changes = diff.get("role_type_changes") or []
        text_delta_parts = get_text_delta_parts(diff)

        parts: list[str] = []

        if reference_source_name and current_source:
            parts.append(f"来源由《{reference_source_name}》对比到《{current_source}》")
        elif current_source:
            parts.append(f"当前比较版本来源为《{current_source}》")

        if added_roles:
            parts.append(f"当前版本新增或突出角色：{join_names(added_roles)}")

        if missing_roles:
            parts.append(f"当前版本缺少或弱化角色：{join_names(missing_roles)}")

        role_change_texts: list[str] = []

        for change in role_type_changes[:4]:
            if not isinstance(change, dict):
                continue

            change_text = build_role_type_change_text(change)

            if change_text and change_text not in role_change_texts:
                role_change_texts.append(change_text)

        if role_change_texts:
            parts.append("；".join(role_change_texts))

        if added_keywords:
            parts.append(f"新增关键词包括：{join_names(added_keywords)}")

        if missing_keywords:
            parts.append(f"缺少关键词包括：{join_names(missing_keywords)}")

        if text_delta_parts:
            parts.append("、".join(text_delta_parts))

        if not parts:
            continue

        source_label = f"《{current_source}》来源本" if current_source else "某一版本"
        lines.append(f"{source_label}：{'；'.join(parts)}。")

    if len(lines) == 2:
        lines.append("当前差异字段不足以展开具体角色、行当或文本变化。")

    return "\n".join(lines)


def build_version_matrix_summary(record: dict[str, Any]) -> str:
    """
    把 version_matrices.json 中的矩阵转成简单摘要。
    不暴露完整矩阵，只说明版本数量和差异范围。
    """
    title = record.get("canonical_title") or record.get("title") or "该剧目"
    version_ids = record.get("version_ids") or []
    matrix = record.get("matrix") or []

    lines: list[str] = [f"《{title}》版本距离矩阵："]

    if version_ids:
        lines.append(f"当前矩阵包含 {len(version_ids)} 个版本。")

    values: list[float] = []

    if isinstance(matrix, list):
        for row in matrix:
            if not isinstance(row, list):
                continue

            for value in row:
                if isinstance(value, (int, float)) and value > 0:
                    values.append(float(value))

    if values:
        min_value = min(values)
        max_value = max(values)
        lines.append(
            f"矩阵中的非零差异值约在 {min_value:.3f} 到 {max_value:.3f} 之间，可用于辅助判断版本差异程度。"
        )

    return "\n".join(lines)


def build_version_summary_text(source_type: str, record: dict[str, Any]) -> str | None:
    """
    版本类证据专用摘要。
    作用：不要把原始 JSON 或泛泛说明传给 AI，而是生成可读的版本对比材料。
    """
    if source_type == "version_diff_card":
        return build_version_diff_summary(record)

    if source_type == "version_river":
        return build_version_river_summary(record)

    if source_type == "version_matrix":
        return build_version_matrix_summary(record)

    return None


def enrich_evidence_metadata(
    evidence: dict[str, Any],
    record: dict[str, Any],
) -> dict[str, Any]:
    """
    补充 A/B 证据中常用但 rag_utils.evidence_from_record
    没有统一输出的字段。
    """
    raw_evidence = record.get("evidence") or {}

    evidence["evidence_page"] = raw_evidence.get("page")
    evidence["evidence_source_block"] = raw_evidence.get("source_block")
    evidence["evidence_raw_text"] = raw_evidence.get("raw_text")

    evidence["source_name"] = record.get("source_name")
    evidence["version_label"] = record.get("version_label")
    evidence["canonical_title"] = record.get("canonical_title")
    evidence["reference_title"] = record.get("reference_title")

    if not evidence.get("title"):
        evidence["title"] = (
            record.get("title")
            or record.get("canonical_title")
            or find_play_title_by_id(evidence.get("play_id") or record.get("play_id"))
        )

    return evidence


def make_evidence_from_record(
    source_type: str,
    record: dict[str, Any],
    score: int,
    matched_terms: list[str],
    matched_fields: list[str],
    excerpt_value: Any,
) -> dict[str, Any]:
    """
    统一调用 rag_utils.evidence_from_record，并补充证据元信息。

    对版本类证据做特殊处理：
    - 不直接把原始 diffs / versions / matrix 丢给 AI；
    - 先生成自然语言版版本摘要，再作为 _prompt_text 给 AI。
    """
    version_summary = build_version_summary_text(source_type, record)

    if version_summary:
        excerpt_value = version_summary

    evidence = evidence_from_record(
        source_type=source_type,
        record=record,
        score=score,
        matched_terms=matched_terms,
        matched_fields=matched_fields,
        excerpt_value=excerpt_value,
    )

    evidence = enrich_evidence_metadata(evidence, record)

    if version_summary:
        # 给 AI 用完整摘要
        evidence["_prompt_text"] = version_summary

        # 给后续 get_evidence_text / display_text 一个可读文本。
        evidence["excerpt"] = version_summary

    return evidence


def make_direct_evidence(
    source_type: str,
    record: dict[str, Any],
    score: int,
    matched_field: str = "direct_target",
) -> dict[str, Any]:
    """
    把一个已确定相关的 record 转成 evidence。
    """
    config = SOURCE_CONFIGS[source_type]

    excerpt_value = build_excerpt_value(
        record=record,
        excerpt_paths=config["excerpt_paths"],
    )

    return make_evidence_from_record(
        source_type=source_type,
        record=record,
        score=score,
        matched_terms=[],
        matched_fields=[matched_field],
        excerpt_value=excerpt_value,
    )


def match_play_id(record: dict[str, Any], play_id: str | None) -> bool:
    if not play_id:
        return False

    return record.get("play_id") == play_id


def match_play_group_id(record: dict[str, Any], play_group_id: str | None) -> bool:
    if not play_group_id:
        return False

    return record.get("play_group_id") == play_group_id


def match_cluster_id(record: dict[str, Any], cluster_id: str | None) -> bool:
    if not cluster_id:
        return False

    return record.get("cluster_id") == cluster_id


def normalize_exclude_themes(query_info: dict[str, Any]) -> list[str]:
    filters = query_info.get("filters") or {}
    exclude_themes = filters.get("exclude_themes") or []

    result: list[str] = []

    for item in exclude_themes:
        norm = normalize_for_match(item)

        if norm:
            result.append(norm)

    return result


def record_passes_filters(
    record: dict[str, Any],
    query_info: dict[str, Any],
) -> bool:
    """
    处理 exclude_themes / require_multi_version 等简单过滤条件。
    """
    filters = query_info.get("filters") or {}
    record_text = value_to_text(record)

    for norm_theme in normalize_exclude_themes(query_info):
        if norm_theme in record_text:
            return False

    if filters.get("require_multi_version"):
        version_count = record.get("version_count")

        if isinstance(version_count, int) and version_count < 2:
            return False

    return True


def complete_targets(
    targets: dict[str, Any],
) -> dict[str, Any]:
    """
    当 targets 里只有 play_id 时，尽量补齐 play_group_id / cluster_id。
    """
    result = dict(targets)

    play_id = result.get("play_id")

    if play_id:
        for node in get_data_list("nebula_node"):
            if match_play_id(node, play_id):
                result["play_group_id"] = (
                    result.get("play_group_id")
                    or node.get("play_group_id")
                )
                result["cluster_id"] = (
                    result.get("cluster_id")
                    or node.get("cluster_id")
                )
                result["title"] = (
                    result.get("title")
                    or node.get("title")
                )
                return result

        for play in get_data_list("play_summary"):
            if match_play_id(play, play_id):
                result["play_group_id"] = (
                    result.get("play_group_id")
                    or play.get("play_group_id")
                )
                result["title"] = (
                    result.get("title")
                    or play.get("title")
                )
                return result

    return result


# 4. 关键词检索

def search_source_by_terms(
    source_type: str,
    query_info: dict[str, Any],
    limit: int = 6,
) -> list[dict[str, Any]]:
    """
    在某一个证据源里按 terms 做字段打分检索。
    """
    config = SOURCE_CONFIGS[source_type]
    records = get_data_list(source_type)
    terms = query_info.get("terms") or []

    results: list[dict[str, Any]] = []

    for record in records:
        if not isinstance(record, dict):
            continue

        if not record_passes_filters(record, query_info):
            continue

        score, matched_terms, matched_fields = score_record(
            record=record,
            terms=terms,
            field_weights=config["field_weights"],
        )

        if score <= 0:
            continue

        excerpt_value = build_excerpt_value(
            record=record,
            excerpt_paths=config["excerpt_paths"],
        )

        evidence = make_evidence_from_record(
            source_type=source_type,
            record=record,
            score=score,
            matched_terms=matched_terms,
            matched_fields=matched_fields,
            excerpt_value=excerpt_value,
        )

        results.append(evidence)

    results.sort(
        key=lambda x: x.get("score", 0),
        reverse=True,
    )

    return results[:limit]


# 5. 定向检索

def collect_play_direct_evidence(
    play_id: str,
    intent_names: list[str],
    limit_per_source: int = 4,
) -> list[dict[str, Any]]:
    """
    根据 play_id 直接取剧目相关证据。
    """
    results: list[dict[str, Any]] = []

    is_version_query = "version_diff" in intent_names
    is_plot_query = "plot_summary" in intent_names
    is_role_query = "role_fact" in intent_names or "general" in intent_names

    # plays.json
    for play in get_data_list("play_summary"):
        if match_play_id(play, play_id):
            results.append(
                make_direct_evidence(
                    source_type="play_summary",
                    record=play,
                    score=80 if is_version_query else 100,
                )
            )
            break

    # text_chunks.json
    chunks = [
        chunk
        for chunk in get_data_list("text_chunk")
        if match_play_id(chunk, play_id)
    ]

    if is_plot_query:
        chunks.sort(
            key=lambda x: (
                0 if x.get("chunk_type") == "summary" else
                1 if x.get("chunk_type") == "note" else
                2,
                x.get("chunk_order") or 0,
            )
        )
    else:
        chunks.sort(
            key=lambda x: x.get("chunk_order") or 0
        )

    if not is_version_query:
        for chunk in chunks[:limit_per_source]:
            results.append(
                make_direct_evidence(
                    source_type="text_chunk",
                    record=chunk,
                    score=90,
                )
            )

    # roles.json
    if is_role_query:
        roles = [
            role
            for role in get_data_list("role_evidence")
            if match_play_id(role, play_id)
        ]

        roles.sort(
            key=lambda x: x.get("role_order") or 0
        )

        for role in roles[:limit_per_source]:
            results.append(
                make_direct_evidence(
                    source_type="role_evidence",
                    record=role,
                    score=85,
                )
            )

    # nebula_nodes.json
    for node in get_data_list("nebula_node"):
        if match_play_id(node, play_id):
            results.append(
                make_direct_evidence(
                    source_type="nebula_node",
                    record=node,
                    score=75 if is_version_query else 80,
                )
            )
            break

    return results


def collect_group_direct_evidence(
    play_group_id: str,
) -> list[dict[str, Any]]:
    """
    根据 play_group_id 直接取版本差异相关证据。
    """
    results: list[dict[str, Any]] = []

    for source_type, score in [
        ("version_diff_card", 120),
        ("version_river", 115),
        ("version_matrix", 110),
    ]:
        for record in get_data_list(source_type):
            if match_play_group_id(record, play_group_id):
                results.append(
                    make_direct_evidence(
                        source_type=source_type,
                        record=record,
                        score=score,
                    )
                )

    return results


def collect_cluster_direct_evidence(
    cluster_id: str,
    limit_nodes: int = 6,
) -> list[dict[str, Any]]:
    """
    根据 cluster_id 直接取星团解释和星团内节点。
    """
    results: list[dict[str, Any]] = []

    for item in get_data_list("cluster_explanation"):
        if match_cluster_id(item, cluster_id):
            results.append(
                make_direct_evidence(
                    source_type="cluster_explanation",
                    record=item,
                    score=120,
                )
            )
            break

    nodes = [
        node
        for node in get_data_list("nebula_node")
        if match_cluster_id(node, cluster_id)
    ]

    for node in nodes[:limit_nodes]:
        results.append(
            make_direct_evidence(
                source_type="nebula_node",
                record=node,
                score=85,
            )
        )

    return results


def retrieve_direct_evidence(
    query_info: dict[str, Any],
) -> list[dict[str, Any]]:
    """
    根据 targets 做定向检索。
    """
    raw_targets = query_info.get("targets") or {}
    targets = complete_targets(raw_targets)
    intent_names = get_intent_names(query_info)

    results: list[dict[str, Any]] = []

    play_id = targets.get("play_id")
    play_group_id = targets.get("play_group_id")
    cluster_id = targets.get("cluster_id")

    if play_id:
        results.extend(
            collect_play_direct_evidence(
                play_id=play_id,
                intent_names=intent_names,
            )
        )

    if play_group_id and "version_diff" in intent_names:
        results.extend(
            collect_group_direct_evidence(
                play_group_id=play_group_id,
            )
        )

    if cluster_id and (
        "cluster_explain" in intent_names
        or "similarity_reason" in intent_names
        or "recommendation" in intent_names
    ):
        results.extend(
            collect_cluster_direct_evidence(
                cluster_id=cluster_id,
            )
        )

    return results


# 6. 检索入口控制

def query_needs_target_but_missing(query_info: dict[str, Any]) -> bool:
    """
    判断问题是否需要具体对象，但当前没有对象。
    """
    intents = query_info.get("intents") or []

    if not intents:
        return False

    top_intent = intents[0].get("intent")

    if top_intent not in TARGET_REQUIRED_INTENTS:
        return False

    return (
        not query_info.get("has_direct_target")
        and not query_info.get("has_search_constraint")
    )


def retrieve_keyword_evidence(
    query_info: dict[str, Any],
    limit_per_source: int = 5,
) -> list[dict[str, Any]]:
    """
    根据 terms 做关键词检索。
    """
    if query_needs_target_but_missing(query_info):
        return []

    if not query_info.get("has_search_constraint"):
        return []

    intent_names = get_intent_names(query_info)
    source_types = get_sources_for_intents(intent_names)

    results: list[dict[str, Any]] = []

    for source_type in source_types:
        results.extend(
            search_source_by_terms(
                source_type=source_type,
                query_info=query_info,
                limit=limit_per_source,
            )
        )

    return results


def make_hashable_key_value(value: Any) -> Any:
    """
    把 list / dict / set 转成可以作为 dict key 的类型。

    evidence_key 用来做去重键，要求里面的每个值都必须可哈希。
    但 evidence 里的 role_name、excerpt 等字段有时可能是 list 或 dict，
    所以这里统一转换。
    """

    if isinstance(value, list):
        return tuple(make_hashable_key_value(item) for item in value)

    if isinstance(value, dict):
        return tuple(
            sorted(
                (str(key), make_hashable_key_value(val))
                for key, val in value.items()
            )
        )

    if isinstance(value, set):
        return tuple(sorted(make_hashable_key_value(item) for item in value))

    return value


def evidence_key(evidence: dict[str, Any]) -> tuple[Any, ...]:
    """
    evidence 去重键。
    """
    return tuple(
        make_hashable_key_value(value)
        for value in (
            evidence.get("source_type"),
            evidence.get("play_id"),
            evidence.get("play_group_id"),
            evidence.get("cluster_id"),
            evidence.get("version_id"),
            evidence.get("chunk_id"),
            evidence.get("scene_id"),
            evidence.get("role_name"),
            evidence.get("title"),
            evidence.get("excerpt"),
        )
    )


def get_source_priority(
    intent_names: list[str],
    source_type: str | None,
) -> int:
    if not source_type:
        return 0

    priority = 0

    for intent_name in intent_names:
        source_priority = INTENT_SOURCE_PRIORITY.get(intent_name) or {}
        priority = max(priority, source_priority.get(source_type, 0))

    return priority


def evidence_rank_score(
    evidence: dict[str, Any],
    intent_names: list[str],
) -> int | float:
    raw_score = evidence.get("score", 0)

    if not isinstance(raw_score, (int, float)):
        raw_score = 0

    source_priority = get_source_priority(
        intent_names=intent_names,
        source_type=evidence.get("source_type"),
    )

    return raw_score + source_priority


def merge_and_rank_evidence(
    evidence_list: list[dict[str, Any]],
    intent_names: list[str],
    top_k: int = 12,
) -> list[dict[str, Any]]:
    """
    合并、去重、排序 evidence。
    """
    best_by_key: dict[tuple[Any, ...], dict[str, Any]] = {}

    for evidence in evidence_list:
        key = evidence_key(evidence)

        old = best_by_key.get(key)

        if old is None:
            best_by_key[key] = evidence
            continue

        if evidence_rank_score(evidence, intent_names) > evidence_rank_score(old, intent_names):
            best_by_key[key] = evidence

    results = list(best_by_key.values())

    results.sort(
        key=lambda x: evidence_rank_score(x, intent_names),
        reverse=True,
    )

    return results[:top_k]


def retrieve_evidence(
    query_info: dict[str, Any],
    top_k: int = 12,
) -> list[dict[str, Any]]:
    """
    RAG 检索入口。

    参数：
    - query_info: rag_utils.understand_query() 的结果
    - top_k: 最终最多返回多少条 evidence

    返回：
    - evidence 列表
    """
    intent_names = get_intent_names(query_info)

    direct_evidence = retrieve_direct_evidence(query_info)
    keyword_evidence = retrieve_keyword_evidence(query_info)

    all_evidence: list[dict[str, Any]] = []
    all_evidence.extend(direct_evidence)
    all_evidence.extend(keyword_evidence)

    return merge_and_rank_evidence(
        evidence_list=all_evidence,
        intent_names=intent_names,
        top_k=top_k,
    )