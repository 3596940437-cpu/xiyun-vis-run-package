"""
统一管理路径、数据版本和 AI 配置
"""

from pathlib import Path
import os
from dotenv import load_dotenv


def find_data_root() -> Path:

    current_file = Path(__file__).resolve()

    for parent in current_file.parents:
        candidate = parent / "data" / "derived"

        if candidate.exists() and candidate.is_dir():
            return candidate

    raise RuntimeError(
        "找不到 data/derived 目录。请确认项目结构是：/data 和 /backend 同级。"
    )


def find_env_file() -> Path | None:

    current_file = Path(__file__).resolve()

    for parent in current_file.parents:
        candidate = parent / ".env"

        if candidate.exists() and candidate.is_file():
            return candidate

    return None


def find_prompt_file() -> Path:

    current_file = Path(__file__).resolve()

    for parent in current_file.parents:
        candidate = parent / "app" / "prompts" / "guide_prompt.txt"

        if candidate.exists() and candidate.is_file():
            return candidate

    raise RuntimeError(
        "找不到 app/prompts/guide_prompt.txt。请确认提示词文件是否已创建。"
    )


#读取 .env

ENV_FILE = find_env_file()

if ENV_FILE:
    load_dotenv(ENV_FILE)


# 数据路径配置 

DATA_VERSION = os.getenv("DATA_VERSION", "v3_final")

DATA_ROOT = find_data_root()

DERIVED_DIR = DATA_ROOT / DATA_VERSION

if not DERIVED_DIR.exists():
    raise RuntimeError(
        f"找不到当前数据版本目录：{DERIVED_DIR}。请确认 DATA_VERSION={DATA_VERSION} 是否正确。"
    )


# AI 配置 

SILICONFLOW_API_KEY = os.getenv("SILICONFLOW_API_KEY", "")

SILICONFLOW_BASE_URL = os.getenv(
    "SILICONFLOW_BASE_URL",
    "https://api.siliconflow.cn/v1"
)

CHAT_MODEL = os.getenv("CHAT_MODEL", "")

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "")

RERANK_MODEL = os.getenv("RERANK_MODEL", "")


# 提示词路径 

GUIDE_PROMPT_PATH = find_prompt_file()