// 媒体库 + 图书馆后端
// 基于 JSON 持久化的轻量级元数据库
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use chrono::{DateTime, Utc};
use std::collections::HashMap;

// =============== 数据模型 ===============

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Video,
    Audio,
    Document,
    Ebook,
    Comic,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LibraryKind {
    Book,      // 书籍（PDF/EPUB）
    Comic,     // 漫画（CBR/CBZ）
    Music,     // 音乐专辑
    Movie,     // 电影
    TvShow,    // 剧集
    Podcast,   // 播客
    Document,  // 文档
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaItem {
    pub id: String,
    pub path: String,
    pub kind: MediaKind,
    pub title: String,
    pub size: u64,
    pub modified: i64,
    pub indexed_at: i64,

    // 图片/视频/音频特有
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_sec: Option<f64>,

    // 音频特有
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_path: Option<String>,

    // 文档/电子书特有
    pub author: Option<String>,
    pub page_count: Option<u32>,
    pub cover_url: Option<String>,

    // 通用
    pub tags: Vec<String>,
    pub rating: Option<u8>,          // 1-5
    pub description: Option<String>,
    pub favorite: bool,

    // 图书馆特有
    pub series: Option<String>,
    pub series_index: Option<u32>,
    pub publisher: Option<String>,
    pub publish_year: Option<u32>,
    pub isbn: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryEntry {
    pub id: String,
    pub item_id: String,
    pub kind: LibraryKind,
    pub title: String,
    pub path: String,
    pub author: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<u32>,
    pub publisher: Option<String>,
    pub publish_year: Option<u32>,
    pub isbn: Option<String>,
    pub tags: Vec<String>,
    pub rating: Option<u8>,
    pub description: Option<String>,
    pub cover_url: Option<String>,
    pub added_at: i64,
    pub last_read_at: Option<i64>,
    pub read_progress: Option<f32>,    // 0.0 ~ 1.0
}

// =============== 数据库（JSON 文件） ===============

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LibraryDb {
    pub media: HashMap<String, MediaItem>,
    pub library: HashMap<String, LibraryEntry>,
    pub scan_dirs: Vec<String>,
}

impl LibraryDb {
    fn path() -> std::path::PathBuf {
        let mut p = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        p.push("z-biz-tool-file");
        fs::create_dir_all(&p).ok();
        p.push("library.json");
        p
    }

    pub fn load() -> Self {
        let p = Self::path();
        if p.exists() {
            fs::read_to_string(&p)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Self::default()
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let p = Self::path();
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(&p, json).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn add_scan_dir(&mut self, dir: String) {
        if !self.scan_dirs.contains(&dir) {
            self.scan_dirs.push(dir);
        }
    }

    pub fn remove_scan_dir(&mut self, dir: &str) {
        self.scan_dirs.retain(|d| d != dir);
    }
}

// =============== 命令 ===============

/// 获取数据库统计
#[tauri::command]
pub fn library_stats() -> Result<LibraryStats, String> {
    let db = LibraryDb::load();
    let mut by_kind: HashMap<String, u32> = HashMap::new();
    for item in db.media.values() {
        let k = serde_json::to_value(&item.kind)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "other".to_string());
        *by_kind.entry(k).or_default() += 1;
    }
    Ok(LibraryStats {
        total_media: db.media.len() as u32,
        total_library: db.library.len() as u32,
        by_kind,
        scan_dirs: db.scan_dirs,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LibraryStats {
    pub total_media: u32,
    pub total_library: u32,
    pub by_kind: HashMap<String, u32>,
    pub scan_dirs: Vec<String>,
}

/// 添加扫描目录
#[tauri::command]
pub fn library_add_scan_dir(dir: String) -> Result<(), String> {
    let mut db = LibraryDb::load();
    db.add_scan_dir(dir);
    db.save()
}

/// 移除扫描目录
#[tauri::command]
pub fn library_remove_scan_dir(dir: String) -> Result<(), String> {
    let mut db = LibraryDb::load();
    db.remove_scan_dir(&dir);
    db.save()
}

/// 扫描媒体库（图片/视频/音频）
#[tauri::command]
pub fn library_scan_media() -> Result<LibraryStats, String> {
    let mut db = LibraryDb::load();
    let now = Utc::now().timestamp();

    for dir in &db.scan_dirs.clone() {
        if !Path::new(dir).exists() {
            continue;
        }
        for entry in walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path().to_string_lossy().to_string();
            if let Some(kind) = detect_media_kind(&path) {
                let meta = entry.metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = meta.as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                let id = hash_path(&path);
                let title = entry.file_name().to_string_lossy().to_string();
                let (width, height, duration_sec) = match &kind {
                    MediaKind::Image => {
                        if let Ok(img) = image::open(&path) {
                            let (w, h) = image::GenericImageView::dimensions(&img);
                            (Some(w), Some(h), None)
                        } else { (None, None, None) }
                    }
                    MediaKind::Video | MediaKind::Audio => {
                        // 简化：未解析实际 duration
                        (None, None, None)
                    }
                    _ => (None, None, None),
                };

                let item = MediaItem {
                    id: id.clone(),
                    path: path.clone(),
                    kind: kind.clone(),
                    title,
                    size,
                    modified,
                    indexed_at: now,
                    width,
                    height,
                    duration_sec,
                    artist: None, album: None, cover_path: None,
                    author: None, page_count: None, cover_url: None,
                    tags: Vec::new(),
                    rating: None,
                    description: None,
                    favorite: false,
                    series: None, series_index: None,
                    publisher: None, publish_year: None,
                    isbn: None, language: None,
                };
                db.media.insert(id, item);
            }
        }
    }

    db.save()?;
    library_stats()
}

/// 扫描图书馆（书籍/漫画/音乐专辑）
#[tauri::command]
pub fn library_scan_books() -> Result<LibraryStats, String> {
    let mut db = LibraryDb::load();
    let now = Utc::now().timestamp();

    for dir in &db.scan_dirs.clone() {
        if !Path::new(dir).exists() {
            continue;
        }
        for entry in walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path().to_string_lossy().to_string();
            if let Some(kind) = detect_library_kind(&path) {
                let title = entry.file_name().to_string_lossy().to_string();
                let id = hash_path(&path);
                let lib = LibraryEntry {
                    id: id.clone(),
                    item_id: id.clone(),
                    kind,
                    title,
                    path: path.clone(),
                    author: None,
                    series: None, series_index: None,
                    publisher: None, publish_year: None,
                    isbn: None,
                    tags: Vec::new(),
                    rating: None,
                    description: None,
                    cover_url: None,
                    added_at: now,
                    last_read_at: None,
                    read_progress: None,
                };
                db.library.insert(id, lib);
            }
        }
    }

    db.save()?;
    library_stats()
}

/// 查询媒体库（支持按类型过滤）
#[tauri::command]
pub fn library_query_media(
    kind: Option<String>,
    search: Option<String>,
    favorites_only: Option<bool>,
) -> Result<Vec<MediaItem>, String> {
    let db = LibraryDb::load();
    let mut items: Vec<MediaItem> = db.media.values().cloned().collect();

    if let Some(k) = kind {
        items.retain(|i| format!("{:?}", i.kind).to_lowercase() == k.to_lowercase());
    }
    if let Some(s) = search.filter(|s| !s.is_empty()) {
        let s = s.to_lowercase();
        items.retain(|i|
            i.title.to_lowercase().contains(&s)
            || i.path.to_lowercase().contains(&s)
            || i.tags.iter().any(|t| t.to_lowercase().contains(&s))
        );
    }
    if favorites_only.unwrap_or(false) {
        items.retain(|i| i.favorite);
    }

    items.sort_by(|a, b| b.indexed_at.cmp(&a.indexed_at));
    Ok(items)
}

/// 查询图书馆
#[tauri::command]
pub fn library_query_books(
    kind: Option<String>,
    search: Option<String>,
) -> Result<Vec<LibraryEntry>, String> {
    let db = LibraryDb::load();
    let mut items: Vec<LibraryEntry> = db.library.values().cloned().collect();

    if let Some(k) = kind {
        items.retain(|i| format!("{:?}", i.kind).to_lowercase() == k.to_lowercase());
    }
    if let Some(s) = search.filter(|s| !s.is_empty()) {
        let s = s.to_lowercase();
        items.retain(|i|
            i.title.to_lowercase().contains(&s)
            || i.author.as_ref().map(|a| a.to_lowercase().contains(&s)).unwrap_or(false)
        );
    }

    items.sort_by(|a, b| b.added_at.cmp(&a.added_at));
    Ok(items)
}

/// 切换收藏
#[tauri::command]
pub fn library_toggle_favorite(id: String) -> Result<bool, String> {
    let mut db = LibraryDb::load();
    if let Some(item) = db.media.get_mut(&id) {
        item.favorite = !item.favorite;
        let fav = item.favorite;
        db.save()?;
        Ok(fav)
    } else {
        Err(format!("未找到媒体项: {}", id))
    }
}

/// 设置评分
#[tauri::command]
pub fn library_set_rating(id: String, rating: u8) -> Result<(), String> {
    let mut db = LibraryDb::load();
    if let Some(item) = db.media.get_mut(&id) {
        item.rating = Some(rating);
        db.save()?;
        Ok(())
    } else {
        Err(format!("未找到: {}", id))
    }
}

/// 添加标签
#[tauri::command]
pub fn library_add_tag(id: String, tag: String) -> Result<(), String> {
    let mut db = LibraryDb::load();
    if let Some(item) = db.media.get_mut(&id) {
        if !item.tags.contains(&tag) {
            item.tags.push(tag);
        }
        db.save()?;
        Ok(())
    } else {
        Err(format!("未找到: {}", id))
    }
}

/// 更新阅读进度
#[tauri::command]
pub fn library_update_read_progress(id: String, progress: f32) -> Result<(), String> {
    let mut db = LibraryDb::load();
    if let Some(item) = db.library.get_mut(&id) {
        item.read_progress = Some(progress.clamp(0.0, 1.0));
        item.last_read_at = Some(Utc::now().timestamp());
        db.save()?;
        Ok(())
    } else {
        Err(format!("未找到: {}", id))
    }
}

/// 清空媒体库
#[tauri::command]
pub fn library_clear(kind: String) -> Result<(), String> {
    let mut db = LibraryDb::load();
    match kind.as_str() {
        "media" => db.media.clear(),
        "library" => db.library.clear(),
        _ => return Err("kind 必须是 media 或 library".to_string()),
    }
    db.save()
}

// =============== 工具函数 ===============

fn hash_path(path: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    format!("{:x}", h.finish())
}

fn detect_media_kind(path: &str) -> Option<MediaKind> {
    let ext = Path::new(path).extension()?.to_string_lossy().to_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "heic" | "svg" => Some(MediaKind::Image),
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "flv" | "wmv" => Some(MediaKind::Video),
        "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "opus" => Some(MediaKind::Audio),
        "pdf" | "doc" | "docx" | "rtf" | "odt" => Some(MediaKind::Document),
        "epub" | "mobi" | "azw" | "azw3" | "fb2" => Some(MediaKind::Ebook),
        "cbr" | "cbz" => Some(MediaKind::Comic),
        _ => None,
    }
}

fn detect_library_kind(path: &str) -> Option<LibraryKind> {
    let ext = Path::new(path).extension()?.to_string_lossy().to_lowercase();
    match ext.as_str() {
        "epub" | "mobi" | "azw" | "azw3" | "fb2" | "pdf" => Some(LibraryKind::Book),
        "cbr" | "cbz" => Some(LibraryKind::Comic),
        "mp3" | "flac" | "ogg" | "m4a" | "opus" => Some(LibraryKind::Music),
        "mp4" | "mkv" | "avi" | "mov" | "webm" => Some(LibraryKind::Movie),
        _ => None,
    }
}
