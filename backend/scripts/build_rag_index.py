from __future__ import annotations

import argparse
import json
import os
import shutil
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

import faiss
import numpy as np
from dotenv import load_dotenv
from openai import OpenAI


def find_project_root() -> Path:
    """
    当前文件位置：
    backend/scripts/build_rag_index.py

    parents[1] 是 backend 根目录。
    """
    return Path(__file__).resolve().parents[1]


def load_env(project_root: Path) -> None:
    env_path = project_root / ".env"

    if env_path.exists():
        load_dotenv(env_path)
        print(f"[INFO] loaded env   = {env_path}")
    else:
        print(f"[WARN] .env not found: {env_path}")


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def read_text_chunks(input_path: Path) -> list[dict[str, Any]]:
    """
    支持三种输入：
    1. text_chunks.json
    2. v3_final 目录，目录里有 text_chunks.json
    3. zip，zip 里包含 text_chunks.json
    """

    if input_path.is_file() and input_path.suffix.lower() == ".json":
        data = read_json(input_path)
        if not isinstance(data, list):
            raise ValueError(f"{input_path} 不是 list 格式")
        return data

    if input_path.is_dir():
        chunk_path = input_path / "text_chunks.json"
        if not chunk_path.exists():
            raise FileNotFoundError(f"目录中找不到 text_chunks.json: {chunk_path}")

        data = read_json(chunk_path)
        if not isinstance(data, list):
            raise ValueError(f"{chunk_path} 不是 list 格式")
        return data

    if input_path.is_file() and input_path.suffix.lower() == ".zip":
        with zipfile.ZipFile(input_path, "r") as z:
            names = z.namelist()

            candidates = [
                name
                for name in names
                if name.replace("\\", "/").endswith("text_chunks.json")
            ]

            if not candidates:
                raise FileNotFoundError(f"ZIP 中找不到 text_chunks.json: {input_path}")

            candidates.sort(key=len)
            target_name = candidates[0]

            data = json.loads(z.read(target_name).decode("utf-8"))
            if not isinstance(data, list):
                raise ValueError(f"{target_name} 不是 list 格式")
            return data

    raise ValueError(f"不支持的输入路径: {input_path}")


def as_list_text(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, list):
        return "、".join(str(x) for x in value if x is not None)

    if isinstance(value, dict):
        return "；".join(f"{k}: {v}" for k, v in value.items())

    return str(value)


def build_embedding_text(chunk: dict[str, Any], max_chars: int = 2800) -> str:
    """
    构造送入 embedding 模型的文本。

    不只放正文，也放剧名、角色、主题、关键词、来源等信息，
    这样用户问角色、主题、来源时，也更容易召回正确片段。
    """

    evidence = chunk.get("evidence") or {}

    title = chunk.get("title") or ""
    chunk_type = chunk.get("chunk_type") or ""
    scene_id = chunk.get("scene_id") or evidence.get("section") or ""
    role_names = as_list_text(chunk.get("role_names"))
    themes = as_list_text(chunk.get("themes"))
    keywords = as_list_text(chunk.get("keywords"))
    source_note = chunk.get("source_note") or evidence.get("source_note") or ""
    text = chunk.get("text") or ""

    parts = [
        f"剧名：{title}",
        f"片段类型：{chunk_type}",
        f"章节：{scene_id}",
        f"角色：{role_names}",
        f"主题：{themes}",
        f"关键词：{keywords}",
        f"来源：{source_note}",
        f"正文：{text}",
    ]

    final_text = "\n".join(part for part in parts if part.strip())

    if len(final_text) > max_chars:
        final_text = final_text[:max_chars]

    return final_text


def build_metadata(chunk: dict[str, Any], row_id: int) -> dict[str, Any]:
    """
    FAISS 只保存向量，不保存原文。
    metadata.jsonl 用来记录每个向量对应哪一条 chunk。
    """

    evidence = chunk.get("evidence") or {}

    return {
        "row_id": row_id,
        "chunk_id": chunk.get("chunk_id"),
        "play_id": chunk.get("play_id"),
        "play_group_id": chunk.get("play_group_id"),
        "version_id": chunk.get("version_id"),
        "source_id": chunk.get("source_id"),
        "title": chunk.get("title"),
        "chunk_type": chunk.get("chunk_type"),
        "scene_id": chunk.get("scene_id"),
        "chunk_order": chunk.get("chunk_order"),
        "role_names": chunk.get("role_names") or [],
        "character_keys": chunk.get("character_keys") or [],
        "themes": chunk.get("themes") or [],
        "keywords": chunk.get("keywords") or [],
        "text": chunk.get("text") or "",
        "text_length": chunk.get("text_length"),
        "source_note": chunk.get("source_note") or evidence.get("source_note"),
        "evidence": evidence,
        "evidence_section": evidence.get("section"),
        "evidence_page": evidence.get("page"),
    }


def make_client() -> OpenAI:
    api_key = os.getenv("SILICONFLOW_API_KEY", "").strip()
    base_url = os.getenv("SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1").strip()

    if not api_key:
        raise RuntimeError("SILICONFLOW_API_KEY 为空，请先在 backend/.env 中填写。")

    return OpenAI(
        api_key=api_key,
        base_url=base_url,
    )


def embed_batch(
    client: OpenAI,
    model: str,
    texts: list[str],
    retry: int = 3,
    sleep_seconds: float = 5.0,
) -> list[list[float]]:
    """
    批量调用 embedding API。
    如果网络、限流临时失败，会自动重试。
    """

    last_error: Exception | None = None

    for attempt in range(1, retry + 1):
        try:
            response = client.embeddings.create(
                model=model,
                input=texts,
            )

            return [item.embedding for item in response.data]

        except Exception as exc:
            last_error = exc
            wait = sleep_seconds * attempt
            print(f"[WARN] embedding failed, attempt={attempt}/{retry}: {exc}")
            print(f"[INFO] wait {wait}s before retry")
            time.sleep(wait)

    raise RuntimeError(f"embedding 失败: {last_error}")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def ensure_output_dir(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    if not out_dir.exists():
        raise RuntimeError(f"输出目录创建失败: {out_dir}")

    if not out_dir.is_dir():
        raise RuntimeError(f"输出路径不是目录: {out_dir}")


def safe_write_faiss_index(index: faiss.Index, target_path: Path) -> None:
    """
    Windows 下 FAISS 对中文路径可能不稳定。
    先写到纯英文临时目录，再移动到目标目录。
    英文路径也可以正常使用这个函数。
    """

    target_path.parent.mkdir(parents=True, exist_ok=True)

    tmp_dir = Path("C:/faiss_tmp")
    tmp_dir.mkdir(parents=True, exist_ok=True)

    tmp_path = tmp_dir / f"{uuid.uuid4().hex}.index"

    print(f"[INFO] faiss temp path = {tmp_path}")

    faiss.write_index(index, str(tmp_path))
    shutil.move(str(tmp_path), str(target_path))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build FAISS RAG index from text_chunks.json"
    )

    parser.add_argument(
        "--input",
        required=True,
        help="text_chunks.json、v3_final 目录，或包含 text_chunks.json 的 zip",
    )

    parser.add_argument(
        "--out",
        required=True,
        help="输出索引目录，例如 vector_indexes/rag_chunks_bge_m3",
    )

    parser.add_argument(
        "--batch-size",
        type=int,
        default=32,
        help="embedding 批大小",
    )

    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="调试用。0 表示全量；20 表示只建前 20 条。",
    )

    parser.add_argument(
        "--sleep",
        type=float,
        default=0.0,
        help="每个 embedding batch 后暂停秒数，避免 TPM 限流。",
    )

    args = parser.parse_args()

    project_root = find_project_root()
    load_env(project_root)

    input_path = Path(args.input)
    if not input_path.is_absolute():
        input_path = project_root / input_path

    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = project_root / out_dir

    ensure_output_dir(out_dir)

    model = os.getenv("EMBEDDING_MODEL", "").strip()
    if not model:
        raise RuntimeError("EMBEDDING_MODEL 为空，请先在 backend/.env 中填写。")

    print(f"[INFO] project_root = {project_root}")
    print(f"[INFO] input        = {input_path}")
    print(f"[INFO] out_dir      = {out_dir}")
    print(f"[INFO] out exists   = {out_dir.exists()}")
    print(f"[INFO] model        = {model}")
    print(f"[INFO] batch_size   = {args.batch_size}")
    print(f"[INFO] sleep        = {args.sleep}")

    chunks = read_text_chunks(input_path)

    if args.limit and args.limit > 0:
        chunks = chunks[: args.limit]

    print(f"[INFO] chunks       = {len(chunks)}")

    if not chunks:
        raise RuntimeError("text_chunks.json 中没有可索引的数据。")

    texts = [build_embedding_text(chunk) for chunk in chunks]
    metadata = [build_metadata(chunk, row_id=i) for i, chunk in enumerate(chunks)]

    client = make_client()

    all_vectors: list[list[float]] = []

    for start in range(0, len(texts), args.batch_size):
        end = min(start + args.batch_size, len(texts))
        batch = texts[start:end]

        print(f"[INFO] embedding {start + 1}-{end} / {len(texts)}")

        vectors = embed_batch(
            client=client,
            model=model,
            texts=batch,
        )

        all_vectors.extend(vectors)

        if args.sleep > 0 and end < len(texts):
            print(f"[INFO] sleep {args.sleep}s to avoid rate limit")
            time.sleep(args.sleep)

    embeddings = np.array(all_vectors, dtype="float32")

    if embeddings.ndim != 2:
        raise RuntimeError(f"embedding 结果维度异常: {embeddings.shape}")

    if embeddings.shape[0] != len(metadata):
        raise RuntimeError(
            f"向量数量和 metadata 数量不一致: "
            f"vectors={embeddings.shape[0]}, metadata={len(metadata)}"
        )

    # 归一化后，用 IndexFlatIP 做内积检索，等价于余弦相似度检索。
    faiss.normalize_L2(embeddings)

    dim = embeddings.shape[1]

    index = faiss.IndexFlatIP(dim)
    index.add(embeddings)

    ensure_output_dir(out_dir)

    index_path = out_dir / "chunks.index"
    metadata_path = out_dir / "metadata.jsonl"
    embeddings_path = out_dir / "embeddings.npy"
    config_path = out_dir / "config.json"

    print(f"[INFO] writing index    = {index_path}")
    print(f"[INFO] writing metadata = {metadata_path}")
    print(f"[INFO] writing vectors  = {embeddings_path}")
    print(f"[INFO] writing config   = {config_path}")
    print(f"[INFO] out_dir exists   = {out_dir.exists()}")

    safe_write_faiss_index(index, index_path)
    write_jsonl(metadata_path, metadata)
    np.save(embeddings_path, embeddings)

    config = {
        "index_type": "faiss.IndexFlatIP",
        "metric": "cosine_by_inner_product",
        "embedding_model": model,
        "dim": int(dim),
        "count": int(len(metadata)),
        "input": str(input_path),
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "files": {
            "index": "chunks.index",
            "metadata": "metadata.jsonl",
            "embeddings": "embeddings.npy",
        },
    }

    with config_path.open("w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

    print("[OK] index built")
    print(f"[OK] count = {len(metadata)}")
    print(f"[OK] dim   = {dim}")
    print(f"[OK] out   = {out_dir}")


if __name__ == "__main__":
    main()