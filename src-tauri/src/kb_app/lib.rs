//! 知识库板块（kb_app）：本地知识中枢。
//!
//! 交互形态整体移植自 future-brain 知识中台（fe_future-brain 的 knowledge-base 页），
//! 落地成 file 活动栏上的一个本地板块：
//!
//! - **资料**：目录 + 条目混排树（状态徽标：待解析/解析中/已解析/解析失败），
//!   右侧条目详情（解析稿查看/编辑/重新解析 + 基本信息）；
//! - **导入**：本地文件/目录、语雀（token → 仓库 → TOC 勾选 → 拉正文）、纯文本登记；
//! - **解析（默认全本地，不联网）**：文本直读；PDF/docx/pptx 走 cap-doc 文本层；
//!   xlsx 本地抽表；图片/扫描版 PDF 走内嵌 PP-OCR（oar-ocr，模型缓存 ~/.oar）；
//!   MinerU 只是**可选增强**：设置里配了地址，图片/扫描件才优先走它，失败仍回落本地；
//! - **检索/AI**：cap-glossary 的 BM25 切片检索 + 带引用问答（复用 file 的 ai_chat）。
//!
//! 存储（与 library/glossary 同一惯例：JSON 索引 + 内容落文件，删了索引不丢内容）：
//!
//! ```text
//! ~/Library/Application Support/z-biz-tool-file/knowledge/
//!   index.json                    库/目录/物料元数据
//!   config.json                   MinerU 地址、语雀域名（非密文）
//!   originals/{material_id}.{ext} 原件副本（导入时拷入，源文件改动不影响库）
//!   drafts/{material_id}.md       当前解析稿
//! ```
//!
//! 语雀 token 不进 config.json，走家族统一密文文件（`~/.z-biz-tool/kb/secrets.enc`，
//! 与 db 板块同一套 AES-256-GCM 原语），且永不回传前端。
//!
//! 与 worker_app / mind_app / glossary_app 同构：命令在主 invoke_handler 注册，
//! `attach` 只 manage 状态。

pub mod commands; // 命令从主 invoke_handler 注册，须 pub 否则 lib.rs 引用不到
pub mod mineru;
pub mod ontology;
pub mod ocr;
pub mod parse;
pub mod search;
pub mod secret;
pub mod store;
pub mod xlsx;
pub mod yuque;

pub use ontology::OntState;
pub use store::KbState;

/// 把知识库板块的状态挂到 file 的 Tauri builder 上。
pub fn attach(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let state = KbState(std::sync::Mutex::new(store::load_index()));
    let onto = OntState(std::sync::Mutex::new(ontology::load_data()));
    builder.manage(state).manage(onto)
}
