use chrono::Local;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use uuid::Uuid;

/// 回收站里的一项
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrashEntry {
    /// 回收站里的实际路径（不要直接操作！通过 API 操作）
    pub trash_path: String,
    /// 原始路径（删除前在哪）
    pub original_path: String,
    /// 原始文件名
    pub name: String,
    /// 是否目录
    pub is_dir: bool,
    /// 大小（字节）
    pub size: u64,
    /// 删除时间（RFC3339 字符串）
    pub deleted_at: String,
    /// 距今多少秒
    pub age_secs: i64,
}

fn trash_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app data 目录失败: {}", e))?;
    let trash = base.join("trash");
    fs::create_dir_all(&trash).map_err(|e| format!("创建回收站目录失败: {}", e))?;
    Ok(trash)
}

fn is_path_safe(p: &Path) -> bool {
    // 防止把根目录拖进回收站
    let s = p.to_string_lossy();
    !(s == "/" || s.is_empty() || s == "~" || s == "." || s == "..")
}

fn path_to_trash(
    src: &Path,
    trash_root: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    // 布局：<trash_root>/<YYYY-MM-DD>/<uuid>/original_path.txt + <原文件名>
    let date = Local::now().format("%Y-%m-%d").to_string();
    let day_dir = trash_root.join(&date);
    fs::create_dir_all(&day_dir).map_err(|e| format!("创建日期目录失败: {}", e))?;
    let id = Uuid::new_v4().to_string()[..8].to_string();
    let uuid_dir = day_dir.join(&id);
    fs::create_dir_all(&uuid_dir).map_err(|e| format!("创建回收站子目录失败: {}", e))?;
    let file_name = src
        .file_name()
        .ok_or_else(|| "无法获取文件名".to_string())?;
    let final_dest = uuid_dir.join(file_name);
    Ok((final_dest, uuid_dir))
}

/// 把文件/目录移到回收站
///
/// 行为：
/// - 整个 mv 到 `app_data_dir/trash/YYYY-MM-DD/{uuid}/原名`
/// - 旁边写一个 `original_path.txt` 记录原始路径（恢复用）
/// - 返回移入后的路径（前端展示用）
/// - 跨设备/跨卷 mv 自动 fallback 到 copy + delete
#[tauri::command]
pub fn move_to_trash(
    app: tauri::AppHandle,
    src_path: String,
) -> Result<String, String> {
    let src = Path::new(&src_path);
    if !is_path_safe(src) {
        return Err(format!("拒绝移入回收站: {}", src_path));
    }
    if !src.exists() {
        return Err(format!("文件不存在: {}", src_path));
    }
    let root = trash_root(&app)?;
    let (dest, uuid_dir) = path_to_trash(src, &root)?;
    // 写 original_path.txt（恢复时找原路径用）
    fs::write(uuid_dir.join("original_path.txt"), src_path.as_bytes())
        .map_err(|e| format!("写元数据失败: {}", e))?;
    // 先尝试 rename（同卷下最快），失败再 copy + remove
    if fs::rename(src, &dest).is_err() {
        if src.is_dir() {
            copy_dir_recursive(src, &dest)?;
            fs::remove_dir_all(src).map_err(|e| format!("删除原目录失败: {}", e))?;
        } else {
            fs::copy(src, &dest).map_err(|e| format!("复制文件失败: {}", e))?;
            fs::remove_file(src).map_err(|e| format!("删除原文件失败: {}", e))?;
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let s = entry.path();
        let d = dest.join(entry.file_name());
        if s.is_dir() {
            copy_dir_recursive(&s, &d)?;
        } else {
            fs::copy(&s, &d).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 列出回收站所有项
#[tauri::command]
pub fn list_trash(app: tauri::AppHandle) -> Result<Vec<TrashEntry>, String> {
    let root = trash_root(&app)?;
    let mut entries = Vec::new();
    if !root.exists() {
        return Ok(entries);
    }
    walk_trash(&root, &mut entries)?;
    // 倒序：最近删除在前
    entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(entries)
}

fn walk_trash(dir: &Path, out: &mut Vec<TrashEntry>) -> Result<(), String> {
    // 回收站结构：trash/YYYY-MM-DD/{uuid}/original_path.txt + {原名}
    // 入口 dir 通常是 trash 根目录，遍历两层
    if !dir.is_dir() {
        return Ok(());
    }
    for date_entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let date_entry = date_entry.map_err(|e| e.to_string())?;
        let date_path = date_entry.path();
        if !date_path.is_dir() {
            continue;
        }
        // 每个日期目录里有多个 uuid 目录
        for uuid_entry in fs::read_dir(&date_path).map_err(|e| e.to_string())? {
            let uuid_entry = uuid_entry.map_err(|e| e.to_string())?;
            let uuid_path = uuid_entry.path();
            if !uuid_path.is_dir() {
                continue;
            }
            let meta_file = uuid_path.join("original_path.txt");
            if !meta_file.exists() {
                continue;
            }
            // 在 uuid 目录里找"原文件"（不是 meta_file 那个）
            for file_entry in fs::read_dir(&uuid_path).map_err(|e| e.to_string())? {
                let file_entry = file_entry.map_err(|e| e.to_string())?;
                let file_path = file_entry.path();
                if file_path == meta_file {
                    continue;
                }
                // 这就是原文件
                let deleted_secs = fs::metadata(&uuid_path)
                    .ok()
                    .and_then(|m| m.created().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let now_secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let original_path = fs::read_to_string(&meta_file)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let name = file_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let size = dir_size(&file_path);
                let deleted_at = chrono::DateTime::from_timestamp(deleted_secs, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default();
                out.push(TrashEntry {
                    trash_path: file_path.to_string_lossy().to_string(),
                    original_path,
                    name,
                    is_dir: file_path.is_dir(),
                    size,
                    deleted_at,
                    age_secs: now_secs - deleted_secs,
                });
            }
        }
    }
    Ok(())
}

fn dir_size(p: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(p) {
        for e in entries.flatten() {
            let ep = e.path();
            if ep.is_file() {
                if let Ok(m) = fs::metadata(&ep) {
                    total += m.len();
                }
            } else if ep.is_dir() {
                total += dir_size(&ep);
            }
        }
    }
    total
}

/// 从回收站恢复某项到原位置（或新位置）
#[tauri::command]
pub fn restore_from_trash(
    app: tauri::AppHandle,
    trash_path: String,
    target_path: Option<String>,
) -> Result<String, String> {
    let _ = app;
    let src = Path::new(&trash_path);
    if !src.exists() {
        return Err(format!("回收站项不存在: {}", trash_path));
    }
    // src 是 "原文件" 路径，其父目录是 uuid 目录，uuid 目录里有 original_path.txt
    let uuid_dir = src.parent().ok_or_else(|| "无效的回收站路径".to_string())?;
    // 默认恢复到原路径
    let target = match target_path {
        Some(p) => PathBuf::from(p),
        None => {
            let meta_file = uuid_dir.join("original_path.txt");
            if meta_file.exists() {
                PathBuf::from(fs::read_to_string(&meta_file).map_err(|e| e.to_string())?.trim())
            } else {
                return Err("未提供目标路径且没有 original_path.txt 元信息".to_string());
            }
        }
    };
    if target.exists() {
        return Err(format!("目标位置已存在文件: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::rename(src, &target).is_err() {
        if src.is_dir() {
            copy_dir_recursive(src, &target)?;
            fs::remove_dir_all(src).map_err(|e| e.to_string())?;
        } else {
            fs::copy(src, &target).map_err(|e| e.to_string())?;
            fs::remove_file(src).map_err(|e| e.to_string())?;
        }
    }
    // 删掉整个 uuid 目录（含 original_path.txt）
    fs::remove_dir_all(uuid_dir).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// 永久删除回收站里某项
#[tauri::command]
pub fn permanent_delete(trash_path: String) -> Result<(), String> {
    let p = Path::new(&trash_path);
    if !p.exists() {
        return Err(format!("回收站项不存在: {}", trash_path));
    }
    fs::remove_dir_all(p).map_err(|e| format!("永久删除失败: {}", e))?;
    // 同时删 metadata 文件（和原文件同级的 original_path.txt）
    let uuid_dir = p.parent();
    if let Some(uuid_dir) = uuid_dir {
        let _ = fs::remove_dir_all(uuid_dir);
    }
    Ok(())
}

/// 清空整个回收站
#[tauri::command]
pub fn empty_trash(app: tauri::AppHandle) -> Result<u64, String> {
    let root = trash_root(&app)?;
    if !root.exists() {
        return Ok(0);
    }
    let mut bytes = 0u64;
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_dir() {
            bytes += dir_size(&p);
            fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
        } else if p.is_file() {
            if let Ok(m) = fs::metadata(&p) {
                bytes += m.len();
            }
            fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(bytes)
}

/// 获取回收站总大小（用于 UI 展示）
#[tauri::command]
pub fn get_trash_size(app: tauri::AppHandle) -> Result<u64, String> {
    let root = trash_root(&app)?;
    if !root.exists() {
        return Ok(0);
    }
    Ok(dir_size(&root))
}

/// 获取回收站根目录路径
#[tauri::command]
pub fn get_trash_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(trash_root(&app)?.to_string_lossy().to_string())
}
