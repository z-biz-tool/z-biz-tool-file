//! 知识检索：解析稿的 BM25 切片检索 + 带引用问答。
//!
//! 核心算法全在 cap-glossary（与词库板块同一套 tokenize / 切片 / 引用口径）：
//! 每次查询时把目标库的全部已解析解析稿摊成 Chunk 语料、现建 BM25 索引再查。
//! 单机几千篇以内的库，现建索引是毫秒级开销，换来零索引维护成本 ——
//! 这与 future-brain 的 Milvus 向量层是两条路线：本地先落地「能查到、能溯源」，
//! 向量检索留给后续接 embedding 服务时再上。

use cap_glossary::{chunk_markdown, to_citations, Bm25Index, Chunk, Citation, DEFAULT_MAX_CHARS};

use crate::kb_app::store::{self, KbIndex, STATUS_PARSED};

/// 检索命中：定位回物料 + 可展示的片段。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchHit {
    pub material_id: String,
    pub title: String,
    /// 目录路径（根 → 叶），空数组表示未分类
    pub category_path: Vec<String>,
    /// 命中片段正文（已截到 240 字符左右）
    pub snippet: String,
    /// 相对相关度 0~1
    pub score: f64,
}

/// 把一个库里全部已解析稿摊成语料。chunk.path 存 material_id，
/// 这样引用/命中都能直接跳回物料详情。
pub fn build_corpus(index: &KbIndex, kb_id: &str) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    for material in index.materials_of(kb_id) {
        if material.parse_status != STATUS_PARSED {
            continue;
        }
        let draft = store::draft_path(&material.id);
        let Ok(content) = std::fs::read_to_string(&draft) else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        chunks.extend(chunk_markdown(
            &material.id,
            &material.title,
            &content,
            DEFAULT_MAX_CHARS,
        ));
    }
    chunks
}

/// BM25 检索，返回前 top_k 条命中。
pub fn search(index: &KbIndex, kb_id: &str, query: &str, top_k: usize) -> Vec<SearchHit> {
    let query = query.trim();
    if query.is_empty() {
        return vec![];
    }
    let chunks = build_corpus(index, kb_id);
    if chunks.is_empty() {
        return vec![];
    }
    // Bm25Index 的 chunks 是私有字段，命中下标对齐输入顺序 —— 语料副本按序取回片段。
    let own = chunks.clone();
    let bm25 = Bm25Index::build(chunks);
    let hits = bm25.search(query, top_k.clamp(1, 50), None);
    let max_score = hits.iter().map(|(_, s)| *s).fold(0.0_f64, f64::max);

    hits.iter()
        .map(|(chunk_idx, score)| {
            let chunk = &own[*chunk_idx];
            let material_id = chunk.path.clone();
            let (title, category_path) = match index.material(&material_id) {
                Some(mat) => (
                    mat.title.clone(),
                    index.category_path(kb_id, mat.category_id.as_deref()),
                ),
                None => (chunk.title.clone(), vec![]),
            };
            SearchHit {
                material_id,
                title,
                category_path,
                snippet: truncate_snippet(&chunk.text, 240),
                score: if max_score > 0.0 {
                    score / max_score
                } else {
                    0.0
                },
            }
        })
        .collect()
}

/// 问答的引用列表（与检索同源，供 kb_ask 组 prompt）。
pub fn citations_for_ask(
    index: &KbIndex,
    kb_id: &str,
    question: &str,
    top_k: usize,
) -> (Vec<Citation>, usize) {
    let chunks = build_corpus(index, kb_id);
    let total_chunks = chunks.len();
    if total_chunks == 0 {
        return (vec![], 0);
    }
    let bm25 = Bm25Index::build(chunks);
    let hits = bm25.search(question, top_k, None);
    let citations = to_citations(&bm25, &hits);
    (citations, total_chunks)
}

fn truncate_snippet(text: &str, max_chars: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        text.chars().take(max_chars).collect::<String>() + "…"
    }
}
