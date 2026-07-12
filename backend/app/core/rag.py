"""
RAG 问答主流程

负责：
1. 调用 rag_utils.py 理解用户问题
2. 调用 rag_retrieval.py 获取结构化 / 关键词 evidence
3. 调用 rag_vector.py 获取向量 evidence
4. 合并、去重、重排、截断 evidence
5. 构造 system prompt 和 user prompt
6. 调用大模型生成最终回答
7. 解析模型 JSON 输出，获取 answer 和 used_evidence_numbers
8. 根据 used_evidence_numbers 选择前端 evidence
9. 返回 answer、evidence、highlight_targets、suggested_questions

注意：
- 缓存只作为失败兜底使用，不在正常问题一开始就直接命中缓存。
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from app.core.rag_utils import understand_query
from app.core.rag_retrieval import retrieve_evidence
from app.core.rag_vector import (
    get_openai_client,
    load_env,
    retrieve_vector_evidence,
)
from app.core.cache import (
    find_faq_item,
    build_cached_response as build_cache_item_response,
)


# 结构化检索最多取多少条
STRUCTURED_TOP_K = 8

# 向量检索最多取多少条
VECTOR_TOP_K = 8

# 最终最多给 AI 的 evidence 数量
FINAL_EVIDENCE_MAX = 8

# 模型实际使用 6~8 条材料时，也允许前端完整返回，避免 answer 和 evidence 对不上
MAX_FRONTEND_EVIDENCE = 8

# 模型没有返回 used_evidence_numbers 时，兜底返回前几条 evidence
FALLBACK_FRONTEND_EVIDENCE = 5

# 普通 evidence 给 AI 的最长字符数
MAX_CHARS_PER_EVIDENCE = 400

# 所有 evidence 给 AI 的总字符数上限
MAX_TOTAL_EVIDENCE_CHARS = 4200

# 模型回答最大 token
MAX_ANSWER_TOKENS = 1200

# 默认聊天模型
DEFAULT_CHAT_MODEL = "Qwen/Qwen3-8B"

# 系统提示词文件路径：backend/app/prompts/guide_prompt.txt
GUIDE_PROMPT_RELATIVE_PATH = Path("prompts") / "guide_prompt.txt"


# ============================================================
# 1. 基础配置
# ============================================================

def get_chat_model() -> str:
    """
    获取聊天模型。
    优先读取 .env 中的 CHAT_MODEL，没有则使用默认模型。
    """
    load_env()

    model = os.getenv("CHAT_MODEL", "").strip()

    if model:
        return model

    return DEFAULT_CHAT_MODEL


def get_app_root() -> Path:
    """
    当前文件：backend/app/core/rag.py
    app 根目录：backend/app
    """
    return Path(__file__).resolve().parents[1]


def get_guide_prompt_path() -> Path:
    return get_app_root() / GUIDE_PROMPT_RELATIVE_PATH


def read_guide_prompt() -> str:
    prompt_path = get_guide_prompt_path()

    if not prompt_path.exists():
        raise FileNotFoundError(f"系统提示词文件不存在: {prompt_path}")

    prompt = prompt_path.read_text(encoding="utf-8").strip()

    if not prompt:
        raise RuntimeError(f"系统提示词文件为空: {prompt_path}")

    return prompt


def try_build_cached_response(
    query: str,
    reason: str,
    error: Exception | None = None,
    include_debug: bool = False,
) -> dict[str, Any] | None:
    """
    调用AI失败时，查缓存，如果找到了缓存项就构造缓存回答
    """
    item = find_faq_item(query)

    if item is None:
        return None

    result = build_cache_item_response(
        item=item,
        error=error,
        include_debug=include_debug,
    )

    result.setdefault("meta", {})
    result["meta"]["cache_reason"] = reason

    return result



# 2. 文本处理工具

def normalize_space(text: str) -> str:
    text = text or ""
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def value_to_plain_text(value: Any) -> str:
    """
    把 evidence 字段转成普通文本。
    注意：这个函数会压缩换行，不用于处理模型 answer。
    """
    if value is None:
        return ""

    if isinstance(value, str):
        return normalize_space(value)

    if isinstance(value, list):
        parts: list[str] = []

        for item in value:
            text = value_to_plain_text(item)

            if text:
                parts.append(text)

        return normalize_space("；".join(parts))

    if isinstance(value, dict):
        return normalize_space(json.dumps(value, ensure_ascii=False))

    return normalize_space(str(value))


def value_to_answer_text(value: Any) -> str:
    """
    解析模型 JSON 中的 answer 字段。保留换行。
    """
    if value is None:
        return ""

    if isinstance(value, str):
        text = value.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

    return value_to_plain_text(value)


def parse_nested_answer_payload(
    answer: str,
    max_evidence_no: int,
) -> tuple[str, list[int]]:
    """
    兼容模型把完整 JSON 对象作为 answer 字符串返回的情况。
    """
    content = extract_json_object_text(answer or "")

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return answer, []

    if not isinstance(data, dict):
        return answer, []

    nested_answer = value_to_answer_text(data.get("answer", ""))
    nested_numbers = normalize_used_evidence_numbers(
        value=(
            data.get("used_evidence_numbers")
            or data.get("used_evidence")
            or data.get("evidence_numbers")
        ),
        max_evidence_no=max_evidence_no,
    )

    if not nested_answer:
        return answer, nested_numbers

    return nested_answer, nested_numbers


def decode_loose_json_string(value: str) -> str:
    """
    兼容模型输出的 JSON-like 字符串：字段值里可能直接包含换行。
    """
    return (
        value.replace('\\"', '"')
        .replace("\\n", "\n")
        .replace("\\r", "\r")
        .replace("\\t", "\t")
        .strip()
    )


def parse_loose_model_response(
    raw_content: str,
    max_evidence_no: int,
) -> tuple[str, list[int]] | None:
    """
    严格 JSON 解析失败时的兜底。
    处理形如 {"answer": "多行自然语言", "used_evidence_numbers": [1, 2]} 的非标准 JSON。
    """
    content = extract_json_object_text(raw_content or "")

    if '"answer"' not in content and "'answer'" not in content:
        return None

    answer_match = re.search(
        r"""["']answer["']\s*:\s*["']([\s\S]*?)(?=["']\s*,\s*["'](?:used_evidence_numbers|used_evidence|evidence_numbers|evidence|highlight_targets|suggested_questions|meta)["']\s*:|["']\s*\}\s*$)""",
        content,
    )

    if not answer_match:
        return None

    answer = decode_loose_json_string(answer_match.group(1))

    numbers: list[int] = []
    numbers_match = re.search(
        r"""["'](?:used_evidence_numbers|used_evidence|evidence_numbers)["']\s*:\s*(\[[^\]]*\]|["'][^"']*["']|[^\s,}]+)""",
        content,
    )
    if numbers_match:
        numbers = normalize_used_evidence_numbers(
            value=numbers_match.group(1),
            max_evidence_no=max_evidence_no,
        )

    if not answer:
        return None

    return answer, numbers


def truncate_text(text: str, max_chars: int) -> str:
    text = normalize_space(text)

    if len(text) <= max_chars:
        return text

    return text[:max_chars].rstrip() + "..."


def sanitize_internal_ids(text: str) -> str:
    """
    清理模型回答中的内部 ID。
    这里只做安全兜底，不负责改写自然语言逻辑。
    """
    text = text or ""

    replacements = [
        (r"version_[A-Za-z0-9_]+", "某一版本"),
        (r"play_[A-Za-z0-9_]+", "某一剧目"),
        (r"group_[A-Za-z0-9_]+", "该剧目组"),
        (r"cluster_[A-Za-z0-9_]+", "相关星团"),
        (r"chunk_[A-Za-z0-9_]+", "相关文本片段"),
        (r"char_[A-Za-z0-9_]+", "某一角色"),
    ]

    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text)

    return text


def postprocess_answer_text(answer: str) -> str:
    """
    模型回答后处理。
    原则： - 只清理内部 ID；
    """
    answer = sanitize_internal_ids(answer)
    return answer.strip()


def clean_display_text(text: str) -> str:
    """
    清理前端 evidence 展示文本。
    """
    text = value_to_plain_text(text)
    text = sanitize_internal_ids(text)

    text = text.replace("{", "")
    text = text.replace("}", "")
    text = text.replace("[", "")
    text = text.replace("]", "")
    text = text.replace("\"", "")
    text = text.replace("'", "")

    text = re.sub(r"\bversion_id\s*:\s*[^,，；;]+[,，；;]?", "", text)
    text = re.sub(r"\bplay_id\s*:\s*[^,，；;]+[,，；;]?", "", text)
    text = re.sub(r"\bchunk_id\s*:\s*[^,，；;]+[,，；;]?", "", text)
    text = re.sub(r"\bcluster_id\s*:\s*[^,，；;]+[,，；;]?", "", text)
    text = re.sub(r"\bplay_group_id\s*:\s*[^,，；;]+[,，；;]?", "", text)
    text = re.sub(r"\bsource_id\s*:\s*[^,，；;]+[,，；;]?", "", text)

    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"[,，；;]\s*[,，；;]+", "，", text)

    return text.strip(" ，；;:")


def build_welcome_answer(context: dict[str, Any] | None = None) -> dict[str, Any]:
    play_title = value_to_plain_text((context or {}).get("play_title"))
    cluster_name = value_to_plain_text((context or {}).get("cluster_name"))

    if play_title:
        context_line = f"我现在可以围绕《{play_title}》帮您看剧情、角色、来源、版本差异和相似剧目。"
        suggestions = [
            f"《{play_title}》的故事讲了什么？",
            f"《{play_title}》有哪些主要角色？",
            f"《{play_title}》有没有不同版本？",
        ]
    elif cluster_name:
        context_line = f"我现在可以围绕“{cluster_name}”星团说明共同主题、代表剧目和聚类依据。"
        suggestions = [
            f"{cluster_name}星团有什么共同特征？",
            f"{cluster_name}星团有哪些代表剧目？",
            f"{cluster_name}星团为什么聚在一起？",
        ]
    else:
        context_line = "您可以问我某个剧目的剧情、角色、版本差异，也可以让我推荐一个主题星团里的入门剧目。"
        suggestions = [
            "《空城计》的主要角色有哪些？",
            "我想从三国戏入门，推荐哪些剧目？",
            "包公戏有哪些共同特征？",
        ]

    answer = (
        "结论：\n"
        "您好，我是这个京剧星云图里的 AI 导览员。"
        f"{context_line}\n\n"
        "依据：\n"
        "当前这类问候不需要检索具体剧本文本，因此先给出导览入口。\n\n"
        "可继续探索：\n"
        f"1. {suggestions[0]}\n"
        f"2. {suggestions[1]}\n"
        f"3. {suggestions[2]}"
    )

    return {
        "answer": answer,
        "evidence": [],
        "highlight_targets": [],
        "suggested_questions": suggestions,
        "meta": build_meta(
            ok=True,
            fallback=False,
            evidence_count=0,
        ),
    }


def query_uses_context_reference(query: str) -> bool:
    q = normalize_space(query)
    return any(
        token in q
        for token in [
            "这个剧",
            "这部剧",
            "该剧",
            "它",
            "这个版本",
            "当前版本",
            "这个星团",
            "当前星团",
            "这个聚类",
            "当前聚类",
        ]
    )


def apply_context_to_query_info(
    query_info: dict[str, Any],
    context: dict[str, Any] | None,
) -> dict[str, Any]:
    if not context:
        return query_info

    targets = dict(query_info.get("targets") or {})
    has_direct_target = bool(
        targets.get("play_id")
        or targets.get("play_group_id")
        or targets.get("cluster_id")
    )

    should_apply = (
        not has_direct_target
        and (
            query_uses_context_reference(query_info.get("raw_query", ""))
            or not query_info.get("has_search_constraint")
        )
    )

    if not should_apply:
        return query_info

    play_id = value_to_plain_text(context.get("play_id"))
    play_group_id = value_to_plain_text(context.get("play_group_id"))
    cluster_id = value_to_plain_text(context.get("cluster_id"))
    play_title = value_to_plain_text(context.get("play_title"))
    cluster_name = value_to_plain_text(context.get("cluster_name"))

    if play_id:
        targets["play_id"] = targets.get("play_id") or play_id
    if play_group_id:
        targets["play_group_id"] = targets.get("play_group_id") or play_group_id
    if cluster_id:
        targets["cluster_id"] = targets.get("cluster_id") or cluster_id
    if play_title:
        targets["title"] = targets.get("title") or play_title
    elif cluster_name:
        targets["title"] = targets.get("title") or cluster_name

    result = dict(query_info)
    result["targets"] = targets
    result["context_applied"] = True
    result["has_direct_target"] = bool(
        targets.get("play_id")
        or targets.get("play_group_id")
        or targets.get("cluster_id")
    )
    result["has_specific_entity"] = result["has_direct_target"] or bool(result.get("has_search_constraint"))

    return result



# 3. evidence 字段读取与排序

def get_evidence_text(evidence: dict[str, Any]) -> str:
    """
    从 evidence 中抽取最适合给 AI 阅读的正文。

    优先级：
    - _prompt_text：版本摘要等专门给 AI 的文本
    - excerpt：结构化检索摘要
    - text / snippet：向量检索文本
    - evidence_raw_text / source_note：角色和来源类证据
    """
    candidate_fields = [
        "_prompt_text",
        "excerpt",
        "text",
        "snippet",
        "evidence_raw_text",
        "source_note",
    ]

    for field in candidate_fields:
        text = value_to_plain_text(evidence.get(field))

        if text:
            return text

    raw = evidence.get("raw")

    if raw:
        return value_to_plain_text(raw)

    return ""


def get_evidence_title(evidence: dict[str, Any]) -> str:
    title = (
        evidence.get("title")
        or evidence.get("canonical_title")
        or evidence.get("reference_title")
        or ""
    )

    return value_to_plain_text(title)


def get_evidence_section(evidence: dict[str, Any]) -> str:
    section = (
        evidence.get("section")
        or evidence.get("evidence_section")
        or evidence.get("scene_id")
        or evidence.get("chunk_type")
        or ""
    )

    return value_to_plain_text(section)


def is_note_evidence(evidence: dict[str, Any]) -> bool:
    chunk_type = value_to_plain_text(evidence.get("chunk_type"))
    section = get_evidence_section(evidence)

    if chunk_type == "note":
        return True

    if "注释" in section or "根据" in section:
        return True

    return False


def is_direct_target_evidence(evidence: dict[str, Any]) -> bool:
    matched_fields = evidence.get("matched_fields") or []

    if not isinstance(matched_fields, list):
        return False

    return "direct_target" in matched_fields


def has_basic_metadata(evidence: dict[str, Any]) -> bool:
    for field in [
        "title",
        "play_id",
        "play_group_id",
        "version_id",
        "chunk_id",
        "source_type",
    ]:
        if evidence.get(field):
            return True

    return False


def normalize_vector_score(score: Any) -> float:
    if not isinstance(score, (int, float)):
        return 0.0

    return float(score) * 100.0


def normalize_structured_score(score: Any) -> float:
    if not isinstance(score, (int, float)):
        return 0.0

    return float(score)


def evidence_rank_score(evidence: dict[str, Any]) -> float:
    retrieval_type = evidence.get("_retrieval_type")

    if retrieval_type == "vector":
        score = normalize_vector_score(evidence.get("score"))
    else:
        score = normalize_structured_score(evidence.get("score"))

    if is_direct_target_evidence(evidence):
        score += 80.0

    if retrieval_type == "structured":
        score += 35.0

    if has_basic_metadata(evidence):
        score += 5.0

    text = get_evidence_text(evidence)

    if len(text) < 20:
        score -= 8.0

    if is_note_evidence(evidence):
        score -= 8.0

    return score


def get_prompt_char_limit(evidence: dict[str, Any]) -> int:
    """
    不同类型 evidence 给 AI 的截断长度。
    版本差异类材料需要多保留一点，否则关键版本容易被截断。
    """
    source_type = evidence.get("source_type")

    if source_type == "version_diff_card":
        return 1100

    if source_type == "version_river":
        return 900

    if source_type == "version_matrix":
        return 500

    return MAX_CHARS_PER_EVIDENCE


def make_hashable_value(value: Any) -> Any:
    if isinstance(value, list):
        return tuple(make_hashable_value(item) for item in value)

    if isinstance(value, dict):
        return tuple(
            sorted(
                (str(key), make_hashable_value(val))
                for key, val in value.items()
            )
        )

    if isinstance(value, set):
        return tuple(sorted(make_hashable_value(item) for item in value))

    return value


def evidence_unique_key(evidence: dict[str, Any]) -> tuple[Any, ...]:
    chunk_id = evidence.get("chunk_id")

    if chunk_id:
        return ("chunk_id", chunk_id)

    source_type = evidence.get("source_type")
    play_id = evidence.get("play_id")
    play_group_id = evidence.get("play_group_id")
    version_id = evidence.get("version_id")
    scene_id = evidence.get("scene_id")
    role_name = evidence.get("role_name")

    if source_type and (play_id or play_group_id or version_id or role_name):
        return (
            "structured_key",
            make_hashable_value(source_type),
            make_hashable_value(play_id),
            make_hashable_value(play_group_id),
            make_hashable_value(version_id),
            make_hashable_value(scene_id),
            make_hashable_value(role_name),
        )

    title = get_evidence_title(evidence)
    text = get_evidence_text(evidence)

    return (
        "text_key",
        make_hashable_value(source_type),
        make_hashable_value(title),
        make_hashable_value(text[:300]),
    )


def attach_runtime_fields(
    evidence: dict[str, Any],
    retrieval_type: str,
) -> dict[str, Any]:
    item = dict(evidence)

    item["_retrieval_type"] = retrieval_type
    item["_display_text"] = get_evidence_text(item)
    item["_rank_score"] = evidence_rank_score(item)

    return item


# 4. 检索、去重、重排、截断

def collect_raw_evidence(
    query: str,
    query_info: dict[str, Any],
) -> list[dict[str, Any]]:
    """
    收集结构化 evidence 和向量 evidence。
    任一检索失败不直接导致全流程失败。
    """
    raw_evidence: list[dict[str, Any]] = []
    errors: list[str] = []

    try:
        structured_evidence = retrieve_evidence(
            query_info=query_info,
            top_k=STRUCTURED_TOP_K,
        )

        for item in structured_evidence:
            raw_evidence.append(
                attach_runtime_fields(
                    evidence=item,
                    retrieval_type="structured",
                )
            )
    except Exception as exc:
        errors.append(f"结构化检索失败：{exc}")

    try:
        vector_evidence = retrieve_vector_evidence(
            query=query,
            top_k=VECTOR_TOP_K,
        )

        for item in vector_evidence:
            raw_evidence.append(
                attach_runtime_fields(
                    evidence=item,
                    retrieval_type="vector",
                )
            )
    except Exception as exc:
        errors.append(f"向量检索失败：{exc}")

    if not raw_evidence and errors:
        raise RuntimeError("；".join(errors))

    return raw_evidence


def get_query_intent_names(query_info: dict[str, Any]) -> list[str]:
    result: list[str] = []

    for item in query_info.get("intents") or []:
        intent = item.get("intent")

        if intent and intent not in result:
            result.append(intent)

    return result or ["general"]


def evidence_matches_targets(
    evidence: dict[str, Any],
    query_info: dict[str, Any],
) -> bool:
    targets = query_info.get("targets") or {}
    play_id = value_to_plain_text(targets.get("play_id"))
    play_group_id = value_to_plain_text(targets.get("play_group_id"))
    cluster_id = value_to_plain_text(targets.get("cluster_id"))

    if not (play_id or play_group_id or cluster_id):
        return True

    evidence_play_id = value_to_plain_text(evidence.get("play_id"))
    evidence_group_id = value_to_plain_text(evidence.get("play_group_id"))
    evidence_cluster_id = value_to_plain_text(evidence.get("cluster_id"))
    intents = set(get_query_intent_names(query_info))

    if play_id and evidence_play_id == play_id:
        return True

    if play_group_id and evidence_group_id == play_group_id and "version_diff" in intents:
        return True

    if cluster_id and evidence_cluster_id == cluster_id and (
        "cluster_explain" in intents
        or "similarity_reason" in intents
        or "recommendation" in intents
    ):
        return True

    return False


def filter_evidence_for_bound_target(
    evidence_list: list[dict[str, Any]],
    query_info: dict[str, Any],
) -> list[dict[str, Any]]:
    targets = query_info.get("targets") or {}

    if not (
        targets.get("play_id")
        or targets.get("play_group_id")
        or targets.get("cluster_id")
    ):
        return evidence_list

    filtered = [
        evidence
        for evidence in evidence_list
        if evidence_matches_targets(evidence, query_info)
    ]

    if filtered:
        return filtered

    return []


def dedupe_evidence(
    evidence_list: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    best_by_key: dict[tuple[Any, ...], dict[str, Any]] = {}

    for evidence in evidence_list:
        key = evidence_unique_key(evidence)
        old = best_by_key.get(key)

        if old is None:
            best_by_key[key] = evidence
            continue

        if evidence.get("_rank_score", 0) > old.get("_rank_score", 0):
            best_by_key[key] = evidence

    return list(best_by_key.values())


def sort_evidence(
    evidence_list: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return sorted(
        evidence_list,
        key=lambda item: item.get("_rank_score", 0),
        reverse=True,
    )


def select_final_evidence(
    evidence_list: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    total_chars = 0

    for evidence in evidence_list:
        raw_text = evidence.get("_display_text") or get_evidence_text(evidence)
        text = truncate_text(raw_text, get_prompt_char_limit(evidence))

        if not text:
            continue

        remaining_chars = MAX_TOTAL_EVIDENCE_CHARS - total_chars

        if remaining_chars <= 0:
            break

        if len(text) > remaining_chars:
            if remaining_chars < 120:
                break

            text = truncate_text(text, remaining_chars)

        item = dict(evidence)
        item["_prompt_text"] = text

        selected.append(item)
        total_chars += len(text)

        if len(selected) >= FINAL_EVIDENCE_MAX:
            break

    return selected


def prepare_final_evidence(
    evidence_list: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    deduped = dedupe_evidence(evidence_list)

    for evidence in deduped:
        evidence["_rank_score"] = evidence_rank_score(evidence)

    ranked = sort_evidence(deduped)

    return select_final_evidence(ranked)



# 5. prompt 构造与模型调用

def format_metadata_line(evidence: dict[str, Any]) -> str:
    parts: list[str] = []

    retrieval_type = evidence.get("_retrieval_type")
    source_type = evidence.get("source_type")
    title = get_evidence_title(evidence)
    section = get_evidence_section(evidence)

    role_name = evidence.get("role_name")
    role_type = evidence.get("role_type")
    version_label = evidence.get("version_label")
    source_name = evidence.get("source_name")

    if retrieval_type:
        parts.append(f"检索类型：{retrieval_type}")

    if source_type:
        parts.append(f"材料类型：{source_type}")

    if title:
        parts.append(f"剧目：{title}")

    if section:
        parts.append(f"段落：{section}")

    if role_name:
        parts.append(f"角色：{value_to_plain_text(role_name)}")

    if role_type:
        parts.append(f"行当：{value_to_plain_text(role_type)}")

    if version_label:
        parts.append(f"版本：{value_to_plain_text(version_label)}")

    if source_name:
        parts.append(f"来源：{value_to_plain_text(source_name)}")

    return "；".join(parts)


def format_evidence_for_prompt(
    evidence_list: list[dict[str, Any]],
) -> str:
    """
    给 AI 的候选材料编号。
    """
    blocks: list[str] = []

    for index, evidence in enumerate(evidence_list, start=1):
        metadata_line = format_metadata_line(evidence)
        text = evidence.get("_prompt_text") or get_evidence_text(evidence)

        block = (
            f"[候选材料编号：{index}]\n"
            f"{metadata_line}\n"
            f"内容：{text}"
        )

        blocks.append(block)

    return "\n\n".join(blocks)


def build_system_prompt() -> str:
    return read_guide_prompt()


def normalize_chat_history(history: list[dict[str, str]] | None) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []

    for item in (history or [])[-6:]:
        role = str(item.get("role") or "").strip()
        content = value_to_answer_text(item.get("content") or "")

        if role not in {"user", "assistant"} or not content:
            continue

        result.append(
            {
                "role": role,
                "content": content[:500],
            }
        )

    return result


def format_chat_history(history: list[dict[str, str]] | None) -> str:
    items = normalize_chat_history(history)

    if not items:
        return ""

    lines: list[str] = []

    for item in items:
        role_label = "用户" if item["role"] == "user" else "导览员"
        lines.append(f"{role_label}：{item['content']}")

    return "\n".join(lines)


def build_context_instruction(context: dict[str, Any] | None) -> str:
    if not context:
        return ""

    parts: list[str] = []

    play_title = value_to_plain_text(context.get("play_title"))
    play_id = value_to_plain_text(context.get("play_id"))
    cluster_name = value_to_plain_text(context.get("cluster_name"))
    cluster_id = value_to_plain_text(context.get("cluster_id"))
    source_name = value_to_plain_text(context.get("source_name"))

    if play_title:
        parts.append(f"当前剧目：{play_title}")
    if play_id:
        parts.append(f"当前剧目ID：{play_id}")
    if source_name:
        parts.append(f"当前来源：{source_name}")
    if cluster_name:
        parts.append(f"当前星团：{cluster_name}")
    if cluster_id:
        parts.append(f"当前星团ID：{cluster_id}")

    if not parts:
        return ""

    return "当前前端上下文：\n" + "；".join(parts)


def build_user_prompt(
    query: str,
    evidence_list: list[dict[str, Any]],
    context: dict[str, Any] | None = None,
    history: list[dict[str, str]] | None = None,
) -> str:
    evidence_text = format_evidence_for_prompt(evidence_list)
    context_text = build_context_instruction(context)
    history_text = format_chat_history(history)
    context_block = f"{context_text}\n\n" if context_text else ""
    history_block = f"最近对话：\n{history_text}\n\n" if history_text else ""

    return (
        f"{context_block}"
        f"{history_block}"
        f"用户问题：{query}\n\n"
        f"可用证据：\n"
        f"{evidence_text}\n\n"
        "请根据以上证据回答用户问题。\n"
        "你必须输出一个 JSON 对象，包含 answer 和 used_evidence_numbers 两个字段。\n"
        "answer 字段中不要出现候选材料编号、证据编号、内部 ID 或后端实现字段。\n"
        "used_evidence_numbers 必须包含 answer 中实际使用到的所有候选材料编号。"
    )


def call_chat_model(
    query: str,
    evidence_list: list[dict[str, Any]],
    context: dict[str, Any] | None = None,
    history: list[dict[str, str]] | None = None,
) -> str:
    client = get_openai_client()
    model = get_chat_model()

    messages = [
        {
            "role": "system",
            "content": build_system_prompt(),
        },
        {
            "role": "user",
            "content": build_user_prompt(
                query=query,
                evidence_list=evidence_list,
                context=context,
                history=history,
            ),
        },
    ]

    response = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.2,
        max_tokens=MAX_ANSWER_TOKENS,
    )

    content = response.choices[0].message.content or ""

    return content.strip()


# 6. 模型 JSON 输出解析

def extract_json_object_text(raw_content: str) -> str:
    """
    提取模型输出里的 JSON 对象。
    """
    content = (raw_content or "").strip()

    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content, flags=re.I)
        content = re.sub(r"\s*```$", "", content)
        content = content.strip()

    if content.startswith("{") and content.endswith("}"):
        return content

    start = content.find("{")
    end = content.rfind("}")

    if start != -1 and end != -1 and end > start:
        return content[start:end + 1]

    return content


def normalize_used_evidence_numbers(
    value: Any,
    max_evidence_no: int,
    max_count: int = MAX_FRONTEND_EVIDENCE,
) -> list[int]:
    numbers: list[int] = []

    if value is None:
        return numbers

    if isinstance(value, list):
        raw_items = value
    elif isinstance(value, str):
        raw_items = re.findall(r"\d+", value)
    else:
        raw_items = [value]

    for item in raw_items:
        try:
            number = int(item)
        except (TypeError, ValueError):
            continue

        if number < 1 or number > max_evidence_no:
            continue

        if number not in numbers:
            numbers.append(number)

        if len(numbers) >= max_count:
            break

    return numbers


def parse_model_response(
    raw_content: str,
    max_evidence_no: int,
) -> tuple[str, list[int], bool]:
    """
    返回：
    - answer
    - used_evidence_numbers
    - structured_output
    """
    raw_content = raw_content or ""
    content = extract_json_object_text(raw_content)

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        loose = parse_loose_model_response(
            raw_content=raw_content,
            max_evidence_no=max_evidence_no,
        )
        if loose is not None:
            answer, used_numbers = loose
            return answer, used_numbers, True
        return raw_content.strip(), [], False

    if not isinstance(data, dict):
        return raw_content.strip(), [], False

    answer = value_to_answer_text(data.get("answer", ""))
    nested_answer, nested_numbers = parse_nested_answer_payload(
        answer=answer,
        max_evidence_no=max_evidence_no,
    )

    if nested_answer != answer:
        answer = nested_answer

    used_numbers = normalize_used_evidence_numbers(
        value=(
            data.get("used_evidence_numbers")
            or data.get("used_evidence")
            or data.get("evidence_numbers")
        ),
        max_evidence_no=max_evidence_no,
    )

    if not used_numbers:
        used_numbers = [
            number
            for number in nested_numbers
            if 1 <= number <= max_evidence_no
        ][:MAX_FRONTEND_EVIDENCE]

    if not answer:
        answer = raw_content.strip()

    return answer, used_numbers, True



# 7. 前端 evidence / highlight 构造

def normalize_frontend_source_type(evidence: dict[str, Any]) -> str:
    source_type = evidence.get("source_type") or evidence.get("evidence_type")

    mapping = {
        "play_summary": "play",
        "nebula_node": "play",
        "role_evidence": "role",
        "version_diff_card": "version",
        "version_river": "version",
        "version_matrix": "version",
        "text_chunk": "text_chunk",
        "vector_chunk": "text_chunk",
        "cluster_explanation": "cluster",
    }

    return mapping.get(str(source_type), str(source_type or "unknown"))


def get_frontend_source_id(evidence: dict[str, Any]) -> str:
    source_type = normalize_frontend_source_type(evidence)

    if source_type == "role":
        play_id = value_to_plain_text(evidence.get("play_id"))
        role_name = value_to_plain_text(evidence.get("role_name"))

        if play_id and role_name:
            return f"{play_id}:{role_name}"

        return play_id or role_name

    if source_type == "version":
        return (
            value_to_plain_text(evidence.get("version_id"))
            or value_to_plain_text(evidence.get("play_group_id"))
            or value_to_plain_text(evidence.get("play_id"))
        )

    if source_type == "cluster":
        return value_to_plain_text(evidence.get("cluster_id"))

    if source_type == "text_chunk":
        return (
            value_to_plain_text(evidence.get("chunk_id"))
            or value_to_plain_text(evidence.get("play_id"))
        )

    return (
        value_to_plain_text(evidence.get("play_id"))
        or value_to_plain_text(evidence.get("version_id"))
        or value_to_plain_text(evidence.get("chunk_id"))
        or value_to_plain_text(evidence.get("cluster_id"))
    )


def get_frontend_highlight_info(evidence: dict[str, Any]) -> tuple[str, str]:
    source_type = normalize_frontend_source_type(evidence)

    play_id = value_to_plain_text(evidence.get("play_id"))
    play_group_id = value_to_plain_text(evidence.get("play_group_id"))
    version_id = value_to_plain_text(evidence.get("version_id"))
    cluster_id = value_to_plain_text(evidence.get("cluster_id"))
    chunk_id = value_to_plain_text(evidence.get("chunk_id"))

    if source_type == "version":
        if version_id:
            return version_id, "version"
        if play_group_id:
            return play_group_id, "play_group"
        if play_id:
            return play_id, "play"

    if source_type == "cluster":
        if cluster_id:
            return cluster_id, "cluster"

    if source_type in {"role", "play", "text_chunk"}:
        if play_id:
            return play_id, "play"
        if version_id:
            return version_id, "version"
        if chunk_id:
            return chunk_id, "text_chunk"

    if play_id:
        return play_id, "play"

    if play_group_id:
        return play_group_id, "play_group"

    if version_id:
        return version_id, "version"

    if cluster_id:
        return cluster_id, "cluster"

    if chunk_id:
        return chunk_id, "text_chunk"

    return "", ""


def get_frontend_highlight_target(evidence: dict[str, Any]) -> str:
    target, _ = get_frontend_highlight_info(evidence)
    return target


def get_frontend_highlight_type(evidence: dict[str, Any]) -> str:
    _, target_type = get_frontend_highlight_info(evidence)
    return target_type


def build_frontend_display_text(evidence: dict[str, Any]) -> str:
    title = get_evidence_title(evidence)
    source_type = normalize_frontend_source_type(evidence)
    raw_source_type = value_to_plain_text(evidence.get("source_type"))
    source_name = value_to_plain_text(evidence.get("source_name"))
    role_name = value_to_plain_text(evidence.get("role_name"))
    role_type = value_to_plain_text(evidence.get("role_type"))
    section = get_evidence_section(evidence)
    text = value_to_plain_text(evidence.get("_prompt_text")) or get_evidence_text(evidence)

    prefix = f"《{title}》" if title else "相关证据"

    if source_type == "role":
        if role_name and role_type:
            return f"{prefix}角色证据：{role_name}（{role_type}）"

        if role_name:
            return f"{prefix}角色证据：{role_name}"

        return f"{prefix}角色证据"

    if source_type == "version":
        if raw_source_type == "version_diff_card":
            if text:
                return truncate_text(
                    f"{prefix}版本差异证据：{clean_display_text(text)}",
                    900,
                )

            return f"{prefix}版本差异证据：该剧目组包含多个版本，但当前证据未展开具体差异。"

        if raw_source_type == "version_river":
            if text:
                return truncate_text(
                    f"{prefix}版本列表证据：{clean_display_text(text)}",
                    900,
                )

            return f"{prefix}版本列表证据：该剧目组包含多个来源版本。"

        if raw_source_type == "version_matrix":
            if text:
                return truncate_text(
                    f"{prefix}版本矩阵证据：{clean_display_text(text)}",
                    500,
                )

            return f"{prefix}版本矩阵证据：该剧目组可用于比较版本差异程度。"

        if text:
            return truncate_text(
                f"{prefix}版本证据：{clean_display_text(text)}",
                300,
            )

        return f"{prefix}版本证据：该剧目组包含多个版本。"

    if source_type == "cluster":
        if text:
            return truncate_text(
                f"{prefix}星团解释：{clean_display_text(text)}",
                200,
            )

        return f"{prefix}星团解释：该星团用于说明相关剧目在主题、角色或来源上的相似关系。"

    if source_type == "play":
        parts: list[str] = []

        if source_name:
            parts.append(f"来源：{source_name}")

        if text:
            parts.append(clean_display_text(text))

        if parts:
            return truncate_text(f"{prefix}，" + "，".join(parts), 200)

        return f"{prefix}剧目信息证据"

    if source_type == "text_chunk":
        parts: list[str] = []

        if section:
            parts.append(f"段落：{section}")

        if text:
            parts.append(clean_display_text(text))

        if parts:
            return truncate_text(f"{prefix}，" + "，".join(parts), 200)

        return f"{prefix}文本片段证据"

    if text:
        return truncate_text(
            f"{prefix}，{clean_display_text(text)}",
            200,
        )

    return f"{prefix}{raw_source_type or source_type}证据"


def strip_runtime_fields(
    evidence: dict[str, Any],
    evidence_no: int,
) -> dict[str, Any]:
    return {
        "evidence_no": evidence_no,
        "source_type": normalize_frontend_source_type(evidence),
        "raw_source_type": evidence.get("source_type"),
        "source_id": get_frontend_source_id(evidence),
        "display_text": build_frontend_display_text(evidence),
        "highlight_target": get_frontend_highlight_target(evidence),
        "highlight_type": get_frontend_highlight_type(evidence),
        "title": get_evidence_title(evidence),
        "play_id": evidence.get("play_id"),
        "play_group_id": evidence.get("play_group_id"),
        "version_id": evidence.get("version_id"),
        "cluster_id": evidence.get("cluster_id"),
        "chunk_id": evidence.get("chunk_id"),
        "role_name": evidence.get("role_name"),
        "role_type": evidence.get("role_type"),
        "source_name": evidence.get("source_name"),
        "evidence_section": (
            evidence.get("evidence_section")
            or evidence.get("section")
            or evidence.get("chunk_type")
        ),
    }


def build_frontend_evidence(
    selected_evidence: list[tuple[int, dict[str, Any]]],
) -> list[dict[str, Any]]:
    return [
        strip_runtime_fields(
            evidence=item,
            evidence_no=new_number,
        )
        for new_number, (_, item) in enumerate(selected_evidence, start=1)
    ]


def build_highlight_targets(
    frontend_evidence: list[dict[str, Any]],
) -> list[dict[str, str]]:
    targets: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for item in frontend_evidence:
        target_id = value_to_plain_text(item.get("highlight_target"))
        target_type = value_to_plain_text(item.get("highlight_type"))

        if not target_id or not target_type:
            continue

        key = (target_type, target_id)

        if key in seen:
            continue

        label = (
            value_to_plain_text(item.get("title"))
            or value_to_plain_text(item.get("role_name"))
            or target_id
        )

        targets.append(
            {
                "target_id": target_id,
                "target_type": target_type,
                "label": label,
            }
        )

        seen.add(key)

    return targets


# 8. evidence 选择

def select_frontend_evidence_by_used_numbers(
    final_evidence: list[dict[str, Any]],
    used_evidence_numbers: list[int],
    max_count: int = MAX_FRONTEND_EVIDENCE,
) -> list[tuple[int, dict[str, Any]]]:
    selected: list[tuple[int, dict[str, Any]]] = []

    for number in used_evidence_numbers:
        index = number - 1

        if 0 <= index < len(final_evidence):
            selected.append((number, final_evidence[index]))

        if len(selected) >= max_count:
            break

    if selected:
        return selected

    fallback_count = min(FALLBACK_FRONTEND_EVIDENCE, len(final_evidence))

    return [
        (index, evidence)
        for index, evidence in enumerate(final_evidence[:fallback_count], start=1)
    ]



# 9. suggested_questions

def clean_question_line(line: str) -> str:
    line = normalize_space(line)
    line = re.sub(r"^[\-\*\d一二三四五六七八九十、.．\s]+", "", line)
    line = line.strip("“”\"'：: ")
    return line.strip()


def split_inline_numbered_questions(section: str) -> list[str]:
    """
    支持把：
    1. 问题一？2. 问题二？3. 问题三？
    拆成多行候选问题。
    """
    section = section.replace("\r\n", "\n").replace("\r", "\n").strip()

    section = re.sub(
        r"\s*(?=(?:[1-9]|[一二三四五六七八九十])[\.．、]\s*)",
        "\n",
        section,
    )

    parts: list[str] = []

    for line in section.splitlines():
        line = line.strip()

        if not line:
            continue

        question_parts = re.findall(r"[^？?]*[？?]", line)

        if question_parts:
            parts.extend(part.strip() for part in question_parts if part.strip())
        else:
            parts.append(line)

    return parts


def extract_suggested_questions(answer: str) -> list[str]:
    if not answer:
        return []

    match = re.search(r"可继续探索[:：]?(.*)$", answer, flags=re.S)

    if not match:
        return []

    section = match.group(1).strip()
    candidates = split_inline_numbered_questions(section)

    questions: list[str] = []

    for candidate in candidates:
        question = clean_question_line(candidate)

        if not question:
            continue

        if "？" not in question and "?" not in question:
            continue

        if question not in questions:
            questions.append(question)

        if len(questions) >= 3:
            break

    return questions


def build_fallback_suggested_questions(
    query: str,
    frontend_evidence: list[dict[str, Any]],
) -> list[str]:
    titles: list[str] = []

    for item in frontend_evidence:
        title = value_to_plain_text(item.get("title"))

        if title and title not in titles:
            titles.append(title)

    if titles:
        title = titles[0]

        return [
            f"《{title}》的故事讲了什么？",
            f"《{title}》有哪些主要角色？",
            f"和《{title}》相似的剧目有哪些？",
        ]

    return [
        "这个剧目的主要角色有哪些？",
        "这个剧目的来源是什么？",
        "有没有相似题材的剧目可以继续看？",
    ]


def build_suggested_questions(
    answer: str,
    query: str,
    frontend_evidence: list[dict[str, Any]],
) -> list[str]:
    questions = extract_suggested_questions(answer)

    if len(questions) >= 3:
        return questions[:3]

    fallback_questions = build_fallback_suggested_questions(
        query=query,
        frontend_evidence=frontend_evidence,
    )

    for question in fallback_questions:
        if question not in questions:
            questions.append(question)

        if len(questions) >= 3:
            break

    return questions[:3]


# 10. fallback 与 meta

def build_meta(
    ok: bool,
    fallback: bool,
    evidence_count: int,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "fallback": fallback,
        "evidence_count": evidence_count,
    }


def build_no_evidence_answer() -> str:
    return (
        "结论：\n"
        "当前检索到的证据不足以可靠回答这个问题。\n\n"
        "依据：\n"
        "当前没有找到与问题直接相关的可用证据。\n\n"
        "可继续探索：\n"
        "1. 请输入更明确的剧名或角色名。\n"
        "2. 试试询问某个剧目的主要角色。\n"
        "3. 试试询问某个剧目的版本差异。"
    )


def build_evidence_only_fallback_answer(
    query: str,
    frontend_evidence: list[dict[str, Any]],
) -> str:
    if not frontend_evidence:
        return build_no_evidence_answer()

    evidence_lines: list[str] = []

    for index, evidence in enumerate(frontend_evidence, start=1):
        display_text = value_to_plain_text(evidence.get("display_text"))

        if not display_text:
            continue

        evidence_lines.append(f"{index}. {display_text}")

    if not evidence_lines:
        return build_no_evidence_answer()

    return (
        "结论：\n"
        "当前 AI 生成服务暂时不可用，下面先返回系统检索到的相关证据。"
        "这些证据可以作为前端展示和图谱高亮依据，但暂不展开生成式分析。\n\n"
        "依据：\n"
        + "\n".join(evidence_lines[:MAX_FRONTEND_EVIDENCE])
        + "\n\n"
        "可继续探索：\n"
        "1. 可以稍后重新提问，尝试生成完整导览回答。\n"
        "2. 可以点击证据查看相关剧目或版本节点。\n"
        "3. 可以换一个更明确的剧名、角色名或主题继续查询。"
    )


def build_debug_info(
    query_info: dict[str, Any],
    raw_evidence: list[dict[str, Any]],
    final_evidence: list[dict[str, Any]],
    frontend_evidence: list[dict[str, Any]],
    filtered_evidence_count: int | None = None,
) -> dict[str, Any]:
    return {
        "query_info": query_info,
        "raw_evidence_count": len(raw_evidence),
        "target_filtered_evidence_count": filtered_evidence_count,
        "final_evidence_count": len(final_evidence),
        "frontend_evidence_count": len(frontend_evidence),
        "final_evidence_scores": [
            {
                "title": get_evidence_title(item),
                "source_type": item.get("source_type"),
                "retrieval_type": item.get("_retrieval_type"),
                "score": item.get("score"),
                "rank_score": item.get("_rank_score"),
                "prompt_text": item.get("_prompt_text"),
            }
            for item in final_evidence
        ],
    }


# 11. RAG 总入口

def answer_with_rag(
    query: str,
    context: dict[str, Any] | None = None,
    history: list[dict[str, str]] | None = None,
    include_debug: bool = False,
    use_cache: bool = True,
    use_cache_fallback: bool | None = None,
) -> dict[str, Any]:
    """
    RAG 问答总入口。

    参数说明：
    - use_cache：是否允许在失败时使用 FAQ 缓存兜底。
    - use_cache_fallback：兼容旧版 generate_faq_cache.py 的参数。
      如果传入该参数，则覆盖 use_cache。
    """
    query = query.strip()

    if use_cache_fallback is not None:
        use_cache = use_cache_fallback

    if not query:
        answer = (
            "结论：\n"
            "请输入需要查询的问题。\n\n"
            "依据：\n"
            "当前没有用户问题，因此无法检索证据。\n\n"
            "可继续探索：\n"
            "1. 试试询问《空城计》的主要角色。\n"
            "2. 试试询问《宇宙锋》的版本差异。\n"
            "3. 试试询问三国戏入门推荐。"
        )

        return {
            "answer": answer,
            "evidence": [],
            "highlight_targets": [],
            "suggested_questions": [
                "《空城计》的主要角色有哪些？",
                "《宇宙锋》的几个版本有什么不同？",
                "我想从三国戏入门，推荐哪些剧目？",
            ],
            "meta": build_meta(
                ok=False,
                fallback=False,
                evidence_count=0,
            ),
        }

    query_info = understand_query(query)

    if query_info.get("is_greeting_only"):
        result = build_welcome_answer(context=context)

        if include_debug:
            result["debug"] = {
                "query_info": query_info,
                "context": context or {},
            }

        return result

    query_info = apply_context_to_query_info(
        query_info=query_info,
        context=context,
    )

    try:
        raw_evidence = collect_raw_evidence(
            query=query,
            query_info=query_info,
        )
    except Exception as exc:
        if use_cache:
            cached_result = try_build_cached_response(
                query=query,
                reason="retrieval_error",
                error=exc,
                include_debug=include_debug,
            )

            if cached_result is not None:
                return cached_result

        raw_evidence = []

    target_filtered_evidence = filter_evidence_for_bound_target(
        evidence_list=raw_evidence,
        query_info=query_info,
    )
    final_evidence = prepare_final_evidence(target_filtered_evidence)

    if not final_evidence:
        if use_cache:
            cached_result = try_build_cached_response(
                query=query,
                reason="no_evidence",
                include_debug=include_debug,
            )

            if cached_result is not None:
                return cached_result

        answer = build_no_evidence_answer()
        frontend_evidence: list[dict[str, Any]] = []
        suggested_questions = build_suggested_questions(
            answer=answer,
            query=query,
            frontend_evidence=frontend_evidence,
        )

        result: dict[str, Any] = {
            "answer": answer,
            "evidence": frontend_evidence,
            "highlight_targets": [],
            "suggested_questions": suggested_questions,
            "meta": build_meta(
                ok=False,
                fallback=False,
                evidence_count=0,
            ),
        }

        if include_debug:
            result["debug"] = build_debug_info(
                query_info=query_info,
                raw_evidence=raw_evidence,
                final_evidence=final_evidence,
                frontend_evidence=frontend_evidence,
            )

        return result

    try:
        raw_model_content = call_chat_model(
            query=query,
            evidence_list=final_evidence,
            context=context,
            history=history,
        )

        answer, used_evidence_numbers, _structured_output = parse_model_response(
            raw_content=raw_model_content,
            max_evidence_no=len(final_evidence),
        )

        answer = postprocess_answer_text(answer)

    except Exception as exc:
        if use_cache:
            cached_result = try_build_cached_response(
                query=query,
                reason="chat_api_error",
                error=exc,
                include_debug=include_debug,
            )

            if cached_result is not None:
                return cached_result

        selected_frontend_evidence = [
            (index, evidence)
            for index, evidence in enumerate(
                final_evidence[:FALLBACK_FRONTEND_EVIDENCE],
                start=1,
            )
        ]

        frontend_evidence = build_frontend_evidence(selected_frontend_evidence)

        answer = build_evidence_only_fallback_answer(
            query=query,
            frontend_evidence=frontend_evidence,
        )

        result = {
            "answer": answer,
            "evidence": frontend_evidence,
            "highlight_targets": build_highlight_targets(frontend_evidence),
            "suggested_questions": build_suggested_questions(
                answer=answer,
                query=query,
                frontend_evidence=frontend_evidence,
            ),
            "meta": build_meta(
                ok=True,
                fallback=True,
                evidence_count=len(frontend_evidence),
            ),
        }

        result["meta"]["cache_hit"] = False
        result["meta"]["fallback_reason"] = str(exc)

        if include_debug:
            result["debug"] = build_debug_info(
                query_info=query_info,
                raw_evidence=raw_evidence,
                final_evidence=final_evidence,
                frontend_evidence=frontend_evidence,
            )

        return result

    selected_frontend_evidence = select_frontend_evidence_by_used_numbers(
        final_evidence=final_evidence,
        used_evidence_numbers=used_evidence_numbers,
        max_count=MAX_FRONTEND_EVIDENCE,
    )

    frontend_evidence = build_frontend_evidence(selected_frontend_evidence)

    suggested_questions = build_suggested_questions(
        answer=answer,
        query=query,
        frontend_evidence=frontend_evidence,
    )

    result = {
        "answer": answer,
        "evidence": frontend_evidence,
        "highlight_targets": build_highlight_targets(frontend_evidence),
        "suggested_questions": suggested_questions,
        "meta": build_meta(
            ok=True,
            fallback=False,
            evidence_count=len(frontend_evidence),
        ),
    }

    if include_debug:
        result["debug"] = build_debug_info(
            query_info=query_info,
            raw_evidence=raw_evidence,
            final_evidence=final_evidence,
            frontend_evidence=frontend_evidence,
        )

    return result
