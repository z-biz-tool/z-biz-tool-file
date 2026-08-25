use std::path::{Path, PathBuf};
use std::process::Command;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use serde::{Deserialize, Serialize};

/// Office 文档转换结果
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OfficeConvertResult {
    /// 转换后的 PDF 路径（在临时目录里）
    pub pdf_path: String,
    /// 缓存命中（true = 复用上次转换，没重跑）
    pub cache_hit: bool,
    /// 实际转换耗时（ms；缓存命中时为 0）
    pub elapsed_ms: u64,
}

/// 检查 LibreOffice / soffice 是否可用
fn find_soffice() -> Option<String> {
    // 常见路径
    let candidates = [
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/usr/bin/soffice",
        "/usr/local/bin/soffice",
        "/opt/homebrew/bin/soffice",
        "/usr/local/Cellar/libreoffice/*/bin/soffice", // homebrew intel
        "/opt/homebrew/Cellar/libreoffice/*/bin/soffice", // homebrew arm
    ];
    for c in &candidates {
        if Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    // 兜底：PATH 里搜
    if let Ok(out) = Command::new("which").arg("soffice").output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
}

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("z-tool-office-cache")
}

/// 计算缓存 key：源文件 path + 修改时间（保证源文件改了能感知）
fn cache_key(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().to_string().hash(&mut hasher);
    mtime.hash(&mut hasher);
    let hash = format!("{:016x}", hasher.finish());
    Ok(format!("{}-{}.pdf", hash, mtime))
}

/// 转换 Office 文档到 PDF（用 LibreOffice headless 模式）
#[tauri::command]
pub async fn convert_office_to_pdf(path: String) -> Result<OfficeConvertResult, String> {
    let start = std::time::Instant::now();
    let src = Path::new(&path);
    if !src.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let supported = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf"];
    if !supported.contains(&ext.as_str()) {
        return Err(format!("不支持的 Office 格式: .{}", ext));
    }

    let soffice = find_soffice().ok_or_else(|| {
        "未找到 LibreOffice (soffice)。请安装：\n  macOS: brew install --cask libreoffice\n  或到 https://www.libreoffice.org/ 下载".to_string()
    })?;

    // 缓存目录
    let cache = cache_dir();
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let key = cache_key(src)?;
    let cached_pdf = cache.join(&key);

    if cached_pdf.exists() {
        return Ok(OfficeConvertResult {
            pdf_path: cached_pdf.to_string_lossy().to_string(),
            cache_hit: true,
            elapsed_ms: 0,
        });
    }

    // 转到一个临时 outdir，避免污染 cache 目录
    let outdir = std::env::temp_dir().join(format!("z-tool-office-out-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&outdir);

    // 调 soffice
    let output = Command::new(&soffice)
        .arg("--headless")
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(&outdir)
        .arg(src)
        .output()
        .map_err(|e| format!("启动 soffice 失败: {}（路径: {}）", e, soffice))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "LibreOffice 转换失败: {}\nstderr: {}\nstdout: {}",
            output.status,
            &stderr[..stderr.len().min(500)],
            &stdout[..stdout.len().min(500)]
        ));
    }

    // soffice 输出文件名 = 源文件名.pdf
    let base = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let produced = outdir.join(format!("{}.pdf", base));
    if !produced.exists() {
        return Err(format!(
            "转换后没找到 PDF：{}\n（检查文件是否能被 LibreOffice 打开）",
            produced.display()
        ));
    }

    // 移到 cache
    std::fs::rename(&produced, &cached_pdf)
        .map_err(|e| format!("移动到缓存失败: {}", e))?;
    // 清理 outdir
    let _ = std::fs::remove_dir_all(&outdir);

    Ok(OfficeConvertResult {
        pdf_path: cached_pdf.to_string_lossy().to_string(),
        cache_hit: false,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

/// 清理 Office 转换缓存
#[tauri::command]
pub fn cleanup_office_cache() -> Result<u64, String> {
    let cache = cache_dir();
    if !cache.exists() {
        return Ok(0);
    }
    let mut bytes = 0u64;
    for entry in std::fs::read_dir(&cache).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_file() {
            if let Ok(m) = std::fs::metadata(&p) {
                bytes += m.len();
            }
            let _ = std::fs::remove_file(&p);
        }
    }
    Ok(bytes)
}

/// 获取 LibreOffice 状态（是否安装 + 路径）
#[tauri::command]
pub fn get_office_status() -> Result<OfficeStatus, String> {
    let path = find_soffice();
    Ok(OfficeStatus {
        installed: path.is_some(),
        path,
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OfficeStatus {
    pub installed: bool,
    pub path: Option<String>,
}
