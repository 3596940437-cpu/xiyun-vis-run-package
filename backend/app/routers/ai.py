from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.rag import answer_with_rag


router = APIRouter()


class ChatRequest(BaseModel):
    """
    AI 问答请求体。
    """
    message: str = Field(
        ...,
        min_length=1,
        description="用户输入的问题",
    )
    include_debug: bool = Field(
        False,
        description="是否返回调试信息",
    )
    context: dict[str, Any] | None = Field(
        None,
        description="当前前端上下文，例如剧目、星团或选中节点",
    )
    history: list[dict[str, str]] = Field(
        default_factory=list,
        description="最近几轮对话历史",
    )


def normalize_message(message: str) -> str:
    """
    规范用户输入的问题。
    """
    return message.strip()


def build_error_detail(prefix: str, exc: Exception) -> str:
    """
    构造接口错误信息。
    """
    message = str(exc).strip()

    if message:
        return f"{prefix}：{message}"

    return prefix


@router.post("/chat")
def chat(request: ChatRequest) -> dict[str, Any]:

    message = normalize_message(request.message)

    if not message:
        raise HTTPException(
            status_code=400,
            detail="message 不能为空",
        )

    try:
        result = answer_with_rag(
            query=message,
            context=request.context,
            history=request.history,
            include_debug=request.include_debug,
        )

        return result

    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=500,
            detail=build_error_detail(
                prefix="提示词文件不存在",
                exc=exc,
            ),
        ) from exc

    except RuntimeError as exc:
        raise HTTPException(
            status_code=500,
            detail=build_error_detail(
                prefix="AI 问答配置错误",
                exc=exc,
            ),
        ) from exc

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=build_error_detail(
                prefix="AI 问答失败",
                exc=exc,
            ),
        ) from exc
