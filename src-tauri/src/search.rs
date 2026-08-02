use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

/// 全盘搜索结果项
#[derive(Debug, Serialize, Deserialize)]
pub struct DiskSearchResult {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub matched_line: Option<String>,
}

/// 全盘搜索：在指定根目录下递归搜索文件名模糊匹配
#[tauri::command]
pub fn full_disk_search(
    root_path: &str,
    query: &str,
    max_results: Option<usize>,
) -> Result<Vec<DiskSearchResult>, String> {
    let root = Path::new(root_path);
    if !root.exists() {
        return Err(format!("搜索路径不存在: {}", root_path));
    }

    let query_lower = query.to_lowercase();
    let max = max_results.unwrap_or(200);
    let mut results: Vec<DiskSearchResult> = Vec::new();

    for entry in WalkDir::new(root)
        .max_depth(8)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // 跳过隐藏文件和系统目录
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.')
        })
        .filter_map(|e| e.ok())
    {
        if results.len() >= max {
            break;
        }

        let file_name = entry.file_name().to_string_lossy().to_string();

        if file_name.to_lowercase().contains(&query_lower) {
            let metadata = entry.metadata().ok();
            results.push(DiskSearchResult {
                name: file_name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir: metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
                matched_line: None,
            });
        }
    }

    Ok(results)
}

/// 搜索文件内容：在指定目录下递归搜索文本文件中包含关键词的行
#[tauri::command]
pub fn search_file_content(
    root_path: &str,
    query: &str,
    max_results: Option<usize>,
) -> Result<Vec<DiskSearchResult>, String> {
    let root = Path::new(root_path);
    if !root.exists() {
        return Err(format!("搜索路径不存在: {}", root_path));
    }

    let query_lower = query.to_lowercase();
    let max = max_results.unwrap_or(100);
    let mut results: Vec<DiskSearchResult> = Vec::new();

    // 可搜索的文本文件扩展名
    let text_exts = [
        "txt", "md", "rs", "go", "py", "js", "ts", "tsx", "jsx", "json", "yaml", "yml",
        "toml", "xml", "html", "css", "scss", "less", "sh", "bat", "java", "c", "cpp", "h",
        "hpp", "cs", "rb", "php", "swift", "kt", "sql", "log", "csv", "conf", "ini", "env",
    ];

    for entry in WalkDir::new(root)
        .max_depth(6)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.')
        })
        .filter_map(|e| e.ok())
    {
        if results.len() >= max {
            break;
        }

        if entry.file_type().is_dir() {
            continue;
        }

        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        if !text_exts.contains(&ext.to_lowercase().as_str()) {
            continue;
        }

        // 限制文件大小（1MB以内）
        if let Ok(metadata) = entry.metadata() {
            if metadata.len() > 1024 * 1024 {
                continue;
            }
        }

        // 读取文件内容搜索
        if let Ok(content) = fs::read_to_string(path) {
            for line in content.lines() {
                if line.to_lowercase().contains(&query_lower) {
                    let file_name = entry
                        .file_name()
                        .to_string_lossy()
                        .to_string();
                    let metadata = entry.metadata().ok();
                    results.push(DiskSearchResult {
                        name: file_name,
                        path: path.to_string_lossy().to_string(),
                        is_dir: false,
                        size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
                        matched_line: Some(line.to_string()),
                    });
                    break; // 每个文件只取第一个匹配
                }
            }
        }
    }

    Ok(results)
}
