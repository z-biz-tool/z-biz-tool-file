//! 词库板块的命令层：词条 CRUD / 检索 / 问答。
//!
//! 检索 file 内容的入口不在本文件 —— 词库板块的「检索 file」直接复用 file 已有的
//! `indexer_search_content`（见 indexer.rs），前端各调各的。

use cap_glossary::{
    chunk_markdown, to_citations, Bm25Index, Citation, Chunk, GlossaryTerm, DEFAULT_MAX_CHARS,
    DEFAULT_TOP_K, SYSTEM_PROMPT,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::glossary_app::store::{save_store, GlossaryState};

/// 新增/覆盖词条请求体。id 为空时后端生成 uuid。
#[derive(Debug, Deserialize)]
pub struct GlossaryTermInput {
    pub id: Option<String>,
    pub term: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 词条视图（前端列表用；与 cap_glossary::GlossaryTerm 同构）
#[derive(Debug, Serialize)]
pub struct GlossaryTermView {
    pub id: String,
    pub term: String,
    pub content: String,
    pub tags: Vec<String>,
    pub updated_at: i64,
}

impl From<&GlossaryTerm> for GlossaryTermView {
    fn from(t: &GlossaryTerm) -> Self {
        Self {
            id: t.id.clone(),
            term: t.term.clone(),
            content: t.content.clone(),
            tags: t.tags.clone(),
            updated_at: t.updated_at,
        }
    }
}

/// 问答结果：答案 + 引用列表。
#[derive(Debug, Serialize)]
pub struct AskResult {
    pub answer: String,
    pub citations: Vec<Citation>,
}

/// 列表（按词名排序）。
#[tauri::command]
pub fn glossary_list(
    _app: AppHandle,
    state: State<'_, GlossaryState>,
) -> Result<Vec<GlossaryTermView>, String> {
    let store = state.0.lock().unwrap();
    Ok(store.list().iter().map(GlossaryTermView::from).collect())
}

/// 检索词条（cap-glossary 同一套 tokenize 口径）。
#[tauri::command]
pub fn glossary_search(
    _app: AppHandle,
    state: State<'_, GlossaryState>,
    query: String,
    top_n: usize,
) -> Result<Vec<GlossaryTermView>, String> {
    let store = state.0.lock().unwrap();
    let hits = store.search(&query, top_n.min(100));
    Ok(hits.iter().map(|t| GlossaryTermView::from(*t)).collect())
}

/// 词条数 + 标签分布（前端做筛选/概览）。
#[tauri::command]
pub fn glossary_stats(
    _app: AppHandle,
    state: State<'_, GlossaryState>,
) -> Result<(usize, std::collections::HashMap<String, usize>), String> {
    let store = state.0.lock().unwrap();
    Ok((store.len(), store.tag_counts()))
}

/// 新增/覆盖一个词条并落盘。
#[tauri::command]
pub fn glossary_upsert(
    _app: AppHandle,
    state: State<'_, GlossaryState>,
    input: GlossaryTermInput,
) -> Result<GlossaryTermView, String> {
    let term = input.term.trim();
    if term.is_empty() {
        return Err("词条名不能为空".to_string());
    }
    let id = input.id.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        uuid::Uuid::new_v4().to_string()
    });
    let now = chrono::Utc::now().timestamp_millis();

    let mut store = state.0.lock().unwrap();
    let view = {
        let entry = GlossaryTerm {
            id: id.clone(),
            term: term.to_string(),
            content: input.content,
            tags: input.tags,
            updated_at: now,
        };
        store.upsert(entry).map_err(|e| format!("保存词条失败: {}", e))?;
        // upsert 后取回（能直接拿到刚写入的）
        store
            .get(&id)
            .map(GlossaryTermView::from)
            .ok_or_else(|| "保存词条后无法读取".to_string())?
    };
    save_store(&store)?;
    Ok(view)
}

/// 删除一个词条并落盘。
#[tauri::command]
pub fn glossary_remove(
    _app: AppHandle,
    state: State<'_, GlossaryState>,
    id: String,
) -> Result<(), String> {
    let mut store = state.0.lock().unwrap();
    if !store.remove(&id) {
        return Err("词条不存在".to_string());
    }
    save_store(&store)
}

/// 在词库语料上问答（带引用）。检索不到证据时直接给兜底话术，不调模型。
#[tauri::command]
pub async fn glossary_ask(
    app: AppHandle,
    state: State<'_, GlossaryState>,
    question: String,
) -> Result<AskResult, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("问题不能为空".to_string());
    }

    // 从锁里取出词条快照，避免持锁期间做耗时的模型调用。
    let terms: Vec<GlossaryTerm> = {
        let store = state.0.lock().unwrap();
        store.list().to_vec()
    };

    let corpus_chunks = terms.len();
    if corpus_chunks == 0 {
        return Ok(AskResult {
            answer: cap_glossary::no_evidence_message(0, false),
            citations: vec![],
        });
    }

    // 把词条摊成一个可检索语料：每词一条片段（词名作标题/路径，内容作正文）。
    let chunks: Vec<Chunk> = terms
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let mut c = chunk_markdown("词典", &t.term, &t.content, DEFAULT_MAX_CHARS)
                .into_iter()
                .next()
                .unwrap_or(Chunk {
                    path: "词典".to_string(),
                    title: t.term.clone(),
                    idx: i,
                    heading: t.term.clone(),
                    anchor: t.term.clone(),
                    text: t.content.clone(),
                });
            c.idx = i; // 稳定排序下标
            c
        })
        .collect();
    let index = Bm25Index::build(chunks);
    let hits = index.search(&question, DEFAULT_TOP_K, None);
    if hits.is_empty() {
        return Ok(AskResult {
            answer: cap_glossary::no_evidence_message(corpus_chunks, false),
            citations: vec![],
        });
    }

    let citations = to_citations(&index, &hits);
    let user = cap_glossary::build_user_message(&question, &citations);
    let answer = crate::ai::ai_chat(app, SYSTEM_PROMPT.to_string(), user).await?;

    Ok(AskResult { answer, citations })
}