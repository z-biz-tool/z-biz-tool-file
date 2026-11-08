//! 词库的落盘与进程内状态。
//!
//! 词条存在 `cap_glossary::GlossaryStore`（纯内存、serde 可序列化），本文件负责
//! 把它持久化成 JSON，并提供进程内唯一状态句柄给命令用。

use std::path::PathBuf;
use std::sync::Mutex;

use cap_glossary::GlossaryStore;

/// 词库落盘文件名（相对 data local dir 的 z-biz-tool-file 目录）。
const GLOSSARY_FILE: &str = "glossary.json";

/// 进程内唯一词库状态。Tauri manage 一份，命令通过 `tauri::State` 取。
pub struct GlossaryState(pub Mutex<GlossaryStore>);

impl Default for GlossaryState {
    fn default() -> Self {
        Self(Mutex::new(GlossaryStore::new()))
    }
}

/// 词库 JSON 的落盘目录：`~/Library/Application Support/z-biz-tool-file/glossary.json`
/// （与 indexer.rs 的 index/ 同名目录兄弟）。
pub fn glossary_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("z-biz-tool-file")
        .join(GLOSSARY_FILE)
}

/// 从磁盘载入词库；文件不存在或损坏时用空库（损坏时原样保留文件，便于排查）。
pub fn load_store() -> GlossaryStore {
    let path = glossary_path();
    match std::fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str::<GlossaryStore>(&json).unwrap_or_default(),
        Err(_) => GlossaryStore::new(),
    }
}

/// 把当前词库写盘。
pub fn save_store(store: &GlossaryStore) -> Result<(), String> {
    let path = glossary_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建词库目录失败: {}", e))?;
    }
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("序列化词库失败: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("写词库文件失败: {}", e))
}