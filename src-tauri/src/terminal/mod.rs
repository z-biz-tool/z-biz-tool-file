//! terminal 能力（SSH 终端 / SFTP / 端口转发 / 会话日志 / AI 助手）的后端实现。
//!
//! **来源**：从 `z-biz-tool-terminal` 仓整体搬入（2026-11-04）。
//! 那边的独立 app 进入维护冻结状态，能力作为 file 的第二个板块「终端」存在。
//!
//! ## 为什么放在子模块而不是摊平到 crate 根
//!
//! terminal 有 `commands` / `config` / `paths` / `secret` / `audit` / `ai` 这些
//! 模块名，与 file 已有的 `commands` / `ai` 直接撞名；两边同名模块做的是**不同的事**
//! （file 的 `config` 是应用设置，terminal 的 `config` 是服务器列表存储）。
//! 摊平会变成"改一个碰另一个"，所以整棵树挂在 `crate::terminal::*` 下。
//!
//! 搬迁时做了两处机械改写，除此之外 terminal 的业务逻辑一行没动：
//!   1. `crate::X` → `crate::terminal::X`（85 处），因为模块层级下沉了一层；
//!   2. 6+1 个与 file 同名的命令加 `term_` 前缀（见 `lib.rs` 里的注册段），
//!      否则 `generate_handler!` 会因为重复注册直接 panic。
//!
//! ## 已知的重复实现（有意保留，不是遗漏）
//!
//! - **SFTP**：file 自己有 `crate::sftp`（走 `ssh2`），terminal 这套走 `russh-sftp`。
//!   两套并存是阶段性的：前者服务于文件管理器的"远程目录当本地目录浏览"，
//!   后者服务于终端的双栏传输面板，交互模型不同，先不强行统一。
//! - **AI**：file 的 `crate::ai` 面向文档理解，terminal 的这棵是完整的对话/工具调用/
//!   流式链路。两套各自保留，命令名靠 `term_` 前缀区分。

pub mod ai;
pub mod ai_tools;
pub mod audit;
pub mod commands;
pub mod config;
pub mod hostkeys;
pub mod llm_shared;
pub mod paths;
pub mod redact;
pub mod secret;
pub mod ssh;
