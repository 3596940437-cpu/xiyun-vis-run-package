from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


# 让脚本可以从 backend/scripts 正确导入 app
BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))


from app.core.cache import DEMO_QUESTIONS, FAQ_CACHE_PATH, save_faq_cache
from app.core.rag import answer_with_rag


def build_cache_item(
    question: str,
    result: dict[str, Any],
) -> dict[str, Any]:
    """
    把一次正常 RAG + API 的结果整理成 faq_cache.json 的单条缓存。
    """
    return {
        "question": question,
        "aliases": [],
        "answer": result.get("answer", ""),
        "evidence": result.get("evidence", []),
        "highlight_targets": result.get("highlight_targets", []),
        "suggested_questions": result.get("suggested_questions", []),
    }


def main() -> None:
    items: list[dict[str, Any]] = []

    for index, question in enumerate(DEMO_QUESTIONS, start=1):
        print(f"[{index}/{len(DEMO_QUESTIONS)}] 正在生成：{question}")

        result = answer_with_rag(
            query=question,
            include_debug=False,
            use_cache_fallback=False,
        )

        evidence = result.get("evidence", [])
        if not evidence:
            print(f"警告：该问题没有 evidence，需要人工检查：{question}")

        item = build_cache_item(
            question=question,
            result=result,
        )

        items.append(item)

    save_faq_cache(items)

    print()
    print("缓存生成完成：")
    print(FAQ_CACHE_PATH)


if __name__ == "__main__":
    main()