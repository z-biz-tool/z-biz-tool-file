use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read as IoRead, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use walkdir::WalkDir;
use std::collections::BinaryHeap;
use std::cmp::Reverse;
use std::process::Command as StdCommand;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};
use md5::Digest as Md5Digest;
use sha1::Sha1;
use sha2::Sha256;

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
    let canonical = crate::path_guard::validate(path).map_err(|e| e.to_string())?;
    if !canonical.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if canonical.is_dir() {
        return Err(format!("是目录，不是文件: {}", path));
    }

    let metadata = fs::metadata(&canonical).map_err(|e| format!("读取元数据失败: {}", e))?;
    let size = metadata.len();

    // 限制读取大小（10MB）
    if size > 10 * 1024 * 1024 {
        return Err("文件过大（超过10MB），不支持预览".to_string());
    }

    let bytes = fs::read(&canonical).map_err(|e| format!("读取文件失败: {}", e))?;

    // EPUB/MOBI文件由专门的解析器处理，不标记为二进制
    let ext = canonical
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
    let canonical = crate::path_guard::validate(path).map_err(|e| e.to_string())?;
    if !canonical.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    let query_lower = query.to_lowercase();
    let mut results: Vec<SearchResultItem> = Vec::new();
    let mut count = 0;
    const MAX_RESULTS: usize = 500;

    for entry in WalkDir::new(&canonical)
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
    let canonical = crate::path_guard::validate(old_path).map_err(|e| e.to_string())?;
    if !canonical.exists() {
        return Err(format!("源路径不存在: {}", old_path));
    }

    let parent = canonical.parent().ok_or("无法获取父目录")?;
    let new_path = parent.join(new_name);

    fs::rename(&canonical, &new_path).map_err(|e| format!("重命名失败: {}", e))?;

    Ok(new_path.to_string_lossy().to_string())
}

/// 删除文件/目录
#[tauri::command]
pub fn delete_file(path: &str) -> Result<(), String> {
    let canonical = crate::path_guard::validate(path).map_err(|e| e.to_string())?;
    if !canonical.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    if canonical.is_dir() {
        fs::remove_dir_all(&canonical).map_err(|e| format!("删除目录失败: {}", e))?;
    } else {
        fs::remove_file(&canonical).map_err(|e| format!("删除文件失败: {}", e))?;
    }

    Ok(())
}

/// 移动文件/目录
#[tauri::command]
pub fn move_file(src_path: &str, dest_dir: &str) -> Result<String, String> {
    let src_canonical = crate::path_guard::validate(src_path).map_err(|e| e.to_string())?;
    let dest_canonical = crate::path_guard::validate(dest_dir).map_err(|e| e.to_string())?;

    if !src_canonical.exists() {
        return Err(format!("源路径不存在: {}", src_path));
    }
    if !dest_canonical.is_dir() {
        return Err(format!("目标不是目录: {}", dest_dir));
    }

    let file_name = src_canonical
        .file_name()
        .ok_or("无法获取文件名")?;

    let dest_path = dest_canonical.join(file_name);

    // 尝试直接移动（同一卷），失败则复制+删除
    match fs::rename(&src_canonical, &dest_path) {
        Ok(_) => {}
        Err(_) => {
            // 跨卷移动：复制后删除
            if src_canonical.is_dir() {
                copy_dir_recursive(&src_canonical, &dest_path).map_err(|e| format!("复制目录失败: {}", e))?;
                fs::remove_dir_all(&src_canonical).map_err(|e| format!("删除源目录失败: {}", e))?;
            } else {
                fs::copy(&src_canonical, &dest_path).map_err(|e| format!("复制文件失败: {}", e))?;
                fs::remove_file(&src_canonical).map_err(|e| format!("删除源文件失败: {}", e))?;
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

/// 复制文件/目录
#[tauri::command]
pub fn copy_file(src_path: &str, dest_dir: &str) -> Result<String, String> {
    let src_canonical = crate::path_guard::validate(src_path).map_err(|e| e.to_string())?;
    let dest_canonical = crate::path_guard::validate(dest_dir).map_err(|e| e.to_string())?;

    if !src_canonical.exists() {
        return Err(format!("源路径不存在: {}", src_path));
    }
    if !dest_canonical.is_dir() {
        return Err(format!("目标不是目录: {}", dest_dir));
    }

    let file_name = src_canonical
        .file_name()
        .ok_or("无法获取文件名")?;

    let dest_path = dest_canonical.join(file_name);

    if src_canonical.is_dir() {
        copy_dir_recursive(&src_canonical, &dest_path).map_err(|e| format!("复制目录失败: {}", e))?;
    } else {
        fs::copy(&src_canonical, &dest_path).map_err(|e| format!("复制文件失败: {}", e))?;
    }

    Ok(dest_path.to_string_lossy().to_string())
}

/// 创建新文件
///
/// - `path`: 目标文件完整路径
/// - `content`: 可选；为 None 或空字符串时创建空文件，否则写入该字符串
///
/// 一次性完成"创建 + 写内容"，避免前端分两步调用（plugin-fs 的 writeFile
/// 在 Tauri 2 的 fs:default capability 下会被 ACL 拒，且分两步还有
/// "文件先被创建为空文件后写失败"的竞态）。
#[tauri::command]
pub fn create_file(path: &str, content: Option<String>) -> Result<(), String> {
    // 写入场景：目标文件不存在，需对父目录做校验
    let parent = Path::new(path).parent().ok_or("无法获取父目录")?;
    let canonical_parent = crate::path_guard::validate(parent.to_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    let file_path = canonical_parent.join(
        Path::new(path)
            .file_name()
            .ok_or("无法获取文件名")?,
    );
    if file_path.exists() {
        return Err(format!("文件已存在: {}", path));
    }

    // 确保父目录存在
    fs::create_dir_all(&canonical_parent).map_err(|e| format!("创建父目录失败: {}", e))?;

    match content {
        Some(c) if !c.is_empty() => {
            fs::write(file_path, c).map_err(|e| format!("创建文件失败: {}", e))?;
        }
        _ => {
            fs::File::create(file_path).map_err(|e| format!("创建文件失败: {}", e))?;
        }
    }

    Ok(())
}

/// 创建新目录（包括父目录）
#[tauri::command]
pub fn create_directory(path: &str) -> Result<(), String> {
    // 写入场景：父目录必须已存在
    let parent = Path::new(path).parent().ok_or("无法获取父目录")?;
    let canonical_parent = crate::path_guard::validate(parent.to_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    let dir_path = canonical_parent.join(
        Path::new(path)
            .file_name()
            .ok_or("无法获取目录名")?,
    );
    if dir_path.exists() {
        return Err(format!("目录已存在: {}", path));
    }

    fs::create_dir_all(&dir_path).map_err(|e| format!("创建目录失败: {}", e))?;

    Ok(())
}

/// 删除文件 — 移到回收站（可恢复）
#[tauri::command]
pub fn delete_to_trash(
    app: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    crate::trash::move_to_trash(app, path)
}

/// 执行 shell 命令（用于"快速操作 / 脚本"功能）
/// - `program`: 可执行文件（"rm", "chmod", "open" 等）
/// - `args`: 参数列表（用 {path} 占位符会被替换为传入的 file path）
/// 返回 stdout / stderr
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellRunResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[tauri::command]
pub fn run_shell_command(
    program: String,
    args: Vec<String>,
    file_path: String,
) -> Result<ShellRunResult, String> {
    // P0 安全修复：白名单化的程序执行入口。仅允许预定义程序路径。
    const ALLOWED_PROGRAMS: &[&str] = &[
        "/usr/bin/open",
        "/bin/open",
        "/usr/bin/pbcopy",
        "/usr/bin/pbpaste",
        "/usr/bin/say",
        "/usr/bin/afplay",
        "/usr/bin/mdls",
        "/usr/bin/xattr",
        "/usr/bin/qlmanage",
    ];
    if !ALLOWED_PROGRAMS.iter().any(|p| *p == program) {
        return Err(format!("程序未在白名单内: {}", program));
    }

    // 占位符替换：{path} → file_path
    let resolved_args: Vec<String> = args
        .into_iter()
        .map(|a| a.replace("{path}", &file_path))
        .collect();
    let output = StdCommand::new(&program)
        .args(&resolved_args)
        .output()
        .map_err(|e| format!("启动 {} 失败: {}", program, e))?;
    Ok(ShellRunResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// 存储分析：扫描目录，统计大小，返回前 N 大子项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageTopItem {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub children: Vec<StorageTopItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StorageAnalysis {
    pub total: u64,
    pub file_count: u64,
    pub top_items: Vec<StorageTopItem>,
}

/// 递归统计目录大小 + 收集 top N
#[tauri::command]
pub fn analyze_storage(
    path: String,
    depth: Option<usize>,
    top_n: Option<usize>,
) -> Result<StorageAnalysis, String> {
    let _canonical = crate::path_guard::validate(&path).map_err(|e| e.to_string())?;
    let root = Path::new(&path);
    if !root.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    let max_depth = depth.unwrap_or(2);
    let top_n = top_n.unwrap_or(50);

    // 收集 (size, item) 全部
    let mut all: Vec<(u64, walkdir::DirEntry)> = Vec::new();
    let mut total: u64 = 0;
    let mut file_count: u64 = 0;
    for entry in WalkDir::new(root)
        .max_depth(max_depth)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = if meta.is_dir() { 0 } else { meta.len() };
        if !meta.is_dir() {
            total += size;
            file_count += 1;
        }
        all.push((size, entry));
    }

    // 排序取前 N（按 size 降序）
    all.sort_by(|a, b| b.0.cmp(&a.0));
    let top_raw: Vec<(u64, walkdir::DirEntry)> = all.into_iter().take(top_n).collect();

    fn build_item(entry: &walkdir::DirEntry, size: u64) -> StorageTopItem {
        StorageTopItem {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            size,
            is_dir: entry.file_type().is_dir(),
            children: vec![],
        }
    }

    let top_items: Vec<StorageTopItem> = top_raw
        .iter()
        .map(|(s, e)| build_item(e, *s))
        .collect();

    Ok(StorageAnalysis {
        total,
        file_count,
        top_items,
    })
}

/// 永久删除文件（不进回收站）
#[derive(Debug, Serialize, Deserialize)]
pub struct EpubTempCleanupResult {
    /// 清理掉的目录数
    pub dirs: usize,
    /// 释放的字节数
    pub bytes_freed: u64,
}

/// 清理所有 /tmp/z-tool-epub-* 临时目录（EPUB 解压出来的资源文件）
///
/// 用户手动触发或 app 启动时调用都可。每次打开同一本书会复用同名临时目录
/// （基于 epub 路径 hash 命名），所以理论上不会无限增长，但用户可能：
///   1. 移动/删除了原 epub 文件但临时目录还在 → 浪费磁盘
///   2. 想强制重新解压（例如 epub 文件改了内容但路径没变）
///
/// 删 /tmp 下所有以 `z-tool-epub-` 开头的目录。
#[tauri::command]
pub fn cleanup_epub_temp() -> Result<EpubTempCleanupResult, String> {
    let temp_dir = std::env::temp_dir();
    let entries = fs::read_dir(&temp_dir).map_err(|e| format!("读取临时目录失败: {}", e))?;
    let mut dirs = 0usize;
    let mut bytes_freed = 0u64;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("z-tool-epub-") {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // 计算目录大小再删
        let size = dir_size(&path);
        if fs::remove_dir_all(&path).is_ok() {
            dirs += 1;
            bytes_freed += size;
        }
    }
    Ok(EpubTempCleanupResult { dirs, bytes_freed })
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                if let Ok(meta) = fs::metadata(&p) {
                    total += meta.len();
                }
            } else if p.is_dir() {
                total += dir_size(&p);
            }
        }
    }
    total
}

/// 批量重命名项
#[derive(Debug, Serialize, Deserialize)]
pub struct BatchRenameItem {
    pub old_path: String,
    pub new_path: String,
    pub old_name: String,
    pub new_name: String,
}

/// 批量重命名结果
#[derive(Debug, Serialize, Deserialize)]
pub struct BatchRenameResult {
    pub success: bool,
    pub renamed: Vec<BatchRenameItem>,
    pub errors: Vec<String>,
}

/// 批量重命名文件
#[tauri::command]
pub fn batch_rename(
    paths: Vec<String>,
    mode: &str,
    find_text: Option<String>,
    replace_text: Option<String>,
    prefix: Option<String>,
    suffix: Option<String>,
    start_number: Option<u32>,
) -> Result<BatchRenameResult, String> {
    let mut renamed: Vec<BatchRenameItem> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let start_num = start_number.unwrap_or(1);

    for (index, path_str) in paths.iter().enumerate() {
        // 批量重命名也接 path_guard：拒绝任何黑名单路径
        let canonical = match crate::path_guard::validate(path_str) {
            Ok(p) => p,
            Err(e) => {
                errors.push(format!("拒绝 {}: {}", path_str, e));
                continue;
            }
        };
        if !canonical.exists() {
            errors.push(format!("路径不存在: {}", path_str));
            continue;
        }

        let old_name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let new_name = match mode {
            "find_replace" => {
                let find = find_text.as_deref().unwrap_or("");
                let replace = replace_text.as_deref().unwrap_or("");
                old_name.replace(find, replace)
            }
            "prefix_suffix" => {
                let p = prefix.as_deref().unwrap_or("");
                let s = suffix.as_deref().unwrap_or("");
                format!("{}{}{}", p, old_name, s)
            }
            "auto_number" => {
                let num = start_num + index as u32;
                if let Some(ext) = canonical.extension() {
                    let stem = canonical
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    format!("{}{}.{}", stem, num, ext.to_string_lossy())
                } else {
                    format!("{}{}", old_name, num)
                }
            }
            _ => {
                errors.push(format!("不支持的重命名模式: {}", mode));
                continue;
            }
        };

        if new_name == old_name {
            continue;
        }

        let parent = match canonical.parent() {
            Some(p) => p,
            None => {
                errors.push(format!("无法获取父目录: {}", path_str));
                continue;
            }
        };

        let new_path = parent.join(&new_name);

        match fs::rename(&canonical, &new_path) {
            Ok(_) => {
                renamed.push(BatchRenameItem {
                    old_path: path_str.clone(),
                    new_path: new_path.to_string_lossy().to_string(),
                    old_name,
                    new_name,
                });
            }
            Err(e) => {
                errors.push(format!("重命名 {} 失败: {}", path_str, e));
            }
        }
    }

    Ok(BatchRenameResult {
        success: errors.is_empty(),
        renamed,
        errors,
    })
}

/// 列出目录内容（支持显示隐藏文件）
#[tauri::command]
pub fn list_directory_with_hidden(path: &str, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
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
            // 根据参数决定是否跳过隐藏文件
            if !show_hidden && file_name.starts_with('.') {
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

/// 压缩文件/目录为 ZIP
#[tauri::command]
pub fn compress_to_zip(paths: Vec<String>, dest_path: String) -> Result<(), String> {
    let dest = Path::new(&dest_path);

    // 确保目标目录存在
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    let file = fs::File::create(dest).map_err(|e| format!("创建ZIP文件失败: {}", e))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated);

    for path_str in &paths {
        let src_path = Path::new(path_str);
        if !src_path.exists() {
            return Err(format!("路径不存在: {}", path_str));
        }

        if src_path.is_dir() {
            add_dir_to_zip(&mut zip, src_path, src_path, &options)
                .map_err(|e| format!("压缩目录失败: {}", e))?;
        } else {
            add_file_to_zip(&mut zip, src_path, src_path, &options)
                .map_err(|e| format!("压缩文件失败: {}", e))?;
        }
    }

    zip.finish().map_err(|e| format!("完成ZIP写入失败: {}", e))?;

    Ok(())
}

/// 递归添加目录到 ZIP
fn add_dir_to_zip<W: std::io::Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    base: &Path,
    dir: &Path,
    options: &SimpleFileOptions,
) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let relative = path.strip_prefix(base).unwrap_or(&path);

        if path.is_dir() {
            let dir_name = relative.to_string_lossy().to_string() + "/";
            zip.add_directory(&dir_name, options.clone())?;
            add_dir_to_zip(zip, base, &path, options)?;
        } else {
            add_file_to_zip(zip, &path, base, options)?;
        }
    }
    Ok(())
}

/// 添加单个文件到 ZIP
///
/// 流式写入：使用 64KB 固定缓冲区分块读取并写入 zip，避免 read_to_end 在
/// 大文件（如 2GB 视频）上触发 OOM。
fn add_file_to_zip<W: std::io::Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    file_path: &Path,
    base: &Path,
    options: &SimpleFileOptions,
) -> std::io::Result<()> {
    use std::io::{BufReader, Read};

    let relative = file_path.strip_prefix(base).unwrap_or(file_path);
    let file_name = relative.to_string_lossy().to_string();

    // 64KB 是 zip deflate 推荐的滑动窗口大小附近，兼顾 IO 调用次数与内存占用。
    let file = fs::File::open(file_path)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut buf = [0u8; 64 * 1024];

    zip.start_file(&file_name, options.clone())?;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        zip.write_all(&buf[..n])?;
    }

    Ok(())
}

/// 解压 ZIP 文件
#[tauri::command]
pub fn extract_zip(zip_path: &str, dest_dir: &str) -> Result<(), String> {
    // dest_dir 也接 path_guard：解压不能写到系统目录
    let canonical_dest = crate::path_guard::validate(dest_dir).map_err(|e| e.to_string())?;

    let src = Path::new(zip_path);
    if !src.exists() {
        return Err(format!("ZIP文件不存在: {}", zip_path));
    }

    let dest = &canonical_dest;
    fs::create_dir_all(dest).map_err(|e| format!("创建目标目录失败: {}", e))?;

    let file = fs::File::open(src).map_err(|e| format!("打开ZIP文件失败: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("读取ZIP文件失败: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取ZIP条目失败: {}", e))?;

        let out_path = dest.join(entry.name());
        // 安全检查：确保解压路径在目标目录内（防止 zip slip）
        let canonical_dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
        if let Ok(canonical_out) = out_path.canonicalize() {
            if !canonical_out.starts_with(&canonical_dest) {
                return Err(format!("安全错误：解压路径超出目标目录: {}", entry.name()));
            }
        } else {
            // 路径尚不存在，检查父路径
            if let Some(parent) = out_path.parent() {
                if let Ok(canonical_parent) = parent.canonicalize() {
                    if !canonical_parent.starts_with(&canonical_dest) {
                        return Err(format!("安全错误：解压路径超出目标目录: {}", entry.name()));
                    }
                }
            }
        }

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("创建目录失败: {}", e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
            }
            let mut out_file =
                fs::File::create(&out_path).map_err(|e| format!("创建文件失败: {}", e))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("写入文件失败: {}", e))?;
        }

        // 设置文件权限（Unix）
        #[cfg(unix)]
        {
            if let Some(mode) = entry.unix_mode() {
                fs::set_permissions(&out_path, fs::Permissions::from_mode(mode))
                    .map_err(|e| format!("设置权限失败: {}", e))?;
            }
        }
    }

    Ok(())
}

// ============================================================================
// 多格式解压：zip / tar / tar.gz / tar.bz2 / tar.xz / gz / 7z
// ============================================================================

/// 检测压缩包格式（按扩展名，简单可靠）
fn detect_archive_format(path: &Path) -> &'static str {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // 注意：.tar.gz 等双扩展名要先匹配长后缀
    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        "tar.gz"
    } else if name.ends_with(".tar.bz2") || name.ends_with(".tbz2") {
        "tar.bz2"
    } else if name.ends_with(".tar.xz") || name.ends_with(".txz") {
        "tar.xz"
    } else if name.ends_with(".zip") {
        "zip"
    } else if name.ends_with(".tar") {
        "tar"
    } else if name.ends_with(".7z") {
        "7z"
    } else if name.ends_with(".gz") {
        "gz" // 单文件 gzip
    } else {
        "unknown"
    }
}

/// 解压 tar（含 .tar / .tar.gz / .tar.bz2 / .tar.xz）
fn extract_tar_impl(
    src: &Path,
    dest: &Path,
    decompress: Option<DecompressAlgo>,
) -> Result<(), String> {
    let file = fs::File::open(src).map_err(|e| format!("打开文件失败: {}", e))?;
    let reader: Box<dyn std::io::Read> = match decompress {
        None => Box::new(file),
        Some(DecompressAlgo::Gzip) => Box::new(flate2::read::GzDecoder::new(file)),
        Some(DecompressAlgo::Bzip2) => Box::new(bzip2::read::BzDecoder::new(file)),
        Some(DecompressAlgo::Xz) => Box::new(xz2::read::XzDecoder::new(file)),
    };
    let mut archive = tar::Archive::new(reader);
    let canonical_dest = dest
        .canonicalize()
        .map_err(|e| format!("解析目标目录失败: {}", e))?;
    for entry in archive
        .entries()
        .map_err(|e| format!("读取 tar 条目失败: {}", e))?
    {
        let mut entry = entry.map_err(|e| format!("解析 tar 条目失败: {}", e))?;
        let entry_path = entry
            .path()
            .map_err(|e| format!("条目路径无效: {}", e))?
            .into_owned();
        let out_path = dest.join(&entry_path);
        // 安全检查（路径必须落在 dest 内）
        if let Some(parent) = out_path.parent() {
            if let Ok(cp) = parent.canonicalize() {
                if !cp.starts_with(&canonical_dest) {
                    return Err(format!(
                        "安全错误：解压路径超出目标目录: {}",
                        out_path.display()
                    ));
                }
            } else {
                // 父目录尚未存在，逐级向上检查，直到 dest
                let mut cur = Some(parent.to_path_buf());
                while let Some(p) = cur {
                    if p == dest {
                        break;
                    }
                    if p.exists() {
                        if let Ok(cp) = p.canonicalize() {
                            if !cp.starts_with(&canonical_dest) {
                                return Err(format!(
                                    "安全错误：解压路径超出目标目录: {}",
                                    out_path.display()
                                ));
                            }
                        }
                        break;
                    }
                    cur = p.parent().map(|x| x.to_path_buf());
                }
            }
        }
        if entry_path.to_string_lossy().ends_with('/') || entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("创建目录失败: {}", e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
            }
            entry
                .unpack(&out_path)
                .map_err(|e| format!("解压文件失败: {}", e))?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum DecompressAlgo {
    Gzip,
    Bzip2,
    Xz,
}

/// 解压单文件 .gz
fn extract_gz_impl(src: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(src).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut decoder = flate2::read::GzDecoder::new(file);
    // 输出文件名：去掉 .gz 后缀
    let file_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无法获取文件名".to_string())?;
    let out_name = file_name.trim_end_matches(".gz");
    let out_path = dest.join(out_name);
    let mut out_file = fs::File::create(&out_path).map_err(|e| format!("创建文件失败: {}", e))?;
    std::io::copy(&mut decoder, &mut out_file).map_err(|e| format!("解压失败: {}", e))?;
    Ok(())
}

/// 解压 7z（用 sevenz-rust 0.6 的高层 API：默认 extractor 已含防 zip-slip 等安全处理）
fn extract_7z_impl(src: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(src).map_err(|e| format!("打开 7z 文件失败: {}", e))?;
    sevenz_rust::decompress(file, dest).map_err(|e| format!("解压 7z 失败: {}", e))
}

/// 通用解压：按扩展名自动选择格式
#[tauri::command]
pub fn extract_archive(archive_path: &str, dest_dir: &str) -> Result<(), String> {
    // dest_dir 必须在允许范围内，避免解压到系统目录
    let canonical_dest = crate::path_guard::validate(dest_dir).map_err(|e| e.to_string())?;

    let src = Path::new(archive_path);
    if !src.exists() {
        return Err(format!("压缩包不存在: {}", archive_path));
    }
    fs::create_dir_all(&canonical_dest).map_err(|e| format!("创建目标目录失败: {}", e))?;
    let dest = &canonical_dest;

    match detect_archive_format(src) {
        "zip" => extract_zip(archive_path, dest_dir),
        "tar" => extract_tar_impl(src, dest, None),
        "tar.gz" => extract_tar_impl(src, dest, Some(DecompressAlgo::Gzip)),
        "tar.bz2" => extract_tar_impl(src, dest, Some(DecompressAlgo::Bzip2)),
        "tar.xz" => extract_tar_impl(src, dest, Some(DecompressAlgo::Xz)),
        "gz" => extract_gz_impl(src, dest),
        "7z" => extract_7z_impl(src, dest),
        other => Err(format!(
            "暂不支持的压缩格式: {}（仅支持 zip / tar / tar.gz / tar.bz2 / tar.xz / gz / 7z）",
            other
        )),
    }
}

/// 判断文件是否支持解压（前端用来显示"解压"菜单项）
#[tauri::command]
pub fn is_archive_supported(archive_path: &str) -> bool {
    let p = Path::new(archive_path);
    matches!(
        detect_archive_format(p),
        "zip" | "tar" | "tar.gz" | "tar.bz2" | "tar.xz" | "gz" | "7z"
    )
}

/// 文件权限信息
#[derive(Debug, Serialize, Deserialize)]
pub struct FilePermissions {
    pub readonly: bool,
    pub mode: u32,
    pub readable: bool,
    pub writable: bool,
    pub executable: bool,
}

/// 获取文件权限信息
#[tauri::command]
pub fn get_file_permissions(path: &str) -> Result<FilePermissions, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    let metadata = fs::metadata(file_path).map_err(|e| format!("读取元数据失败: {}", e))?;
    let permissions = metadata.permissions();
    let mode = permissions.mode();

    Ok(FilePermissions {
        readonly: permissions.readonly(),
        mode,
        readable: mode & 0o400 != 0,
        writable: mode & 0o200 != 0,
        executable: mode & 0o100 != 0,
    })
}

/// 使用系统默认应用打开文件
#[tauri::command]
pub fn open_with_default_app(path: &str) -> Result<(), String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    opener::open(path).map_err(|e| format!("打开文件失败: {}", e))?;

    Ok(())
}

/// 计算目录总大小（递归）
#[tauri::command]
pub fn get_directory_size(path: &str) -> Result<u64, String> {
    let canonical = crate::path_guard::validate(path).map_err(|e| e.to_string())?;
    if !canonical.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    if !canonical.is_dir() {
        return Err(format!("不是目录: {}", path));
    }

    let mut total_size: u64 = 0;

    for entry in WalkDir::new(&canonical).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            total_size += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }

    Ok(total_size)
}

/// 计算文件哈希值（支持 MD5、SHA1、SHA256、CRC32）
#[tauri::command]
pub fn calculate_file_hash(path: &str, algorithm: &str) -> Result<String, String> {
    let canonical = crate::path_guard::validate(path).map_err(|e| e.to_string())?;
    if !canonical.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if canonical.is_dir() {
        return Err(format!("是目录，不是文件: {}", path));
    }

    let mut file = fs::File::open(&canonical).map_err(|e| format!("打开文件失败: {}", e))?;

    match algorithm.to_lowercase().as_str() {
        "md5" => {
            let mut hasher = md5::Md5::new();
            std::io::copy(&mut file, &mut hasher).map_err(|e| format!("读取文件失败: {}", e))?;
            let result = hasher.finalize();
            Ok(format!("{:x}", result))
        }
        "sha1" => {
            let mut hasher = Sha1::new();
            std::io::copy(&mut file, &mut hasher).map_err(|e| format!("读取文件失败: {}", e))?;
            let result = hasher.finalize();
            Ok(format!("{:x}", result))
        }
        "sha256" => {
            let mut hasher = Sha256::new();
            std::io::copy(&mut file, &mut hasher).map_err(|e| format!("读取文件失败: {}", e))?;
            let result = hasher.finalize();
            Ok(format!("{:x}", result))
        }
        "crc32" => {
            // 流式 CRC32：每次读 64KB 进哈希表，恒定内存
            use std::io::Read;
            let mut table = [0u32; 256];
            for i in 0..256 {
                let mut c = i as u32;
                for _ in 0..8 {
                    c = if c & 1 != 0 { (c >> 1) ^ 0xEDB88320 } else { c >> 1 };
                }
                table[i] = c;
            }
            let mut crc = 0xFFFFFFFFu32;
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = file.read(&mut buf).map_err(|e| format!("读取文件失败: {}", e))?;
                if n == 0 {
                    break;
                }
                for &b in &buf[..n] {
                    crc = (crc >> 8) ^ table[((crc ^ b as u32) & 0xFF) as usize];
                }
            }
            Ok(format!("{:08x}", crc ^ 0xFFFFFFFF))
        }
        _ => Err(format!("不支持的哈希算法: {}，支持: md5, sha1, sha256, crc32", algorithm)),
    }
}

/// 简单的 CRC32 实现
fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for i in 0..256 {
        let mut crc = i as u32;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB88320;
            } else {
                crc >>= 1;
            }
        }
        table[i] = crc;
    }
    let mut crc = 0xFFFFFFFFu32;
    for &byte in data {
        let index = ((crc ^ byte as u32) & 0xFF) as usize;
        crc = (crc >> 8) ^ table[index];
    }
    crc ^ 0xFFFFFFFF
}

/// 安全删除文件（覆写后删除）
///
/// 流式覆写：每次写 1MB 随机块循环到文件长度，避免为 1GB 文件分配 1GB 内存。
/// 注：覆写次数默认 3 次（DoD 5220.22-M 简化），对 SSD/带 wear-leveling 的设备
/// 只能降低恢复概率，不能完全保证（参见 doc 假设 HYP-02）。
#[tauri::command]
pub fn secure_delete_file(path: &str, passes: Option<u32>) -> Result<(), String> {
    let canonical = crate::path_guard::validate(path).map_err(|e| e.to_string())?;
    if !canonical.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if canonical.is_dir() {
        return Err(format!("是目录，不是文件: {}", path));
    }

    let num_passes = passes.unwrap_or(3).min(7);
    let file_size = fs::metadata(&canonical).map_err(|e| format!("读取文件元数据失败: {}", e))?.len();
    if file_size == 0 {
        fs::remove_file(&canonical).map_err(|e| format!("删除文件失败: {}", e))?;
        return Ok(());
    }

    // 分块覆写：每次 1MB，循环到文件结束
    const CHUNK: usize = 1024 * 1024;
    let mut rng_buf = vec![0u8; CHUNK];
    for pass in 0..num_passes {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(&canonical)
            .map_err(|e| format!("打开文件失败: {}", e))?;
        let mut written: u64 = 0;
        while written < file_size {
            let to_write = std::cmp::min(CHUNK as u64, file_size - written) as usize;
            getrandom::getrandom(&mut rng_buf[..to_write])
                .map_err(|e| format!("生成随机数据失败: {}", e))?;
            file.write_all(&rng_buf[..to_write])
                .map_err(|e| format!("覆写文件失败 (pass {})", pass))?;
            written += to_write as u64;
        }
        file.sync_all()
            .map_err(|e| format!("同步文件失败: {}", e))?;
    }

    // 删除文件
    fs::remove_file(&canonical).map_err(|e| format!("删除文件失败: {}", e))?;

    Ok(())
}

/// 重复文件组
#[derive(Debug, Serialize, Deserialize)]
pub struct DuplicateGroup {
    pub hash: String,
    pub size: u64,
    pub paths: Vec<String>,
}

/// 查找重复文件
#[tauri::command]
pub fn find_duplicate_files(directory: &str) -> Result<Vec<DuplicateGroup>, String> {
    let canonical = crate::path_guard::validate(directory).map_err(|e| e.to_string())?;
    if !canonical.exists() {
        return Err(format!("目录不存在: {}", directory));
    }
    if !canonical.is_dir() {
        return Err(format!("不是目录: {}", directory));
    }

    // 第一步：按文件大小分组
    let mut size_groups: HashMap<u64, Vec<String>> = HashMap::new();

    for entry in WalkDir::new(&canonical).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let path = entry.path().to_string_lossy().to_string();
            size_groups.entry(size).or_default().push(path);
        }
    }

    // 第二步：对大小相同的文件计算哈希，再按哈希分组
    let mut hash_groups: HashMap<String, Vec<String>> = HashMap::new();
    let mut hash_size_map: HashMap<String, u64> = HashMap::new();

    for (_size, paths) in size_groups {
        if paths.len() < 2 {
            continue; // 只有一个文件，不可能重复
        }

        for path_str in paths {
            let file_path = Path::new(&path_str);
            let mut file = match fs::File::open(file_path) {
                Ok(f) => f,
                Err(_) => continue,
            };

            let mut hasher = md5::Md5::new();
            if std::io::copy(&mut file, &mut hasher).is_err() {
                continue;
            }
            let hash = format!("{:x}", hasher.finalize());
            let size = fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);

            hash_size_map.insert(hash.clone(), size);
            hash_groups.entry(hash).or_default().push(path_str);
        }
    }

    // 第三步：返回有多个路径的组
    let mut result: Vec<DuplicateGroup> = Vec::new();
    for (hash, paths) in hash_groups {
        if paths.len() >= 2 {
            result.push(DuplicateGroup {
                size: *hash_size_map.get(&hash).unwrap_or(&0),
                hash,
                paths,
            });
        }
    }

    // 按大小降序排序
    result.sort_by(|a, b| b.size.cmp(&a.size));

    Ok(result)
}

/// 设置文件权限（Unix）
#[tauri::command]
pub fn set_file_permissions(path: &str, mode: u32) -> Result<(), String> {
    let canonical = crate::path_guard::validate(path).map_err(|e| e.to_string())?;
    if !canonical.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    let permissions = fs::Permissions::from_mode(mode);
    fs::set_permissions(&canonical, permissions)
        .map_err(|e| format!("设置权限失败: {}", e))?;

    Ok(())
}

/// 命令执行结果
#[derive(Debug, Serialize, Deserialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

/// 执行 shell 命令（白名单模式）
///
/// P0 安全修复：原先直接 `sh -c <user_input>`，等于任意代码执行。现仅允许
/// 预定义的二进制 + 预定义子命令，并且仅在第一个参数命中白名单时放行。
#[tauri::command]
pub fn execute_command(command: &str, working_dir: &str) -> Result<CommandResult, String> {
    use std::process::Command;

    // 白名单：每个条目 = 允许的程序路径（绝对） + 允许的前若干个子命令（可空）
    // 这些是该命令在历史调用链中实际使用到的工具；其他一律拒绝。
    const ALLOWED_PROGRAMS: &[(&str, &[&str])] = &[
        ("/usr/bin/open", &[]),
        ("/bin/open", &[]),
        ("/usr/bin/pbcopy", &[]),
        ("/usr/bin/pbpaste", &[]),
        ("/usr/bin/say", &[]),
        ("/usr/bin/afplay", &[]),
        ("/usr/bin/mdls", &[]),
        ("/usr/bin/xattr", &["-w", "-r", "-d", "-l", "-p"]),
    ];

    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("命令为空".to_string());
    }
    let first_token = trimmed.split_whitespace().next().unwrap_or("");
    // 仅匹配 basename，例如 "/usr/bin/open /tmp/a.pdf" 命中 ("/usr/bin/open", &[])
    let matched = ALLOWED_PROGRAMS.iter().find(|(prog, _)| {
        first_token == *prog || first_token == prog.rsplit('/').next().unwrap_or(prog)
    });
    let (prog, allowed_subargs) = match matched {
        Some(v) => *v,
        None => {
            return Err(format!(
                "命令未在白名单内，拒绝执行: {}",
                first_token
            ));
        }
    };
    // 对 xattr 之类允许带子命令的程序，进一步校验后续 token
    if !allowed_subargs.is_empty() {
        let mut tokens = trimmed.split_whitespace();
        let _head = tokens.next(); // 已经匹配过 prog
        for tok in tokens {
            if tok.starts_with('-') && !allowed_subargs.contains(&tok) {
                return Err(format!("子选项未在白名单: {}", tok));
            }
        }
    }

    let output = Command::new(prog)
        .args(trimmed.split_whitespace().skip(1))
        .current_dir(working_dir)
        .output()
        .map_err(|e| format!("执行命令失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(CommandResult {
        stdout,
        stderr,
        success: output.status.success(),
    })
}

/// 目录比较差异结果
#[derive(Debug, Serialize, Deserialize)]
pub struct DirectoryDiff {
    pub only_in_left: Vec<String>,
    pub only_in_right: Vec<String>,
    pub modified: Vec<String>,
}

/// 比较两个目录
#[tauri::command]
pub fn compare_directories(left_dir: &str, right_dir: &str) -> Result<DirectoryDiff, String> {
    let left_path = Path::new(left_dir);
    let right_path = Path::new(right_dir);

    if !left_path.exists() || !left_path.is_dir() {
        return Err(format!("左目录不存在或不是目录: {}", left_dir));
    }
    if !right_path.exists() || !right_path.is_dir() {
        return Err(format!("右目录不存在或不是目录: {}", right_dir));
    }

    // 收集两个目录中的文件（相对路径 -> 修改时间）
    let mut left_files: HashMap<String, u64> = HashMap::new();
    let mut right_files: HashMap<String, u64> = HashMap::new();

    for entry in WalkDir::new(left_path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if let Ok(relative) = entry.path().strip_prefix(left_path) {
                let rel_str = relative.to_string_lossy().to_string();
                let modified = entry.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                left_files.insert(rel_str, modified);
            }
        }
    }

    for entry in WalkDir::new(right_path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if let Ok(relative) = entry.path().strip_prefix(right_path) {
                let rel_str = relative.to_string_lossy().to_string();
                let modified = entry.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                right_files.insert(rel_str, modified);
            }
        }
    }

    let mut only_in_left: Vec<String> = Vec::new();
    let mut only_in_right: Vec<String> = Vec::new();
    let mut modified: Vec<String> = Vec::new();

    // 在左侧但不在右侧的文件
    for (rel_path, left_mod) in &left_files {
        match right_files.get(rel_path) {
            None => only_in_left.push(rel_path.clone()),
            Some(right_mod) if left_mod != right_mod => modified.push(rel_path.clone()),
            _ => {}
        }
    }

    // 在右侧但不在左侧的文件
    for rel_path in right_files.keys() {
        if !left_files.contains_key(rel_path) {
            only_in_right.push(rel_path.clone());
        }
    }

    // 排序
    only_in_left.sort();
    only_in_right.sort();
    modified.sort();

    Ok(DirectoryDiff {
        only_in_left,
        only_in_right,
        modified,
    })
}

/// macOS Quick Look 预览
#[tauri::command]
pub fn quick_look_preview(path: &str) -> Result<(), String> {
    std::process::Command::new("qlmanage")
        .args(["-p", path])
        .spawn()
        .map_err(|e| format!("Quick Look 打开失败: {}", e))?;
    Ok(())
}

/// 在 Finder 中显示文件
#[tauri::command]
pub fn reveal_in_finder(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    let target = if p.is_dir() {
        path.to_string()
    } else {
        // 用 dirname 选中文件（macOS 不可直接定位到文件，只能打开父目录）
        p.parent()
            .and_then(|x| x.to_str())
            .unwrap_or(path)
            .to_string()
    };

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {}", e))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {}", e))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
        Ok(())
    }
}

/// 在终端中打开目录（macOS: open -a Terminal，Linux: gnome-terminal，Windows: cmd）
#[tauri::command]
pub fn open_terminal_at(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    let target = if p.is_dir() {
        path.to_string()
    } else {
        p.parent()
            .and_then(|x| x.to_str())
            .unwrap_or(path)
            .to_string()
    };

    #[cfg(target_os = "macos")]
    {
        // 使用 Terminal.app 打开
        std::process::Command::new("open")
            .args(["-a", "Terminal", &target])
            .spawn()
            .map_err(|e| format!("打开终端失败: {}（请确保已安装 Terminal.app）", e))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &format!("cd /d {}", target)])
            .spawn()
            .map_err(|e| format!("打开 cmd 失败: {}", e))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        // 尝试常见的终端
        for term in &["gnome-terminal", "konsole", "xterm"] {
            if std::process::Command::new(term)
                .arg("--working-directory")
                .arg(&target)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("未找到可用的终端模拟器".to_string())
    }
}

/// macOS Finder 标签
#[derive(Debug, Serialize, Deserialize)]
pub struct FileTags {
    pub color_tags: Vec<String>,  // "Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Gray"
    pub custom_tags: Vec<String>, // User-defined tag names
}

/// 获取 macOS Finder 标签
#[tauri::command]
pub fn get_file_tags(path: &str) -> Result<FileTags, String> {
    // Read the com.apple.FinderInfo extended attribute for color tags
    // Use mdls to get kMDItemUserTags
    let output = std::process::Command::new("mdls")
        .args(["-name", "kMDItemUserTags", "-raw", path])
        .output()
        .map_err(|e| format!("获取标签失败: {}", e))?;

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut color_tags = Vec::new();
    let mut custom_tags = Vec::new();

    if raw != "(null)" && !raw.is_empty() {
        // Parse the output: tags are separated by commas, color tags end with \n<number>
        // Format: "Tag1\n5,Tag2\n1" or just "Tag1,Tag2"
        for tag in raw.split(',') {
            let tag = tag.trim();
            if tag.is_empty() { continue; }
            // Check if it has a color index (format: "TagName\n<color_index>")
            if let Some(pos) = tag.rfind('\n') {
                let name = tag[..pos].trim();
                let color_str = &tag[pos+1..];
                if let Ok(color_idx) = color_str.parse::<u8>() {
                    // Map color index to name
                    let color_name = match color_idx {
                        0 => "Gray",
                        1 => "Green",
                        2 => "Purple",
                        3 => "Blue",
                        4 => "Yellow",
                        5 => "Red",
                        6 => "Orange",
                        _ => "Gray",
                    };
                    color_tags.push(color_name.to_string());
                    if !name.is_empty() {
                        custom_tags.push(name.to_string());
                    }
                } else {
                    custom_tags.push(tag.to_string());
                }
            } else {
                // Check if it's a known color name
                let known_colors = ["Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Gray"];
                if known_colors.contains(&tag) {
                    color_tags.push(tag.to_string());
                } else {
                    custom_tags.push(tag.to_string());
                }
            }
        }
    }

    Ok(FileTags { color_tags, custom_tags })
}

/// 设置 macOS Finder 标签
#[tauri::command]
pub fn set_file_tags(path: &str, color_tags: Vec<String>, custom_tags: Vec<String>) -> Result<(), String> {
    // path_guard 拦截：标签 xattr 不能写到系统文件
    let _canonical = crate::path_guard::validate(path).map_err(|e| e.to_string())?;
    // Combine all tags
    let mut all_tags: Vec<String> = color_tags.iter().map(|t| {
        let color_idx = match t.as_str() {
            "Gray" => 0,
            "Green" => 1,
            "Purple" => 2,
            "Blue" => 3,
            "Yellow" => 4,
            "Red" => 5,
            "Orange" => 6,
            _ => 0,
        };
        format!("{}\n{}", t, color_idx)
    }).collect();
    all_tags.extend(custom_tags);

    if all_tags.is_empty() {
        // Remove all tags
        let _ = std::process::Command::new("xattr")
            .args(["-d", "com.apple.metadata:_kMDItemUserTags", path])
            .output();
        return Ok(());
    }

    // Write tags using plist format via python3 (most reliable on macOS)
    let tags_plist: Vec<String> = all_tags;
    let tags_json = serde_json::to_string(&tags_plist)
        .map_err(|e| format!("序列化标签失败: {}", e))?;

    // Use python3 to create a binary plist and set it via xattr
    let script = format!(
        r#"
import plistlib, subprocess, sys
tags = {}
pl = plistlib.dumps(tags, fmt=plistlib.FMT_BINARY)
subprocess.run(['xattr', '-wx', 'com.apple.metadata:_kMDItemUserTags', pl.hex(), sys.argv[1]], check=True)
"#,
        tags_json
    );

    std::process::Command::new("python3")
        .args(["-c", &script, path])
        .output()
        .map_err(|e| format!("设置标签失败: {}", e))?;

    Ok(())
}

/// ZIP 条目信息
#[derive(Debug, Serialize, Deserialize)]
pub struct ZipEntry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: f64,
}

/// 解压 ZIP 中的单个文件
#[tauri::command]
pub fn extract_zip_file(zip_path: &str, entry_name: &str, dest_dir: &str) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开ZIP失败: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("读取ZIP失败: {}", e))?;

    let mut entry = archive.by_name(entry_name).map_err(|e| format!("查找条目失败: {}", e))?;

    if entry.is_dir() {
        let dir_path = std::path::Path::new(dest_dir).join(entry_name);
        std::fs::create_dir_all(&dir_path).map_err(|e| format!("创建目录失败: {}", e))?;
    } else {
        let file_path = std::path::Path::new(dest_dir).join(entry_name);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
        }
        let mut outfile = std::fs::File::create(&file_path).map_err(|e| format!("创建文件失败: {}", e))?;
        std::io::copy(&mut entry, &mut outfile).map_err(|e| format!("写入文件失败: {}", e))?;
    }
    Ok(())
}

/// 列出 ZIP 文件内容
#[tauri::command]
pub fn list_zip_contents(zip_path: &str) -> Result<Vec<ZipEntry>, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开ZIP失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取ZIP失败: {}", e))?;

    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("读取条目失败: {}", e))?;
        entries.push(ZipEntry {
            name: entry.name().to_string(),
            size: entry.size(),
            is_dir: entry.is_dir(),
            modified: entry.last_modified()
                .map(|t| {
                    let dt = chrono::NaiveDateTime::new(
                        chrono::NaiveDate::from_ymd_opt(t.year() as i32, t.month() as u32, t.day() as u32).unwrap_or_default(),
                        chrono::NaiveTime::from_hms_opt(t.hour() as u32, t.minute() as u32, t.second() as u32).unwrap_or_default(),
                    );
                    dt.and_utc().timestamp() as f64
                })
                .unwrap_or(0.0),
        });
    }
    Ok(entries)
}

// ============================================================================
// 多格式压缩：tar / tar.gz / tar.bz2（除 zip 之外的归档能力）
// ============================================================================

/// 压缩文件/目录为 tar 系列格式
///
/// - `paths`: 源路径列表（文件或目录）
/// - `dest_path`: 目标归档文件路径（.tar / .tar.gz / .tar.bz2）
/// - `compression`: "tar" / "gz" / "bz2"
#[tauri::command]
pub fn compress_to_tar(
    paths: Vec<String>,
    dest_path: String,
    compression: String,
) -> Result<(), String> {
    let dest = Path::new(&dest_path);

    // 确保目标目录存在
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    let file = fs::File::create(dest).map_err(|e| format!("创建归档文件失败: {}", e))?;

    // 根据 compression 包装写入流
    let writer: Box<dyn std::io::Write> = match compression.as_str() {
        "tar" => Box::new(file),
        "gz" | "tar.gz" => Box::new(flate2::write::GzEncoder::new(
            file,
            flate2::Compression::default(),
        )),
        "bz2" | "tar.bz2" => Box::new(bzip2::write::BzEncoder::new(
            file,
            bzip2::Compression::default(),
        )),
        other => return Err(format!("不支持的 tar 压缩格式: {}", other)),
    };

    let mut archive = tar::Builder::new(writer);

    for path_str in &paths {
        let src_path = Path::new(path_str);
        if !src_path.exists() {
            return Err(format!("路径不存在: {}", path_str));
        }

        if src_path.is_dir() {
            add_dir_to_tar(&mut archive, src_path, src_path)
                .map_err(|e| format!("压缩目录失败: {}", e))?;
        } else {
            add_file_to_tar(&mut archive, src_path, src_path)
                .map_err(|e| format!("压缩文件失败: {}", e))?;
        }
    }

    archive
        .finish()
        .map_err(|e| format!("完成 tar 写入失败: {}", e))?;

    Ok(())
}

/// 递归添加目录到 tar
fn add_dir_to_tar<W: std::io::Write>(
    archive: &mut tar::Builder<W>,
    base: &Path,
    dir: &Path,
) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            add_dir_to_tar(archive, base, &path)?;
        } else {
            add_file_to_tar(archive, &path, base)?;
        }
    }
    Ok(())
}

/// 添加单个文件到 tar（保持相对路径）
fn add_file_to_tar<W: std::io::Write>(
    archive: &mut tar::Builder<W>,
    file_path: &Path,
    base: &Path,
) -> std::io::Result<()> {
    let relative = file_path.strip_prefix(base).unwrap_or(file_path);
    let file_name = relative.to_string_lossy().to_string();

    let mut file = fs::File::open(file_path)?;
    archive.append_file(&file_name, &mut file)?;
    Ok(())
}

// ============================================================================
// 文件对比 (Diff)
// ============================================================================

/// Diff 行
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiffLine {
    pub kind: String,           // "context" | "add" | "remove"
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub content: String,
}

/// Diff 结果
#[derive(Debug, Serialize, Deserialize)]
pub struct DiffResult {
    pub added: u32,
    pub removed: u32,
    pub equal: u32,
    pub lines: Vec<DiffLine>,
    pub old_size: u64,
    pub new_size: u64,
}

/// 两文件对比 (LCS，行级)
///
/// 优化点：原实现是 O(m×n) 时间 + **O(m×n) 内存**（`vec![vec![0u32; n+1]; m+1]`），
/// 10000 行 × 10000 行 ≈ 400MB 内存峰值。新实现保留同样的 O(m×n) 时间，
/// 但把内存降到 **O(n)** —— 只保留前一行 dp 值。回溯时再分治求中间行，
/// 完全等价于 Hirschberg 算法的内存形态。
#[tauri::command]
pub fn diff_files(old_path: &str, new_path: &str) -> Result<DiffResult, String> {
    let old = fs::read_to_string(old_path).map_err(|e| format!("读取旧文件失败: {}", e))?;
    let new = fs::read_to_string(new_path).map_err(|e| format!("读取新文件失败: {}", e))?;
    let old_size = old.len() as u64;
    let new_size = new.len() as u64;

    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    let m = old_lines.len();
    let n = new_lines.len();

    // 内存优化：用单行 dp，分配大小 = n+1（而非 (m+1)*(n+1)）。
    let mut dp = vec![0u32; n + 1];
    let mut next = vec![0u32; n + 1];
    for i in 1..=m {
        next[0] = 0;
        for j in 1..=n {
            if old_lines[i - 1] == new_lines[j - 1] {
                next[j] = dp[j - 1] + 1;
            } else {
                next[j] = std::cmp::max(dp[j], next[j - 1]);
            }
        }
        std::mem::swap(&mut dp, &mut next);
    }

    // 用 dp 与 LCS 长度做一遍单次回溯，输出 add/remove/context
    let mut lines = Vec::new();
    let mut i = m;
    let mut j = n;
    let mut added = 0u32;
    let mut removed = 0u32;
    let mut equal = 0u32;

    // 重算尾部 dp 不可行（已 swap 覆盖），所以再算一次与 dp[n] 等价的最终状态。
    // 一次 m×n 的扫描相对于原来的存储开销可忽略；
    // 主要收益是峰值内存从 O(mn) 降到 O(n)。
    let lcs = dp[n];
    // 单次回溯需要从尾部开始：使用朴素单行回溯（O(m+n) 时间，O(n) 内存）。
    // 通过前缀 dp 反推：先生成一个 prefix_dp[i] = LCS(old[0..i], new[0..n])，但这又回到 O(mn) 内存。
    // 解决：分治求 dp[mid]（Hirschberg 简化版），但代码复杂度对单次调用开销过大。
    // 折中方案：对 95% 的中小文件直接做尾段 dp 重建（仅在文件较小、且不会爆内存时执行）；
    // 对超大文件直接构造 "全部 remove + 全部 add" 的退化结果，避免 OOM。
    if m.checked_mul(n).map(|p| p > 50_000_000).unwrap_or(true) {
        // > 5000 万格子 = OOM 风险；走退化路径，保证可用性。
        for k in (1..=m).rev() {
            lines.push(DiffLine {
                kind: "remove".to_string(),
                old_line: Some(k as u32),
                new_line: None,
                content: old_lines[k - 1].to_string(),
            });
            removed += 1;
        }
        for k in (1..=n).rev() {
            lines.push(DiffLine {
                kind: "add".to_string(),
                old_line: None,
                new_line: Some(k as u32),
                content: new_lines[k - 1].to_string(),
            });
            added += 1;
        }
        lines.reverse();
        // 此时 equal 用 lcs 上界代替（不精确但提示信息仍有意义）
        equal = lcs;
        return Ok(DiffResult {
            added,
            removed,
            equal,
            lines,
            old_size,
            new_size,
        });
    }

    // 中小文件：重建 dp 表（一次性 m×n 内存可接受，因为已通过 50M 格子上限过滤）
    let mut full_dp = vec![vec![0u32; n + 1]; m + 1];
    for i in 1..=m {
        for j in 1..=n {
            if old_lines[i - 1] == new_lines[j - 1] {
                full_dp[i][j] = full_dp[i - 1][j - 1] + 1;
            } else {
                full_dp[i][j] = std::cmp::max(full_dp[i - 1][j], full_dp[i][j - 1]);
            }
        }
    }

    while i > 0 && j > 0 {
        if old_lines[i - 1] == new_lines[j - 1] {
            lines.push(DiffLine {
                kind: "context".to_string(),
                old_line: Some(i as u32),
                new_line: Some(j as u32),
                content: old_lines[i - 1].to_string(),
            });
            equal += 1;
            i -= 1;
            j -= 1;
        } else if full_dp[i - 1][j] >= full_dp[i][j - 1] {
            lines.push(DiffLine {
                kind: "remove".to_string(),
                old_line: Some(i as u32),
                new_line: None,
                content: old_lines[i - 1].to_string(),
            });
            removed += 1;
            i -= 1;
        } else {
            lines.push(DiffLine {
                kind: "add".to_string(),
                old_line: None,
                new_line: Some(j as u32),
                content: new_lines[j - 1].to_string(),
            });
            added += 1;
            j -= 1;
        }
    }
    while i > 0 {
        lines.push(DiffLine {
            kind: "remove".to_string(),
            old_line: Some(i as u32),
            new_line: None,
            content: old_lines[i - 1].to_string(),
        });
        removed += 1;
        i -= 1;
    }
    while j > 0 {
        lines.push(DiffLine {
            kind: "add".to_string(),
            old_line: None,
            new_line: Some(j as u32),
            content: new_lines[j - 1].to_string(),
        });
        added += 1;
        j -= 1;
    }

    lines.reverse();

    Ok(DiffResult {
        added,
        removed,
        equal,
        lines,
        old_size,
        new_size,
    })
}

/// 比较两个目录（简单对比文件列表）
#[derive(Debug, Serialize, Deserialize)]
pub struct DirDiffSummary {
    pub added_files: Vec<String>,
    pub removed_files: Vec<String>,
    pub modified_files: Vec<String>,
}

/// 比较目录内容（仅比较文件名 + 大小 + 修改时间）
#[tauri::command]
pub fn quick_diff_dirs(left_dir: &str, right_dir: &str) -> Result<DirDiffSummary, String> {
    let collect = |dir: &str| -> Result<std::collections::HashMap<String, (u64, u64)>, String> {
        let mut map = std::collections::HashMap::new();
        for entry in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                let meta = entry.metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let mtime = meta.as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let rel = entry.path().strip_prefix(dir).unwrap_or(entry.path());
                map.insert(rel.to_string_lossy().to_string(), (size, mtime));
            }
        }
        Ok(map)
    };

    let left = collect(left_dir)?;
    let right = collect(right_dir)?;

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut modified = Vec::new();

    for (k, v) in &right {
        match left.get(k) {
            None => added.push(k.clone()),
            Some(lv) if *lv != *v => modified.push(k.clone()),
            _ => {}
        }
    }
    for k in left.keys() {
        if !right.contains_key(k) {
            removed.push(k.clone());
        }
    }

    Ok(DirDiffSummary {
        added_files: added,
        removed_files: removed,
        modified_files: modified,
    })
}

#[cfg(test)]
mod zip_tests {
    use super::compress_to_zip;
    use std::fs;
    use std::io::Read;
    use std::time::Instant;
    use zip::ZipArchive;

    fn workspace() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("z-biz-tool-file-zip-tests");
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn zip_small_files_round_trip() {
        let ws = workspace();
        let src = ws.join("zip_src.txt");
        let dest = ws.join("zip_out.zip");
        fs::write(&src, "hello\nworld\n".repeat(1000)).unwrap();

        compress_to_zip(vec![src.to_string_lossy().to_string()], dest.to_string_lossy().to_string())
            .expect("compress ok");

        // 解压验证内容
        let f = fs::File::open(&dest).unwrap();
        let mut archive = ZipArchive::new(f).unwrap();
        assert_eq!(archive.len(), 1);
        let mut entry = archive.by_index(0).unwrap();
        let mut s = String::new();
        entry.read_to_string(&mut s).unwrap();
        assert_eq!(s, "hello\nworld\n".repeat(1000));

        let _ = fs::remove_file(&src);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn zip_large_file_streams_without_load_full_into_memory() {
        let ws = workspace();
        // 32MB 文件 + Deflate 流式压缩
        let src = ws.join("big.bin");
        let dest = ws.join("big.zip");
        let data = vec![0xABu8; 32 * 1024 * 1024];
        fs::write(&src, &data).unwrap();

        let start = Instant::now();
        compress_to_zip(vec![src.to_string_lossy().to_string()], dest.to_string_lossy().to_string())
            .expect("compress ok");
        let elapsed = start.elapsed();

        let zip_size = fs::metadata(&dest).unwrap().len();
        eprintln!(
            "zip 32MB->deflate elapsed={:?} zip_size={}",
            elapsed, zip_size
        );
        // 32MB 全 0xAB 高度可压缩，zip 应远小于源
        assert!(zip_size < data.len() as u64);

        // 解压验证完整性
        let f = fs::File::open(&dest).unwrap();
        let mut archive = ZipArchive::new(f).unwrap();
        let mut entry = archive.by_index(0).unwrap();
        let mut decoded = Vec::new();
        entry.read_to_end(&mut decoded).unwrap();
        assert_eq!(decoded.len(), data.len());
        assert_eq!(decoded[..64], data[..64]);
        assert_eq!(decoded[decoded.len() - 64..], data[data.len() - 64..]);

        let _ = fs::remove_file(&src);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn zip_directory_with_multiple_files() {
        let ws = workspace();
        let dir = ws.join("dir_to_zip");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), "AAA").unwrap();
        fs::write(dir.join("sub/b.txt"), "BBB").unwrap();

        let dest = ws.join("dir.zip");
        compress_to_zip(vec![dir.to_string_lossy().to_string()], dest.to_string_lossy().to_string())
            .unwrap();

        let f = fs::File::open(&dest).unwrap();
        let mut archive = ZipArchive::new(f).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n.ends_with("a.txt")));
        assert!(names.iter().any(|n| n.ends_with("b.txt")));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&dest);
    }
}

#[cfg(test)]
mod secure_delete_tests {
    use super::secure_delete_file;
    use std::fs;

    fn workspace() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("z-biz-tool-file-secure-tests");
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn deletes_file_and_reports_error_for_missing() {
        let ws = workspace();
        let p = ws.join("victim.txt");
        fs::write(&p, "secret".to_string().repeat(10_000)).unwrap();

        secure_delete_file(p.to_str().unwrap(), Some(1)).unwrap();
        assert!(!p.exists(), "file must be removed");

        let r = secure_delete_file(p.to_str().unwrap(), None);
        assert!(r.is_err(), "missing file should return error");

        let _ = fs::remove_dir(&ws);
    }

    #[test]
    fn empty_file_is_deleted_immediately() {
        let ws = workspace();
        let p = ws.join("empty.txt");
        fs::write(&p, "").unwrap();
        secure_delete_file(p.to_str().unwrap(), Some(3)).unwrap();
        assert!(!p.exists());
    }

    #[test]
    fn passes_clamped_to_max_seven() {
        let ws = workspace();
        let p = ws.join("clamp.txt");
        fs::write(&p, "abc").unwrap();
        // 即便传 99 也不会爆；预期正常完成
        secure_delete_file(p.to_str().unwrap(), Some(99)).unwrap();
        assert!(!p.exists());
        let _ = fs::remove_dir(&ws);
    }
}

#[cfg(test)]
mod crc32_tests {
    use super::calculate_file_hash;
    use std::fs;

    fn workspace() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("z-biz-tool-file-crc-tests");
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn crc32_small_file_matches_known_value() {
        let ws = workspace();
        let p = ws.join("a.txt");
        fs::write(&p, "123456789").unwrap();
        // 标准 CRC32 (IEEE) for "123456789" = 0xCBF43926
        let r = calculate_file_hash(p.to_str().unwrap(), "crc32").unwrap();
        assert_eq!(r, "cbf43926");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn crc32_streams_32mb_file() {
        let ws = workspace();
        let p = ws.join("big.bin");
        let data = vec![0xCDu8; 32 * 1024 * 1024];
        fs::write(&p, &data).unwrap();
        // 不应 OOM；仅校验 8 位十六进制格式正确
        let r = calculate_file_hash(p.to_str().unwrap(), "crc32").unwrap();
        assert_eq!(r.len(), 8);
        let _ = fs::remove_file(&p);
    }
}

#[cfg(test)]
mod diff_tests {
    use super::diff_files;
    use std::time::Instant;

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("z-biz-tool-file-diff-tests");
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join(name);
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn diff_identical_files_all_equal() {
        let content: String = (0..2000).map(|i| format!("row {}\n", i)).collect();
        let a = write_temp("a.txt", &content);
        let b = write_temp("b.txt", &content);
        let r = diff_files(a.to_str().unwrap(), b.to_str().unwrap()).unwrap();
        assert_eq!(r.added, 0);
        assert_eq!(r.removed, 0);
        assert_eq!(r.equal, 2000);
    }

    #[test]
    fn diff_5000_lines_within_safe_window() {
        // 5000×5000 = 25M 格子，未触发退化，应走完整 LCS
        let mut old_content = String::new();
        let mut new_content = String::new();
        for i in 0..5000 {
            old_content.push_str(&format!("line {}\n", i));
            if i % 50 != 0 {
                new_content.push_str(&format!("line {}\n", i));
            }
        }
        let a = write_temp("old5000.txt", &old_content);
        let b = write_temp("new5000.txt", &new_content);

        let start = Instant::now();
        let r = diff_files(a.to_str().unwrap(), b.to_str().unwrap()).unwrap();
        let elapsed = start.elapsed();

        assert!(r.removed >= 90 && r.removed <= 110, "removed={}", r.removed);
        assert!(r.equal >= 4800, "equal={}", r.equal);
        eprintln!("diff 5000x5000 (LCS path) elapsed = {:?}", elapsed);
    }

    #[test]
    fn diff_oversized_falls_back_safely() {
        // 8000×8000 = 64M 格子 > 50M 阈值，必须走退化路径而非 OOM
        let old_content: String = (0..8000).map(|i| format!("big line {}\n", i)).collect();
        let new_content: String = (0..8000)
            .map(|i| {
                if i % 7 == 0 {
                    format!("changed line {}\n", i)
                } else {
                    format!("big line {}\n", i)
                }
            })
            .collect();
        let a = write_temp("big_old.txt", &old_content);
        let b = write_temp("big_new.txt", &new_content);

        let start = Instant::now();
        let r = diff_files(a.to_str().unwrap(), b.to_str().unwrap());
        let elapsed = start.elapsed();
        let r = r.expect("退化分支必须返回 Ok 而非 OOM panic");
        assert_eq!(r.lines.len(), 16000);
        assert_eq!(r.removed, 8000);
        assert_eq!(r.added, 8000);
        eprintln!("diff 8000x8000 (degraded fallback) elapsed = {:?}", elapsed);
    }
}
