//! 词库板块（glossary_app）：2026-11-08 新建。
//!
//! kb（知识库）作为**通用板块**由 cap-glossary crate 承载，本板块是它在 file 里的
//! 落地：一套可手动增删改查的「词条」词库，加上检索与带引用的问答。
//!
//! 前后端分工：
//! - 核心算法（切片/BM25/引用拼装/词条存取）全在 `cap-glossary`；
//! - 本板块只做三件事：**落盘**（词条 JSON）、**薄命令层**、把问答接到 file 的
//!   AI 链路（复用 `crate::ai::ai_chat`）。
//!
//! 与 worker_app / mind_app 同构：命令在主 `invoke_handler` 注册，`attach` 只
//! manage 状态。

pub mod commands; // 命令从主 invoke_handler 注册，须 pub 否则 lib.rs 引用不到
pub mod store;

pub use store::GlossaryState;

/// 把词库板块的状态挂到 file 的 Tauri builder 上。
///
/// 命令**不在这里注册**，而是全部放在 file lib.rs 的主 invoke_handler 里
/// （同一个 Tauri 宏展开一次，避免重复 `__cmd__` 静态量）。
pub fn attach(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    // 启动时从磁盘载入词库；之后再增删改由命令各自落盘。
    let store = GlossaryState(std::sync::Mutex::new(store::load_store()));
    builder.manage(store)
}