"""
RAG 工具层
负责：
1. 文本标准化
2. 从项目 JSON 自动抽取重要词并加入 jieba
3. 用户问题分词与 terms 提取
4. intent 判断
5. filters 识别
6. 字段打分
7. evidence 统一格式
"""

from __future__ import annotations
import re
from typing import Any
import jieba
from app.core.loader import store


# 1. 文本标准化
def normalize_text(value: Any) -> str:
    if value is None:
        return ""

    text = str(value).strip()

    replace_map = {
        "（": "(",
        "）": ")",
        "【": "[",
        "】": "]",
        "“": "\"",
        "”": "\"",
        "‘": "'",
        "’": "'",
        "　": " ",
    }

    for old, new in replace_map.items():
        text = text.replace(old, new)

    text = re.sub(r"\s+", " ", text)
    return text.lower()


def normalize_for_match(value: Any) -> str:
    text = normalize_text(value)
    text = text.replace("《", "").replace("》", "")

    text = re.sub(
        r"[，。！？、；：,.!?;:()\[\]{}\"'<>《》\-_/\\|]",
        "",
        text,
    )

    return text.replace(" ", "")


def short_text(value: Any, max_len: int = 220) -> str:
    if value is None:
        return ""

    text = str(value).replace("\n", " ").strip()
    text = re.sub(r"\s+", " ", text)

    if len(text) <= max_len:
        return text

    return text[:max_len] + "..."


#读嵌套字段
def get_by_path(record: dict[str, Any], path: str) -> Any:
    if path == "__all__":
        return record

    current: Any = record

    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)

    return current


#统一处理不同字段类型
def value_to_text(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, str):
        return normalize_for_match(value)

    if isinstance(value, list):
        return normalize_for_match(" ".join(value_to_text(v) for v in value))

    if isinstance(value, dict):
        parts: list[str] = []
        for k, v in value.items():
            parts.append(value_to_text(k))
            parts.append(value_to_text(v))
        return normalize_for_match(" ".join(parts))

    return normalize_for_match(str(value))



# 2. 项目词表：从 JSON 自动抽取

#把一个词放入项目词表
def add_project_term(
    term_map: dict[str, dict[str, Any]],
    word: Any,
    category: str,
):
    if word is None:
        return

    if isinstance(word, list):
        for item in word:
            add_project_term(term_map, item, category)
        return

    if isinstance(word, dict):
        name = word.get("name")
        if name:
            add_project_term(term_map, name, category)
        return

    word_text = str(word).strip()

    if not word_text:
        return

    # 普通单字容易误命中，但行当单字可保留。
    if len(word_text) == 1 and word_text not in {"净", "丑"}:
        return

    norm = normalize_for_match(word_text)

    if not norm:
        return

    item = term_map.setdefault(
        norm,
        {
            "word": word_text,
            "normalized": norm,
            "categories": set(),
        },
    )

    item["categories"].add(category)


#处理剧名变体
def add_title_variants(term_map: dict[str, dict[str, Any]], title: Any):
    if title is None:
        return

    if isinstance(title, list):
        for item in title:
            add_title_variants(term_map, item)
        return

    if isinstance(title, dict):
        if title.get("name"):
            add_title_variants(term_map, title.get("name"))
            return

        for item in title.values():
            add_title_variants(term_map, item)
        return

    title_text = str(title).strip()
    if not title_text:
        return

    add_project_term(term_map, title_text, "title")

    cleaned = title_text.replace("《", "").replace("》", "")

    for mark in ["全本", "前本", "后本", "头本", "二本", "三本", "上本", "下本"]:
        cleaned = cleaned.replace(mark, "")

    cleaned = cleaned.strip()

    if cleaned and cleaned != title_text:
        add_project_term(term_map, cleaned, "title")


def build_project_term_map() -> dict[str, dict[str, Any]]:
    """
    从项目数据自动抽取 jieba 补充词表。
    - 这里只放用户可能输入、且 jieba 可能切不好的专有词。
    - 不把所有证据文本、内部 ID、统计字段都加入词表。
    - A 负责基础对象词。
    - B 只补 A 没有的分析词，避免重复。
    """
    term_map: dict[str, dict[str, Any]] = {}

    def extract_name_list(value: Any) -> list[str]:
        result: list[str] = []

        if not value:
            return result

        if isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    name = item.get("name")
                    if name:
                        result.append(str(name))
                elif isinstance(item, str):
                    result.append(item)

        elif isinstance(value, dict):
            name = value.get("name")
            if name:
                result.append(str(name))

        elif isinstance(value, str):
            result.append(value)

        return result

    # A：基础剧名和别名
    for play in getattr(store, "plays", []):
        add_title_variants(term_map, play.get("title"))
        add_title_variants(term_map, play.get("title_clean"))
        add_title_variants(term_map, play.get("title_aliases"))

        add_project_term(term_map, play.get("plot_keywords"), "theme")
        add_project_term(term_map, play.get("character_keywords"), "role")

    # A：文本片段里的剧名、情节关键词、角色名
    for chunk in getattr(store, "text_chunks", []):
        add_title_variants(term_map, chunk.get("title"))

        add_project_term(term_map, chunk.get("keywords"), "theme")
        add_project_term(term_map, chunk.get("role_names"), "role")

    # A 的 roles.json 按字段说明主要提供 evidence 和 scene 字段，
    # 不用于构建 jieba 项目词表。

    # B：只补 A 没有的来源名和行当词
    for node in getattr(store, "nebula_nodes", []):
        add_project_term(term_map, node.get("source_name"), "source")

        role_type_counts = node.get("role_type_counts") or {}
        if isinstance(role_type_counts, dict):
            add_project_term(term_map, list(role_type_counts.keys()), "role_type")

    # B：只补星团分析专有词
    for item in getattr(store, "cluster_explanations", []):
        add_project_term(term_map, item.get("cluster_name"), "theme")

        evidence = item.get("evidence") or {}

        add_project_term(
            term_map,
            extract_name_list(evidence.get("top_genealogy_tags")),
            "theme",
        )
        add_project_term(
            term_map,
            extract_name_list(evidence.get("top_motif_tags")),
            "theme",
        )


    return term_map


#后端一启动就会构建项目词表
PROJECT_TERM_MAP = build_project_term_map()


def best_category(categories: set[str]) -> str:
    order = ["title", "role", "role_type", "theme", "source", "rule", "jieba"]
    for category in order:
        if category in categories:
            return category
    return "jieba"


def setup_jieba_words():
    """
    把项目词加入 jieba，让 jieba 不容易把剧名、角色名切碎。
    """
    for item in PROJECT_TERM_MAP.values():
        word = item["word"]
        category = best_category(item["categories"])

        if len(str(word).strip()) >= 2:
            jieba.add_word(str(word), freq=200000, tag=category)


setup_jieba_words()


# 3. intent 规则词

RULE_GROUPS: dict[str, dict[str, Any]] = {
    "version_diff": {
        "words": ["版本", "差异", "不同", "变化", "差别", "对比", "异同"],
        "intent": "version_diff",
    },
    "cluster_explain": {
        "words": ["星团", "聚在一起", "聚类", "为什么聚"],
        "intent": "cluster_explain",
    },
    "role_fact": {
        "words": ["角色", "人物", "脚色", "行当", "正旦", "花旦", "老生", "小生", "老旦", "武生", "武旦", "青衣", "刀马旦"],
        "intent": "role_fact",
    },
    "recommendation": {
        "words": ["推荐", "入门", "新手", "初学者", "适合", "先看", "从哪里开始"],
        "intent": "recommendation",
    },
    "similarity_reason": {
        "words": ["相近", "相似", "靠近", "为什么近", "类似", "同类"],
        "intent": "similarity_reason",
    },
    "plot_summary": {
        "words": ["情节", "剧情", "故事", "讲什么", "摘要"],
        "intent": "plot_summary",
    },
    "source_fact": {
        "words": ["来源", "根据", "整理", "版本来源", "出处"],
        "intent": "source_fact",
    },
}


STOP_WORDS = {
    "的", "了", "吗", "呢", "啊", "呀", "吧", "嘛",
    "和", "与", "及", "以及", "在", "是", "有",
    "这个", "那个", "这些", "那些", "它", "他们", "她们", "它们",
    "什么", "为什么", "怎么", "如何", "哪些", "哪里", "多少",
    "请问", "请", "帮我", "帮", "告诉我", "讲讲", "说说",
    "我想", "想", "可以", "能不能", "能否", "有没有",
    "一下", "一点", "相关", "有关",
}


GREETING_WORDS = {
    "你好",
    "您好",
    "嗨",
    "在吗",
    "在不在",
    "哈哈",
    "哈哈哈",
    "呵呵",
    "嘿嘿",
    "测试",
    "test",
    "随便看看",
    "hello",
    "hi",
}


CASUAL_ONLY_PATTERNS = [
    re.compile(r"^(哈|呵|嘿|嗨|啊|嗯|哦|额|呃|嘻|hi|hello)+$", re.IGNORECASE),
    re.compile(r"^(test|testing)+$", re.IGNORECASE),
]


# 4. 用户问题分词和 terms 提取
# 优先抽取书名号里的剧名
def extract_titles_in_brackets(query: str) -> list[str]:
    titles = re.findall(r"《(.+?)》", query)
    result: list[str] = []

    for title in titles:
        title = title.strip()
        if title and title not in result:
            result.append(title)

    return result


# 给 jieba 切出来的词分类
def classify_word(word: str) -> dict[str, Any]:
    norm = normalize_for_match(word)

    if not norm:
        return {}

    if norm in PROJECT_TERM_MAP:
        item = PROJECT_TERM_MAP[norm]
        category = best_category(item["categories"])

        return {
            "word": item["word"],
            "normalized": norm,
            "category": category,
            "source": "project_term_map",
        }

    return {
        "word": word,
        "normalized": norm,
        "category": "jieba",
        "source": "jieba",
    }


# 直接扫整句话，从中找规则词
def match_rule_keywords(query: str) -> list[dict[str, Any]]:
    q = normalize_for_match(query)
    result: list[dict[str, Any]] = []

    for group_name, config in RULE_GROUPS.items():
        for word in config["words"]:
            norm = normalize_for_match(word)

            if norm and norm in q:
                result.append({
                    "word": word,
                    "normalized": norm,
                    "category": "rule",
                    "rule_group": group_name,
                    "source": "rule_group",
                })

    return result


def extract_query_terms(query: str) -> list[dict[str, Any]]:
    """
    1. 先抽书名号剧名。
    2. 用 jieba 分词。
    3. 对分词结果分类。
    4. 补充规则词。
    5. 去停用词、去重。
    """
    terms: list[dict[str, Any]] = []

    # 1. 书名号剧名最高优先级
    for title in extract_titles_in_brackets(query):
        terms.append({
            "word": title,
            "normalized": normalize_for_match(title),
            "category": "title",
            "source": "bracket_title",
        })

    # 2. jieba 分词
    cut_words = jieba.lcut(query, cut_all=False)

    for word in cut_words:
        word = word.strip()

        if not word:
            continue

        norm = normalize_for_match(word)

        if not norm:
            continue

        if norm in STOP_WORDS:
            continue

        # 过滤单个普通字
        if len(norm) == 1 and norm not in {"净", "丑"}:
            continue

        terms.append(classify_word(word))

    # 3. 补充规则词，避免 jieba 没切出“从哪里开始”这类短语
    terms.extend(match_rule_keywords(query))

    # 4. raw_query 兜底
    if not terms:
        q = normalize_for_match(query)
        if q:
            terms.append({
                "word": query,
                "normalized": q,
                "category": "raw_query",
                "source": "fallback",
            })

    # 5. 去重
    result: list[dict[str, Any]] = []
    index_by_norm: dict[str, int] = {}

    for item in terms:
        norm = item.get("normalized", "")

        if not norm:
            continue

        if item.get("category") != "raw_query" and norm in STOP_WORDS:
            continue

        if norm not in index_by_norm:
            index_by_norm[norm] = len(result)
            result.append(item)
            continue

        old = result[index_by_norm[norm]]

        if item.get("rule_group") and not old.get("rule_group"):
            old["rule_group"] = item["rule_group"]

        if old.get("category") == "jieba" and item.get("category") == "rule":
            old["category"] = "rule"
            old["source"] = item.get("source", old.get("source"))

    result.sort(
        key=lambda x: len(x.get("normalized", "")),
        reverse=True,
    )

    return result


def get_rule_groups_by_term(term: dict[str, Any]) -> list[str]:
    """
    判断一个 term 属于哪些规则组。
    这里既看 term 自带的 rule_group，
    也根据 term.normalized 去 RULE_GROUPS 里重新查一次。
    """
    groups: list[str] = []

    direct_group = term.get("rule_group")

    if direct_group:
        groups.append(direct_group)

    norm = term.get("normalized", "")

    if not norm:
        return groups

    for group_name, config in RULE_GROUPS.items():
        for word in config["words"]:
            if normalize_for_match(word) == norm and group_name not in groups:
                groups.append(group_name)

    return groups


#判断用户问题类型
def detect_intents(
    terms: list[dict[str, Any]],
    top_k: int = 3,
) -> list[dict[str, Any]]:
    """
    判断用户问题可能包含的多个问题类型。
    - 默认返回前 top_k 个 intent。
    """
    scores: dict[str, int] = {}

    for term in terms:
        category = term.get("category")

        if category in {"role", "role_type"}:
            scores["role_fact"] = scores.get("role_fact", 0) + 1

        if category == "source":
            scores["source_fact"] = scores.get("source_fact", 0) + 1

        groups = get_rule_groups_by_term(term)

        if not groups:
            continue

        for group in groups:
            intent_name = RULE_GROUPS[group]["intent"]
            scores[intent_name] = scores.get(intent_name, 0) + 1

    if not scores:
        return [
            {
                "intent": "general",
                "score": 0,
            }
        ]

    ranked = sorted(
        scores.items(),
        key=lambda x: x[1],
        reverse=True,
    )

    return [
        {
            "intent": intent_name,
            "score": score,
        }
        for intent_name, score in ranked[:top_k]
    ]


#函数识别限制条件：排除某主题、要求多版本
def detect_filters(query: str, terms: list[dict[str, Any]]) -> dict[str, Any]:
    q = normalize_for_match(query)

    filters: dict[str, Any] = {
        "exclude_themes": [],
        "require_multi_version": False,
    }

    for term in terms:
        if term.get("category") == "theme":
            theme = term.get("word")
            norm_theme = term.get("normalized", "")

            if (
                f"不要{norm_theme}" in q
                or f"非{norm_theme}" in q
                or f"不是{norm_theme}" in q
                or f"除了{norm_theme}" in q
                or f"不考虑{norm_theme}" in q
                or f"排除{norm_theme}" in q
            ):
                filters["exclude_themes"].append(theme)

    if any(x in q for x in ["多版本", "多个版本", "版本多"]):
        filters["require_multi_version"] = True

    return filters


# 5. targets 补全
#根据剧名去找节点：精确匹配+包含匹配
def find_node_by_title(title: str) -> dict[str, Any] | None:
    target = normalize_for_match(title)

    if not target:
        return None

    for node in getattr(store, "nebula_nodes", []):
        for field in ["title", "title_clean"]:
            value = node.get(field)
            if value and normalize_for_match(value) == target:
                return node

    for node in getattr(store, "nebula_nodes", []):
        for field in ["title", "title_clean"]:
            value = node.get(field)
            if value and target in normalize_for_match(value):
                return node

    return None


def title_value_matches(value: Any, target: str) -> bool:
    if value is None:
        return False

    if isinstance(value, list):
        for item in value:
            if title_value_matches(item, target):
                return True
        return False

    norm = normalize_for_match(value)

    if not norm:
        return False

    return norm == target or target in norm


def find_play_by_title(title: str) -> dict[str, Any] | None:
    target = normalize_for_match(title)

    if not target:
        return None

    # 精确匹配
    for play in getattr(store, "plays", []):
        for field in ["title", "title_clean", "title_aliases"]:
            value = play.get(field)
            if value and title_value_matches(value, target):
                return play

    return None


#补全目标对象，只根据用户问题里明确出现的剧名补全
def resolve_targets(
    terms: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    根据用户问题中明确出现的剧名，补全 play_id / play_group_id / cluster_id。
    如果用户问题里没有明确剧名，则不默认绑定任何对象。
    """
    targets = {
        "play_id": None,
        "play_group_id": None,
        "cluster_id": None,
        "title": None,
        "unresolved_title": None,
    }

    title_terms = [t for t in terms if t.get("category") == "title"]

    if not title_terms:
        return targets

    for term in title_terms:
        title = term.get("word")

        if not title:
            continue

        targets["unresolved_title"] = title

        node = find_node_by_title(title)

        if node:
            targets["play_id"] = node.get("play_id")
            targets["play_group_id"] = node.get("play_group_id")
            targets["cluster_id"] = node.get("cluster_id")
            targets["title"] = node.get("title") or title
            return targets

        play = find_play_by_title(title)

        if play:
            targets["play_id"] = play.get("play_id")
            targets["play_group_id"] = play.get("play_group_id")
            targets["title"] = play.get("title") or title
            return targets

    return targets


def has_direct_target(targets: dict[str, Any]) -> bool:
    """
    判断是否有可以直接定位数据的目标。

    有这些 ID，后续就可以做定向证据检索：
    - play_id
    - play_group_id
    - cluster_id
    """
    return bool(
        targets.get("play_id")
        or targets.get("play_group_id")
        or targets.get("cluster_id")
    )


def has_search_constraint(terms: list[dict[str, Any]]) -> bool:
    """
    判断用户问题里是否有可以用于泛关键词检索的条件。

    这些词不一定能定位到一个具体剧目，
    但可以限制检索范围
    """
    for term in terms:
        if term.get("category") in {"title", "role", "role_type", "theme", "source"}:
            return True

    return False


# 判断用户问题里有没有具体对象
def has_specific_entity(
    terms: list[dict[str, Any]],
    targets: dict[str, Any],
) -> bool:
    """
    True 表示：
    - 要么有 direct target，可以做定向检索；
    - 要么有 search constraint，可以做泛关键词检索。
    """
    return has_direct_target(targets) or has_search_constraint(terms)


def is_greeting_only(query: str) -> bool:
    q = normalize_for_match(query)
    if not q:
        return False

    if q in {normalize_for_match(word) for word in GREETING_WORDS}:
        return True

    return any(pattern.match(q) for pattern in CASUAL_ONLY_PATTERNS)


def understand_query(
    query: str,
) -> dict[str, Any]:
    terms = extract_query_terms(query)
    intents = detect_intents(terms, top_k=3)
    filters = detect_filters(query, terms)
    targets = resolve_targets(terms)

    direct_target = has_direct_target(targets)
    search_constraint = has_search_constraint(terms)

    return {
        "raw_query": query,
        "normalized_query": normalize_for_match(query),
        "is_greeting_only": is_greeting_only(query),
        "intents": intents,
        "terms": terms,
        "targets": targets,
        "filters": filters,

        "has_direct_target": direct_target,
        "has_search_constraint": search_constraint,
        "has_specific_entity": direct_target or search_constraint,
    }


# 6. 打分与 evidence 格式
def is_search_term(term: dict[str, Any]) -> bool:
    """
    判断一个 term 是否应该参与证据字段打分。
    rule / raw_query / jieba 普通词不直接参与打分，
    """
    return term.get("category") in {
        "title",
        "role",
        "role_type",
        "theme",
        "source",
    }


def score_value(
    value: Any,
    terms: list[dict[str, Any]],
    field_weight: int,
) -> tuple[int, list[str]]:
    text = value_to_text(value)

    score = 0
    matched_terms: list[str] = []

    for term in terms:
        if not is_search_term(term):
            continue

        norm = term.get("normalized", "")

        if not norm:
            continue

        if norm in text:
            score += field_weight
            matched_terms.append(term.get("word", norm))

    return score, matched_terms


def score_record(
    record: dict[str, Any],
    terms: list[dict[str, Any]],
    field_weights: dict[str, int],
) -> tuple[int, list[str], list[str]]:
    total_score = 0
    matched_terms: list[str] = []
    matched_fields: list[str] = []

    for field, field_weight in field_weights.items():
        value = get_by_path(record, field)
        field_score, field_terms = score_value(value, terms, field_weight)

        if field_score > 0:
            total_score += field_score
            matched_fields.append(field)
            matched_terms.extend(field_terms)

    return (
        total_score,
        list(dict.fromkeys(matched_terms)),
        list(dict.fromkeys(matched_fields)),
    )


def evidence_from_record(
    source_type: str,
    record: dict[str, Any],
    score: int,
    matched_terms: list[str],
    matched_fields: list[str],
    excerpt_value: Any,
) -> dict[str, Any]:
    evidence = record.get("evidence") or {}

    return {
        "source_type": source_type,
        "title": (
            record.get("title")
            or record.get("title_clean")
            or record.get("canonical_title")
            or record.get("play_title")
            or record.get("cluster_name")
        ),
        "play_id": record.get("play_id"),
        "play_group_id": record.get("play_group_id"),
        "cluster_id": record.get("cluster_id"),
        "version_id": record.get("version_id"),
        "chunk_id": record.get("chunk_id"),
        "scene_id": record.get("scene_id"),
        "role_name": (
            record.get("role_name")
            or record.get("role_name_clean")
            or record.get("role_names")
        ),
        "role_type": (
            record.get("role_type")
            or record.get("raw_role_type")
            or record.get("base_role_type")
            or record.get("role_type_family")
        ),
        "excerpt": short_text(excerpt_value, max_len=240),
        "source_note": (
            record.get("source_note")
            or evidence.get("source_note")
        ),
        "evidence_section": evidence.get("section"),
        "score": score,
        "matched_terms": matched_terms,
        "matched_fields": matched_fields,
    }



def direct_evidence_from_data(
    source_type: str,
    data: Any,
    score: int,
    title: str | None = None,
    play_id: str | None = None,
    play_group_id: str | None = None,
    cluster_id: str | None = None,
) -> dict[str, Any] | None:
    if not data:
        return None

    if not isinstance(data, dict):
        data = {"value": data}

    evidence = data.get("evidence") or {}

    return {
        "source_type": source_type,
        "title": (
            title
            or data.get("title")
            or data.get("title_clean")
            or data.get("canonical_title")
            or data.get("play_title")
            or data.get("cluster_name")
        ),
        "play_id": play_id or data.get("play_id"),
        "play_group_id": play_group_id or data.get("play_group_id"),
        "cluster_id": cluster_id or data.get("cluster_id"),
        "version_id": data.get("version_id"),
        "chunk_id": data.get("chunk_id"),
        "scene_id": data.get("scene_id"),
        "role_name": (
            data.get("role_name")
            or data.get("role_name_clean")
            or data.get("role_names")
        ),
        "role_type": (
            data.get("role_type")
            or data.get("raw_role_type")
            or data.get("base_role_type")
            or data.get("role_type_family")
        ),
        "excerpt": short_text(data, max_len=260),
        "source_note": (
            data.get("source_note")
            or evidence.get("source_note")
        ),
        "evidence_section": evidence.get("section"),
        "score": score,
        "matched_terms": [],
        "matched_fields": ["direct_target"],
    }
