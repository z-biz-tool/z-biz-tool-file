use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read as IoRead, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use walkdir::WalkDir;
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

/// 复制文件/目录
#[tauri::command]
pub fn copy_file(src_path: &str, dest_dir: &str) -> Result<String, String> {
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

    if src.is_dir() {
        copy_dir_recursive(src, &dest_path).map_err(|e| format!("复制目录失败: {}", e))?;
    } else {
        fs::copy(src, &dest_path).map_err(|e| format!("复制文件失败: {}", e))?;
    }

    Ok(dest_path.to_string_lossy().to_string())
}

/// 创建新文件
#[tauri::command]
pub fn create_file(path: &str) -> Result<(), String> {
    let file_path = Path::new(path);
    if file_path.exists() {
        return Err(format!("文件已存在: {}", path));
    }

    // 确保父目录存在
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
    }

    fs::File::create(file_path).map_err(|e| format!("创建文件失败: {}", e))?;

    Ok(())
}

/// 创建新目录（包括父目录）
#[tauri::command]
pub fn create_directory(path: &str) -> Result<(), String> {
    let dir_path = Path::new(path);
    if dir_path.exists() {
        return Err(format!("目录已存在: {}", path));
    }

    fs::create_dir_all(dir_path).map_err(|e| format!("创建目录失败: {}", e))?;

    Ok(())
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
        let path = Path::new(path_str);
        if !path.exists() {
            errors.push(format!("路径不存在: {}", path_str));
            continue;
        }

        let old_name = path
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
                if let Some(ext) = path.extension() {
                    let stem = path
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

        let parent = match path.parent() {
            Some(p) => p,
            None => {
                errors.push(format!("无法获取父目录: {}", path_str));
                continue;
            }
        };

        let new_path = parent.join(&new_name);

        match fs::rename(path, &new_path) {
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
fn add_file_to_zip<W: std::io::Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    file_path: &Path,
    base: &Path,
    options: &SimpleFileOptions,
) -> std::io::Result<()> {
    let relative = file_path.strip_prefix(base).unwrap_or(file_path);
    let file_name = relative.to_string_lossy().to_string();

    let mut file = fs::File::open(file_path)?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;

    zip.start_file(&file_name, options.clone())?;
    zip.write_all(&buf)?;

    Ok(())
}

/// 解压 ZIP 文件
#[tauri::command]
pub fn extract_zip(zip_path: &str, dest_dir: &str) -> Result<(), String> {
    let src = Path::new(zip_path);
    if !src.exists() {
        return Err(format!("ZIP文件不存在: {}", zip_path));
    }

    let dest = Path::new(dest_dir);
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
    let dir_path = Path::new(path);
    if !dir_path.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(format!("不是目录: {}", path));
    }

    let mut total_size: u64 = 0;

    for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            total_size += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }

    Ok(total_size)
}

/// 计算文件哈希值（支持 MD5、SHA1、SHA256、CRC32）
#[tauri::command]
pub fn calculate_file_hash(path: &str, algorithm: &str) -> Result<String, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if file_path.is_dir() {
        return Err(format!("是目录，不是文件: {}", path));
    }

    let mut file = fs::File::open(file_path).map_err(|e| format!("打开文件失败: {}", e))?;

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
            let mut buf = Vec::new();
            file.read_to_end(&mut buf).map_err(|e| format!("读取文件失败: {}", e))?;
            let crc = crc32(&buf);
            Ok(format!("{:08x}", crc))
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
#[tauri::command]
pub fn secure_delete_file(path: &str, passes: Option<u32>) -> Result<(), String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if file_path.is_dir() {
        return Err(format!("是目录，不是文件: {}", path));
    }

    let num_passes = passes.unwrap_or(3);
    let file_size = fs::metadata(file_path).map_err(|e| format!("读取文件元数据失败: {}", e))?.len();

    // 多次覆写随机数据
    for _ in 0..num_passes {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(file_path)
            .map_err(|e| format!("打开文件失败: {}", e))?;

        let mut random_data = vec![0u8; file_size as usize];
        getrandom::getrandom(&mut random_data)
            .map_err(|e| format!("生成随机数据失败: {}", e))?;
        file.write_all(&random_data)
            .map_err(|e| format!("覆写文件失败: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("同步文件失败: {}", e))?;
    }

    // 删除文件
    fs::remove_file(file_path).map_err(|e| format!("删除文件失败: {}", e))?;

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
    let dir_path = Path::new(directory);
    if !dir_path.exists() {
        return Err(format!("目录不存在: {}", directory));
    }
    if !dir_path.is_dir() {
        return Err(format!("不是目录: {}", directory));
    }

    // 第一步：按文件大小分组
    let mut size_groups: HashMap<u64, Vec<String>> = HashMap::new();

    for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
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
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    let permissions = fs::Permissions::from_mode(mode);
    fs::set_permissions(file_path, permissions)
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

/// 执行 shell 命令
#[tauri::command]
pub fn execute_command(command: &str, working_dir: &str) -> Result<CommandResult, String> {
    use std::process::Command;

    let output = Command::new("sh")
        .arg("-c")
        .arg(command)
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
