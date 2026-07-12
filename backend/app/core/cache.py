'''
读缓存，写缓存，查缓存，包装缓存返回
'''

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
EXACT_MATCH_SCORE = 0.995
FALLBACK_MATCH_SCORE = 0.66

BACKEND_ROOT = Path(__file__).resolve().parents[2]
FAQ_CACHE_PATH = BACKEND_ROOT / "ai_assets" / "faq_cache.json"


DEMO_QUESTIONS = [
    "《宇宙锋》的几个版本有什么不同？",
    "《空城计》的主要角色有哪些？",
    "赵艳容为什么常被标为正旦？",
    "我想从三国戏入门，推荐哪些剧目？",
    "梅兰芳相关剧本在数据集中有哪些？",
    "《二进宫》不同版本的角色有什么变化？",
    "哪些剧目同时涉及“忠义”和“战争”主题？",
    "包公戏有哪些共同特征？",
    "《打渔杀家》的来源有哪些？",
    "旦角为主的剧目有哪些特点？",
]


def normalize_question(text: str) -> str:
    text = text or ""
    text = text.strip()

    replace_map = {
        "？": "?",
        "！": "!",
        "，": ",",
        "。": ".",
        "；": ";",
        "：": ":",
        "（": "(",
        "）": ")",
        "“": "\"",
        "”": "\"",
        "‘": "'",
        "’": "'",
    }

    for old, new in replace_map.items():
        text = text.replace(old, new)

    text = re.sub(r"\s+", "", text)
    text = text.strip("?.!。？！")
    return text.lower()


def load_faq_cache() -> list[dict[str, Any]]:
    if not FAQ_CACHE_PATH.exists():
        return []

    with FAQ_CACHE_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, list):
        return data

    return []


def save_faq_cache(items: list[dict[str, Any]]) -> None:
    FAQ_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)

    with FAQ_CACHE_PATH.open("w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def find_faq_item(query: str) -> dict[str, Any] | None:
    query_norm = normalize_question(query)

    if not query_norm:
        return None

    for item in load_faq_cache():
        candidates = [item.get("question", "")]

        aliases = item.get("aliases", [])
        if isinstance(aliases, list):
            candidates.extend(aliases)

        for candidate in candidates:
            if normalize_question(str(candidate)) == query_norm:
                return item

    return None


def build_cached_response(
    item: dict[str, Any],
    error: Exception | None = None,
    include_debug: bool = False,
) -> dict[str, Any]:
    evidence = item.get("evidence") or []
    highlight_targets = item.get("highlight_targets") or []
    suggested_questions = item.get("suggested_questions") or []

    result: dict[str, Any] = {
        "answer": item.get("answer", ""),
        "evidence": evidence,
        "highlight_targets": highlight_targets,
        "suggested_questions": suggested_questions,
        "meta": {
            "ok": True,
            "fallback": True,
            "fallback_type": "faq_cache",
            "evidence_count": len(evidence),
            "cache_question": item.get("question", ""),
        },
    }

    if error is not None:
        result["meta"]["fallback_reason"] = str(error)

    if include_debug:
        result["debug"] = {
            "used_cache": True,
            "cache_question": item.get("question", ""),
            "error": str(error) if error else "",
        }

    return result