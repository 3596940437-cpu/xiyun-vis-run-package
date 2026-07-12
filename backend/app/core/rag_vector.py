from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from dotenv import load_dotenv
from openai import OpenAI


@dataclass
class VectorStore:
    """
    向量索引运行时对象。

    index:
        归一化后的文本向量矩阵，只负责相似向量检索。

    metadata:
        每个向量对应的文本片段信息。
        向量行号对应 metadata 中同一位置的剧名、chunk_id 和正文。

    config:
        config.json 里的索引配置。
        里面会记录 embedding_model、dim、count 等。

    index_dir:
        当前向量索引所在目录。
    """

    index: np.ndarray
    metadata: list[dict[str, Any]]
    config: dict[str, Any]
    index_dir: Path


_VECTOR_STORE: VectorStore | None = None
_CLIENT: OpenAI | None = None


def get_project_root() -> Path:
    """
    获取 backend 根目录。

    当前文件路径：
        backend/app/core/rag_vector.py

    parents[0] = backend/app/core
    parents[1] = backend/app
    parents[2] = backend

    所以 backend 根目录是 parents[2]。
    """

    return Path(__file__).resolve().parents[2]


def load_env() -> None:
    """
    加载 backend/.env。
    这里主要读取：
        SILICONFLOW_API_KEY
        SILICONFLOW_BASE_URL
        EMBEDDING_MODEL
    """
    root = get_project_root()
    env_path = root / ".env"

    if env_path.exists():
        load_dotenv(env_path)


def get_index_dir() -> Path:
    """
    获取向量索引目录。
    当前固定为：
        backend/vector_indexes/rag_chunks_bge_m3

    这个目录里应该包含：
        metadata.jsonl
        config.json
        embeddings.npy
    """
    root = get_project_root()
    return root / "vector_indexes" / "rag_chunks_bge_m3"


def read_json(path: Path) -> dict[str, Any]:
    """
    读取 JSON 文件。
    """

    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    """
    读取 JSONL 文件。

    metadata.jsonl 格式：
        一行一个 JSON 对象。
        第 N 行对应 FAISS 里的第 N 个向量。
    """

    rows: list[dict[str, Any]] = []

    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()

            if not line:
                continue

            rows.append(json.loads(line))

    return rows


def load_vector_store(force_reload: bool = False) -> VectorStore:
    """
    加载向量索引。
    第一次调用时会从磁盘读取：
        chunks.index
        metadata.jsonl
        config.json
    后续调用会复用内存中的 _VECTOR_STORE，避免每次检索都重新加载索引。
    参数：
        force_reload:
            开发调试用。
            如果重新生成了索引，又不想重启后端，可以传 True 强制重新加载。
    """

    global _VECTOR_STORE

    if _VECTOR_STORE is not None and not force_reload:
        return _VECTOR_STORE

    load_env()

    index_dir = get_index_dir()

    embeddings_path = index_dir / "embeddings.npy"
    metadata_path = index_dir / "metadata.jsonl"
    config_path = index_dir / "config.json"

    if not embeddings_path.exists():
        raise FileNotFoundError(f"向量文件不存在: {embeddings_path}")

    if not metadata_path.exists():
        raise FileNotFoundError(f"metadata.jsonl 不存在: {metadata_path}")

    if not config_path.exists():
        raise FileNotFoundError(f"config.json 不存在: {config_path}")

    index = np.load(embeddings_path)
    metadata = read_jsonl(metadata_path)
    config = read_json(config_path)

    if index.ndim != 2:
        raise RuntimeError(f"向量文件维度错误: expected 2D, got {index.ndim}D")

    if index.shape[0] != len(metadata):
        raise RuntimeError(
            "向量数量和 metadata 数量不一致："
            f"vectors={index.shape[0]}, metadata={len(metadata)}"
        )

    _VECTOR_STORE = VectorStore(
        index=index,
        metadata=metadata,
        config=config,
        index_dir=index_dir,
    )

    return _VECTOR_STORE


def get_openai_client() -> OpenAI:
    """
    创建 SiliconFlow 的 OpenAI-compatible 客户端。

    调用 embedding 接口：
        client.embeddings.create(...)
    """

    global _CLIENT

    if _CLIENT is not None:
        return _CLIENT

    load_env()

    api_key = os.getenv("SILICONFLOW_API_KEY", "").strip()
    base_url = os.getenv(
        "SILICONFLOW_BASE_URL",
        "https://api.siliconflow.cn/v1",
    ).strip()

    if not api_key:
        raise RuntimeError("SILICONFLOW_API_KEY 为空，请检查 backend/.env")
    # 缓存 API 客户端，不用每次检索都重新创建
    _CLIENT = OpenAI(
        api_key=api_key,
        base_url=base_url,
    )

    return _CLIENT


def get_embedding_model(store: VectorStore | None = None) -> str:
    """
    获取检索时使用的 embedding 模型名。
    优先读取：
        vector_indexes/rag_chunks_bge_m3/config.json 里的 embedding_model
    如果 config.json 没有，再读取：
        backend/.env 里的 EMBEDDING_MODEL
    """

    if store is None:
        store = load_vector_store()

    model = store.config.get("embedding_model")

    if not model:
        model = os.getenv("EMBEDDING_MODEL", "").strip()

    if not model:
        raise RuntimeError("找不到 embedding_model，请检查 config.json 或 .env")

    return model


def embed_query(query_text: str) -> np.ndarray:
    """
    把用户问题转换成查询向量。
    注意：
        建索引时已做 L2 归一化，查询向量也必须做同样处理。
        查询向量也必须做同样的 normalize_L2。
    """

    store = load_vector_store()
    client = get_openai_client()
    model = get_embedding_model(store)

    response = client.embeddings.create(
        model=model,
        input=[query_text],
    )

    query_vector = np.array(
        [response.data[0].embedding],
        dtype="float32",
    )

    norm = np.linalg.norm(query_vector, axis=1, keepdims=True)
    if np.any(norm == 0):
        raise RuntimeError("embedding 接口返回了零向量，无法进行相似度检索。")

    query_vector = query_vector / norm

    return query_vector


def build_query_text(query: str) -> str:
    """
    构造最终送入 embedding 模型的查询文本。

    当前版本要求用户问题尽量明确，例如带上剧名、角色名或具体主题。
    因此这里不处理 current_context，也不处理 targets。
    """

    return query.strip()


def short_text(text: str, max_chars: int = 500) -> str:
    """
    截断长文本，生成前端展示用 snippet。

    evidence 里会同时返回：
        text: 原始完整文本
        snippet: 截断后的短文本
    """

    text = text or ""
    text = text.replace("\n", " ").strip()

    if len(text) <= max_chars:
        return text

    return text[:max_chars] + "..."


def metadata_to_evidence(
    meta: dict[str, Any],
    score: float,
    rank: int,
) -> dict[str, Any]:
    """
    把 metadata 转成统一 evidence 格式。
    """

    section = (
        meta.get("evidence_section")
        or meta.get("scene_id")
        or meta.get("chunk_type")
    )

    text = meta.get("text") or ""

    return {
        "source_type": "vector_chunk",
        "evidence_type": "text_chunk",

        "rank": rank,
        "score": float(score),

        "chunk_id": meta.get("chunk_id"),
        "play_id": meta.get("play_id"),
        "play_group_id": meta.get("play_group_id"),
        "version_id": meta.get("version_id"),
        "source_id": meta.get("source_id"),

        "title": meta.get("title"),
        "section": section,
        "chunk_type": meta.get("chunk_type"),
        "scene_id": meta.get("scene_id"),
        "chunk_order": meta.get("chunk_order"),

        "roles": meta.get("role_names") or [],
        "role_names": meta.get("role_names") or [],
        "character_keys": meta.get("character_keys") or [],
        "themes": meta.get("themes") or [],
        "keywords": meta.get("keywords") or [],

        "source_note": meta.get("source_note"),

        "text": text,
        "snippet": short_text(text, max_chars=500),

        "raw": meta,
    }


def retrieve_vector_evidence(
    query: str,
    top_k: int = 8,
    fetch_k: int | None = None,
) -> list[dict[str, Any]]:
    """
    向量检索主函数。

    用法：
        retrieve_vector_evidence("空城计有哪些主要角色？", top_k=8)

    参数：
        query:
            用户问题字符串。当前版本要求问题尽量明确。

        top_k:
            最终返回多少条 evidence。

        fetch_k:
            先从 FAISS 取多少条结果。
            当前版本不做上下文过滤，所以一般不需要传。

    返回：
        list[dict]
        每个 dict 是一条 evidence。
    """

    store = load_vector_store()

    query_text = build_query_text(query)

    if not query_text:
        return []

    if fetch_k is None:
        search_k = top_k
    else:
        search_k = max(fetch_k, top_k)

    search_k = min(search_k, store.index.shape[0])

    if search_k <= 0:
        return []

    query_vector = embed_query(query_text)
    scores = store.index @ query_vector[0]
    ids = np.argsort(-scores)[:search_k]

    results: list[dict[str, Any]] = []

    for rank, idx in enumerate(ids, start=1):
        if idx < 0:
            continue

        meta = store.metadata[int(idx)]

        evidence = metadata_to_evidence(
            meta=meta,
            score=float(scores[int(idx)]),
            rank=rank,
        )

        results.append(evidence)

        if len(results) >= top_k:
            break

    return results[:top_k]


def reload_vector_store() -> VectorStore:
    """
    开发调试用：强制重新加载向量索引。

    适用场景：
        你重新生成了 chunks.index / metadata.jsonl，
        但 FastAPI 服务没有重启。

    调用这个函数可以刷新内存中的索引。
    """

    return load_vector_store(force_reload=True)
