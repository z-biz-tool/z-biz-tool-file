//! AI 内容工厂板块（2026-11-19 从 z-biz-tool-aigen 整树搬入）。
//!
//! 这里只放「这个板块自己的」生成业务：任务队列、服务商配置、JSONL 历史、
//! 提示词模板、导出、参考图与 .pptx 打包。协议层（LLM 调用 / 密钥库 /
//! 深链）继续走家族共享的 cap-llm / cap-llm-config / cap-hub —— file 主壳
//! 已经挂了那几样，本模块不重复注册。
//!
//! 命令不在本文件注册（Tauri 的 generate_handler! 只认调用点），统一在
//! `src-tauri/src/lib.rs` 的 handler 清单里以 `aigen_app::commands::*` 列出。

pub mod ai_client;
pub mod assistant;
pub mod commands;
pub mod error;
pub mod export;
pub mod history;
pub mod job;
pub mod pptx;
pub mod reference;
pub mod secret;
pub mod stream;
pub mod templates;

use tauri::Builder;

/// 挂本板块的 managed state。与 file 其它板块一样，builder 链在主 lib.rs 里接。
pub fn attach<R: tauri::Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.manage(ai_client::AppState::default())
}
