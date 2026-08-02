use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

/// 文件条目
#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

/// 文件信息
#[derive(Debug, Serialize, Deserialize)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub created: u64,
    pub readonly: bool,
}

/// 搜索结果项
#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResultItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 读取文件内容结果
#[derive(Debug, Serialize, Deserialize)]
pub struct ReadFileResult {
    pub content: String,
    pub size: u64,
    pub is_binary: bool,
}

/// 列出目录内容
#[tauri::command]
pub fn list_directory(path: &str) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(path);
    if !dir_path.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(format!("不是目录: {}", path));
    }

    let entries = fs::read_dir(dir_path).map_err(|e| format!("读取目录失败: {}", e))?;

    let mut result: Vec<FileEntry> = Vec::new();

    for entry in entries {
        if let Ok(entry) = entry {
            let file_name = entry.file_name().to_string_lossy().to_string();
            // 跳过隐藏文件（以 . 开头）
            if file_name.starts_with('.') {
                continue;
            }

            let metadata = entry.metadata().map_err(|e| format!("读取元数据失败: {}", e))?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            result.push(FileEntry {
                name: file_name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
                modified,
            });
        }
    }

    // 目录优先，然后按名称排序
    result.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(result)
}

/// 读取文件内容（文本文件）
#[tauri::command]
pub fn read_file_content(path: &str) -> Result<ReadFileResult, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if file_path.is_dir() {
        return Err(format!("是目录，不是文件: {}", path));
    }

    let metadata = fs::metadata(file_path).map_err(|e| format!("读取元数据失败: {}", e))?;
    let size = metadata.len();

    // 限制读取大小（10MB）
    if size > 10 * 1024 * 1024 {
        return Err("文件过大（超过10MB），不支持预览".to_string());
    }

    let bytes = fs::read(file_path).map_err(|e| format!("读取文件失败: {}", e))?;

    // EPUB/MOBI文件由专门的解析器处理，不标记为二进制
    let ext = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext == "epub" || ext == "mobi" {
        return Ok(ReadFileResult {
            content: String::from("[电子书文件，请使用专用阅读器查看]"),
            size,
            is_binary: false,
        });
    }

    // 简单检测是否为二进制文件
    let is_binary = bytes.iter().take(1024).filter(|&&b| b == 0).count() > 0;

    if is_binary {
        return Ok(ReadFileResult {
            content: String::from("[二进制文件，无法显示文本内容]"),
            size,
            is_binary: true,
        });
    }

    let content = String::from_utf8_lossy(&bytes).to_string();
    Ok(ReadFileResult {
        content,
        size,
        is_binary: false,
    })
}

/// 搜索文件（按文件名搜索，使用walkdir遍历指定目录）
#[tauri::command]
pub fn search_files(path: &str, query: &str) -> Result<Vec<SearchResultItem>, String> {
    let search_path = Path::new(path);
    if !search_path.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    let query_lower = query.to_lowercase();
    let mut results: Vec<SearchResultItem> = Vec::new();
    let mut count = 0;
    const MAX_RESULTS: usize = 500;

    for entry in WalkDir::new(search_path)
        .max_depth(5)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if count >= MAX_RESULTS {
            break;
        }

        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }

        if file_name.to_lowercase().contains(&query_lower) {
            let metadata = entry.metadata().ok();
            results.push(SearchResultItem {
                name: file_name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir: metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
            });
            count += 1;
        }
    }

    Ok(results)
}

/// 获取文件详细信息
#[tauri::command]
pub fn get_file_info(path: &str) -> Result<FileInfo, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    let metadata = fs::metadata(file_path).map_err(|e| format!("读取元数据失败: {}", e))?;

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let created = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(FileInfo {
        name: file_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: file_path.to_string_lossy().to_string(),
        is_dir: metadata.is_dir(),
        size: metadata.len(),
        modified,
        created,
        readonly: metadata.permissions().readonly(),
    })
}

/// 重命名文件/目录
#[tauri::command]
pub fn rename_file(old_path: &str, new_name: &str) -> Result<String, String> {
    let old = Path::new(old_path);
    if !old.exists() {
        return Err(format!("源路径不存在: {}", old_path));
    }

    let parent = old.parent().ok_or("无法获取父目录")?;
    let new_path = parent.join(new_name);

    fs::rename(old, &new_path).map_err(|e| format!("重命名失败: {}", e))?;

    Ok(new_path.to_string_lossy().to_string())
}

/// 删除文件/目录
#[tauri::command]
pub fn delete_file(path: &str) -> Result<(), String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    if file_path.is_dir() {
        fs::remove_dir_all(file_path).map_err(|e| format!("删除目录失败: {}", e))?;
    } else {
        fs::remove_file(file_path).map_err(|e| format!("删除文件失败: {}", e))?;
    }

    Ok(())
}

/// 移动文件/目录
#[tauri::command]
pub fn move_file(src_path: &str, dest_dir: &str) -> Result<String, String> {
    let src = Path::new(src_path);
    let dest_dir_path = Path::new(dest_dir);

    if !src.exists() {
        return Err(format!("源路径不存在: {}", src_path));
    }
    if !dest_dir_path.is_dir() {
        return Err(format!("目标不是目录: {}", dest_dir));
    }

    let file_name = src
        .file_name()
        .ok_or("无法获取文件名")?;

    let dest_path = dest_dir_path.join(file_name);

    // 尝试直接移动（同一卷），失败则复制+删除
    match fs::rename(src, &dest_path) {
        Ok(_) => {}
        Err(_) => {
            // 跨卷移动：复制后删除
            if src.is_dir() {
                copy_dir_recursive(src, &dest_path).map_err(|e| format!("复制目录失败: {}", e))?;
                fs::remove_dir_all(src).map_err(|e| format!("删除源目录失败: {}", e))?;
            } else {
                fs::copy(src, &dest_path).map_err(|e| format!("复制文件失败: {}", e))?;
                fs::remove_file(src).map_err(|e| format!("删除源文件失败: {}", e))?;
            }
        }
    }

    Ok(dest_path.to_string_lossy().to_string())
}

/// 递归复制目录
fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}
