use std::path::Path;
use std::process::Command;
use serde::{Deserialize, Serialize};

/// 视频缩略图结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoThumbResult {
    /// 缩略图路径（jpg）
    pub thumb_path: String,
    /// 是否缓存命中
    pub cache_hit: bool,
}

fn cache_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("z-tool-video-thumb-cache")
}

fn ffmpeg_path() -> Option<String> {
    let candidates = [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ];
    for c in &candidates {
        if Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    if let Ok(out) = Command::new("which").arg("ffmpeg").output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
}

fn cache_key(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    path.to_string_lossy().to_string().hash(&mut hasher);
    size.hash(&mut hasher);
    mtime.hash(&mut hasher);
    Ok(format!("{:016x}.jpg", hasher.finish()))
}

/// 提取视频第一帧作为缩略图（缓存）
#[tauri::command]
pub fn get_video_thumbnail(path: String) -> Result<VideoThumbResult, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let video_exts = ["mp4", "webm", "mov", "avi", "mkv", "m4v", "flv", "wmv"];
    if !video_exts.contains(&ext.as_str()) {
        return Err(format!("不是视频文件: .{}", ext));
    }

    let ffmpeg = ffmpeg_path().ok_or_else(|| {
        "未找到 ffmpeg。请安装：brew install ffmpeg".to_string()
    })?;

    let cache = cache_dir();
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let key = cache_key(p)?;
    let cached = cache.join(&key);
    if cached.exists() {
        return Ok(VideoThumbResult {
            thumb_path: cached.to_string_lossy().to_string(),
            cache_hit: true,
        });
    }

    // ffmpeg 抽第一帧（-ss 0 取最开头，-frames:v 1 只输出 1 帧）
    let output = Command::new(&ffmpeg)
        .arg("-y") // 覆盖输出
        .arg("-i")
        .arg(p)
        .arg("-ss")
        .arg("0")
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg("scale=320:-1")
        .arg("-q:v")
        .arg("5")
        .arg(&cached)
        .output()
        .map_err(|e| format!("启动 ffmpeg 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffmpeg 提取失败: {}\n{}",
            output.status,
            &stderr[..stderr.len().min(300)]
        ));
    }
    if !cached.exists() {
        return Err("ffmpeg 没生成缩略图".to_string());
    }
    Ok(VideoThumbResult {
        thumb_path: cached.to_string_lossy().to_string(),
        cache_hit: false,
    })
}
