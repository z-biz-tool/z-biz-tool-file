//! 工作台板块的工作区文件夹。
//!
//! 每个工作事项（Task）都绑一个**确定性派生**的文件目录，AI（默认内置 Pi）
//! 就在这个目录里读写、感知上下文、产出写作成果。参考 z-opc 的
//! `{base}/todo/{projectId}/` 设计 —— 目录由 id 推导，不建列、不落库，
//! 避免「列 vs 目录」双真相源。
//!
//! 目录结构：
//! ```text
//! ~/.z-biz-tool-worker/
//!   workspaces/
//!     {projectId}/
//!       {taskId}/        ← 一个工作事项一个独立写作空间
//!         （Pi 在这里读 AGENTS.md / 资料，写产出）
//! ```
//!
//! 为什么按 task 一级（而不是 project 一级）：用户要的是「一个工作事项
//! 分配一个文件夹」。同项目天然归组在同一个 projectId 目录下，方便整体
//! 备份/清理，但每个 task 的目录彼此独立，Pi 的读写边界清晰。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::models::Task;

/// 工作区根：`~/.z-biz-tool-worker/workspaces/`。
pub fn workspaces_root() -> PathBuf {
    let home = dirs::home_dir().expect("无法获取用户主目录");
    home.join(".z-biz-tool-worker").join("workspaces")
}

/// 一个 task 的工作区目录（确定性推导，不落库）。
pub fn dir_for_project(project_id: &str) -> PathBuf {
    workspaces_root().join(sanitize_segment(project_id))
}

/// 一个 task 的工作区目录（确定性推导，不落库）。
pub fn dir_for_task(task: &Task) -> PathBuf {
    dir_for_project(&task.project_id).join(sanitize_segment(&task.id))
}

fn sanitize_segment(s: &str) -> String {
    // id 是 uuid（安全），但防御：把路径分隔符 / \ 和 .. 换成 `_`，杜绝穿越
    s.chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' || c == '?' || c == '*' { '_' } else { c })
        .collect::<String>()
        .replace("..", "_")
}

/// 确保 task 工作区目录存在（幂等），返回路径。
pub fn ensure_task_dir(task: &Task) -> std::io::Result<PathBuf> {
    let dir = dir_for_task(task);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 目录里的一项（文件 / 子目录）。
#[derive(Debug, Clone, Serialize)]
pub struct WsEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
}

/// 列出 task 工作区的一层目录树（不递归，供任务书与 UI 快速概览）。
pub fn list_dir(dir: &Path) -> Vec<WsEntry> {
    let mut out: Vec<WsEntry> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            let is_dir = e
                .file_type()
                .map(|ft| ft.is_dir())
                .unwrap_or_else(|_| path.is_dir());
            out.push(WsEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                dir: is_dir,
                size: if is_dir { 0 } else { fs::metadata(&path).map(|m| m.len()).unwrap_or(0) },
            });
        }
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.cmp(&b.name)));
    out
}

/// 「工作区文件清单」文本，拼进任务书让 AI 感知上下文。
pub fn file_inventory_text(dir: &Path) -> String {
    let entries = list_dir(dir);
    if entries.is_empty() {
        return "（工作区是空的 —— 你是从这里开始产的）".to_string();
    }
    let mut lines = Vec::new();
    for e in entries {
        let tag = if e.dir { "[目录]" } else { "[文件]" };
        let size = if e.dir { String::new() } else { format!(" ({}B)", e.size) };
        lines.push(format!("{tag} {}{size}", e.name));
    }
    lines.join("\n")
}

/// 生成「任务书」—— 描述 task + 工作区文件清单 + 同项目其它任务，
/// 注入给 Pi 作为上下文。
pub fn build_task_kickoff(task: &Task, deps: &[Task]) -> String {
    let dir = dir_for_task(task);
    let inventory = file_inventory_text(&dir);
    let mut lines = vec![
        "你被分配了一个工作事项，请在该事项的工作区文件夹里完成。".to_string(),
        String::new(),
        format!("【任务标题】{}", task.title),
        format!("【任务描述】{}", task.description),
        format!("【工作区文件夹】{}", dir.display()),
        String::new(),
        "【工作区当前内容】".to_string(),
        inventory,
        String::new(),
        "工作要求：".to_string(),
        "- 先读工作区里已有的资料（AGENTS.md / 背景文档 / 参考文件）理解上下文；".to_string(),
        "- 产物直接写进工作区文件夹（新建/覆盖对应文件）；".to_string(),
        "- 写完后把主要的产出文件名和一句话总结写进你的回复里。".to_string(),
    ];
    if !deps.is_empty() {
        lines.push(String::new());
        lines.push("【同项目相关事项（避免重复/协同）】".to_string());
        for (i, d) in deps.iter().enumerate() {
            lines.push(format!("  {}. [{}] {} — {} 开头", i + 1, d.status, d.title, d.description.chars().take(40).collect::<String>()));
        }
    }
    lines.join("\n")
}