use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;

/// 文件标签 / 备注
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FileTag {
    /// 颜色：red/orange/yellow/green/blue/purple/gray
    #[serde(default)]
    pub color: String,
    /// 简短标签
    #[serde(default)]
    pub label: String,
    /// 详细备注
    #[serde(default)]
    pub note: String,
}

fn tag_store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取 app config 目录失败: {}", e))?;
    Ok(base.join("tags.json"))
}

/// 读取所有标签
#[tauri::command]
pub fn get_all_tags(
    app: tauri::AppHandle,
) -> Result<HashMap<String, FileTag>, String> {
    let path = tag_store_path(&app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取标签失败: {}", e))?;
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&content).map_err(|e| format!("解析标签失败: {}", e))
}

/// 设置/更新某文件的标签
#[tauri::command]
pub fn set_file_tag(
    app: tauri::AppHandle,
    file_path: String,
    tag: FileTag,
) -> Result<(), String> {
    let path = tag_store_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 读现有
    let mut all: HashMap<String, FileTag> = if path.exists() {
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        if content.trim().is_empty() {
            HashMap::new()
        } else {
            serde_json::from_str(&content).unwrap_or_default()
        }
    } else {
        HashMap::new()
    };
    // 如果全部字段都为空，删除（视为取消标签）
    if tag.color.is_empty() && tag.label.is_empty() && tag.note.is_empty() {
        all.remove(&file_path);
    } else {
        all.insert(file_path, tag);
    }
    // 原子写
    let tmp = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除某文件的标签
#[tauri::command]
pub fn delete_file_tag(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<(), String> {
    let path = tag_store_path(&app)?;
    if !path.exists() {
        return Ok(());
    }
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let mut all: HashMap<String, FileTag> = if content.trim().is_empty() {
        HashMap::new()
    } else {
        serde_json::from_str(&content).unwrap_or_default()
    };
    all.remove(&file_path);
    let content = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}
