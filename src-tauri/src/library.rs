// 媒体库 + 图书馆后端
// 基于 JSON 持久化的轻量级元数据库
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

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
    Book,     // 书籍（PDF/EPUB）
    Comic,    // 漫画（CBR/CBZ）
    Music,    // 音乐专辑
    Movie,    // 电影
    TvShow,   // 剧集
    Podcast,  // 播客
    Document, // 文档
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
    pub rating: Option<u8>, // 1-5
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
    pub read_progress: Option<f32>, // 0.0 ~ 1.0

    // ── 2026-11-04 图书馆 app 新增 ──
    // 这几个字段全部 `#[serde(default)]`：library.json 是在这次改动之前就存在的，
    // 旧文件里没有它们。不加 default 会让整份书库在升级后读不出来 —— 而 load()
    // 的失败路径是 unwrap_or_default()，表现成「书全没了」这种最坏的静默事故。
    /// 所属图书集 id（用户可以手动归集，一本可以属于多个集）
    #[serde(default)]
    pub collections: Vec<String>,
    /// 收藏。此前只有 MediaItem 有 favorite，书这边缺一个「置顶几本常翻的」入口
    #[serde(default)]
    pub favorite: bool,
    /// 规范化格式（pdf / epub / mobi / azw3 / cbz …），归纳用的一个维度
    #[serde(default)]
    pub format: Option<String>,
    /// 文件大小与修改时间：排序与「最近放进来的」筛选要用，扫描时顺手记下
    #[serde(default)]
    pub file_size: u64,
    #[serde(default)]
    pub modified_at: i64,
}

/// 图书集：用户自己拉的收纳盒（"技术书"、"待读"、"某套丛书"…）。
///
/// 与 tag 的区别是有序、可命名、可着色，且能直接从文件管理的右键菜单往里丢 ——
/// tag 是给单个文件贴的松散标记，集是用户心里的一条书目线。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub sort: u32,
}

/// 归纳维度上的一个取值与它的书目数（作者 / 出版社 / 年份 / 系列 / 标签 / 格式）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FacetValue {
    pub value: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionCount {
    pub collection: Collection,
    pub count: u32,
}

/// 图书馆侧栏要展示的全部归纳结果，一次取回。
///
/// 为什么一次全给而不是让前端按维度逐个查：侧栏要同时显示各档的书目数，
/// 分次调用会让「数字晚一拍」——切 Tab 时看到 12 本，点进去却是 13 本。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryFacets {
    pub total: u32,
    pub unread: u32,
    pub reading: u32,
    pub finished: u32,
    pub favorites: u32,
    pub authors: Vec<FacetValue>,
    pub publishers: Vec<FacetValue>,
    pub years: Vec<FacetValue>,
    pub series: Vec<FacetValue>,
    pub tags: Vec<FacetValue>,
    pub formats: Vec<FacetValue>,
    pub collections: Vec<CollectionCount>,
}

/// 图书馆查询条件。全部可选，缺省即「不按这一维过滤」。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryFilter {
    pub search: Option<String>,
    pub collection_id: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub year: Option<String>,
    pub series: Option<String>,
    pub tag: Option<String>,
    pub format: Option<String>,
    /// unread / reading / finished
    pub status: Option<String>,
    pub favorites_only: Option<bool>,
    /// added / title / author / year / rating / lastRead
    pub sort: Option<String>,
}

// =============== 数据库（JSON 文件） ===============

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LibraryDb {
    pub media: HashMap<String, MediaItem>,
    pub library: HashMap<String, LibraryEntry>,
    pub scan_dirs: Vec<String>,
    /// 图书集。同样是 default：旧 library.json 里没有这个键，没有它则整份书库读不出来
    #[serde(default)]
    pub collections: Vec<Collection>,
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
        crate::atomic_write::atomic_write_json(&p, self)
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
        for entry in walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path().to_string_lossy().to_string();
            if let Some(kind) = detect_media_kind(&path) {
                let meta = entry.metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                let id = hash_path(&path);
                let title = entry.file_name().to_string_lossy().to_string();
                let (width, height, duration_sec) = match &kind {
                    MediaKind::Image => {
                        // 只读文件头获取尺寸，避免 image::open 把整张图解码到内存
                        if let Ok(reader) = image::ImageReader::open(&path) {
                            if let Ok(reader) = reader.with_guessed_format() {
                                if let Ok(dims) = reader.into_dimensions() {
                                    (Some(dims.0), Some(dims.1), None)
                                } else {
                                    (None, None, None)
                                }
                            } else {
                                (None, None, None)
                            }
                        } else {
                            (None, None, None)
                        }
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
                    artist: None,
                    album: None,
                    cover_path: None,
                    author: None,
                    page_count: None,
                    cover_url: None,
                    tags: Vec::new(),
                    rating: None,
                    description: None,
                    favorite: false,
                    series: None,
                    series_index: None,
                    publisher: None,
                    publish_year: None,
                    isbn: None,
                    language: None,
                };
                db.media.insert(id, item);
            }
        }
    }

    db.save()?;
    library_stats()
}

/// 扫描图书馆（书籍/漫画/音乐专辑）
///
/// 同步体单列成 `_blocking`：扫一个几千本的目录要几秒到几十秒，直接挂在命令上
/// 会把 IPC 线程占满，整个窗口点不动。命令层只负责把它丢进 blocking 池。
///
/// 只在**新条目**上抽元数据：已经在库里的书直接跳过解析，否则每次重扫都要把
/// 几千本书重新解一遍 OPF / PDF Info，重扫会从「几秒」变成「几分钟」。
#[tauri::command]
pub async fn library_scan_books() -> Result<LibraryStats, String> {
    tauri::async_runtime::spawn_blocking(library_scan_books_blocking)
        .await
        .map_err(|e| e.to_string())?
}

pub fn library_scan_books_blocking() -> Result<LibraryStats, String> {
    let mut db = LibraryDb::load();
    let now = Utc::now().timestamp();

    for dir in &db.scan_dirs.clone() {
        if !Path::new(dir).exists() {
            continue;
        }
        for entry in walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path().to_string_lossy().to_string();
            if let Some(kind) = detect_library_kind(&path) {
                let id = hash_path(&path);
                let file_name = entry.file_name().to_string_lossy().to_string();
                let meta = entry.metadata().ok();
                let file_size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified_at = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                // 已存在：只补「文件动过了」这类会变的事实，元数据与用户编辑过的
                // 作者/标签/评分一律保留 —— 重扫不能把人工录入的东西冲掉。
                if let Some(existing) = db.library.get_mut(&id) {
                    existing.file_size = file_size;
                    existing.modified_at = modified_at;
                    continue;
                }

                let book = extract_book_meta(&path);
                let title = book
                    .title
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| clean_book_title(&file_name));
                let lib = LibraryEntry {
                    id: id.clone(),
                    item_id: id.clone(),
                    kind,
                    title,
                    path: path.clone(),
                    author: book.author,
                    series: book.series,
                    series_index: book.series_index,
                    publisher: book.publisher,
                    publish_year: book.publish_year,
                    isbn: book.isbn,
                    tags: Vec::new(),
                    rating: None,
                    description: None,
                    cover_url: None,
                    added_at: now,
                    last_read_at: None,
                    read_progress: None,
                    collections: Vec::new(),
                    favorite: false,
                    format: Some(normalize_format(&path)),
                    file_size,
                    modified_at,
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
        items.retain(|i| {
            i.title.to_lowercase().contains(&s)
                || i.path.to_lowercase().contains(&s)
                || i.tags.iter().any(|t| t.to_lowercase().contains(&s))
        });
    }
    if favorites_only.unwrap_or(false) {
        items.retain(|i| i.favorite);
    }

    items.sort_by_key(|a| std::cmp::Reverse(a.indexed_at));
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
        items.retain(|i| {
            i.title.to_lowercase().contains(&s)
                || i.author
                    .as_ref()
                    .map(|a| a.to_lowercase().contains(&s))
                    .unwrap_or(false)
        });
    }

    items.sort_by_key(|a| std::cmp::Reverse(a.added_at));
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

// =============== 图书集 ===============
//
// 「图书馆 app」的归纳骨架：集是用户亲手拉的线，facets 是自动长出来的线。
// 两者都要有 —— 只有自动归纳，用户没法表达「这三本是一套」；只有手动集，
// 几百本书会变成一堆没人整理的收纳盒。

#[tauri::command]
pub fn library_list_collections() -> Result<Vec<Collection>, String> {
    let mut db = LibraryDb::load();
    db.collections
        .sort_by(|a, b| a.sort.cmp(&b.sort).then(a.name.cmp(&b.name)));
    Ok(db.collections)
}

#[tauri::command]
pub fn library_create_collection(
    name: String,
    description: Option<String>,
    color: Option<String>,
) -> Result<Collection, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("图书集名称不能为空".into());
    }
    let mut db = LibraryDb::load();
    // 重名不做硬拒绝：用户可能真的想要两个「待读」，但多半是手滑点了两次，
    // 所以允许创建、由前端提示一句，而不是让按钮直接失败。
    if db.collections.iter().any(|c| c.name == name) {
        return Err(format!("已经有叫「{}」的图书集了", name));
    }
    let collection = Collection {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        description: description.filter(|s| !s.trim().is_empty()),
        color: color.filter(|s| !s.trim().is_empty()),
        created_at: Utc::now().timestamp(),
        sort: db.collections.len() as u32,
    };
    db.collections.push(collection.clone());
    db.save()?;
    Ok(collection)
}

#[tauri::command]
pub fn library_update_collection(
    id: String,
    name: Option<String>,
    description: Option<String>,
    color: Option<String>,
) -> Result<(), String> {
    let mut db = LibraryDb::load();
    let c = db
        .collections
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("未找到图书集: {}", id))?;
    if let Some(n) = name {
        let n = n.trim();
        if n.is_empty() {
            return Err("图书集名称不能为空".into());
        }
        c.name = n.to_string();
    }
    // 空串视为「清空该字段」，传 None 才是不改
    if let Some(d) = description {
        c.description = if d.trim().is_empty() { None } else { Some(d) };
    }
    if let Some(v) = color {
        c.color = if v.trim().is_empty() { None } else { Some(v) };
    }
    db.save()
}

#[tauri::command]
pub fn library_delete_collection(id: String) -> Result<(), String> {
    let mut db = LibraryDb::load();
    db.collections.retain(|c| c.id != id);
    // 只解除归属，不动书目本身 —— 删集不等于删书
    for entry in db.library.values_mut() {
        entry.collections.retain(|c| c != &id);
    }
    db.save()
}

/// 把若干文件路径加入某个图书集。
///
/// 这是「文件管理右键 → 加入图书集」的后端入口，也是本 app「建立在本地文件树之上」
/// 的关键：传进来的路径可能从来没被扫描过（比如用户随手丢进来一个 PDF），
/// 那就当场补一条书目记录，而不是要求用户先去加扫描目录、再扫一遍。
///
/// 返回：本次真正新增/补建的条数（已在集里重复计入不算）。
#[tauri::command]
pub async fn library_add_paths_to_collection(
    paths: Vec<String>,
    collection_id: String,
) -> Result<u32, String> {
    // 每个文件都要开 zip / 读 PDF Info，一次选几十本就有感了，同样挪出 IPC 线程
    tauri::async_runtime::spawn_blocking(move || {
        library_add_paths_to_collection_blocking(paths, collection_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn library_add_paths_to_collection_blocking(
    paths: Vec<String>,
    collection_id: String,
) -> Result<u32, String> {
    let mut db = LibraryDb::load();
    if !db.collections.iter().any(|c| c.id == collection_id) {
        return Err(format!("未找到图书集: {}", collection_id));
    }
    let now = Utc::now().timestamp();
    let mut added = 0u32;

    for path in paths {
        let p = Path::new(&path);
        if !p.is_file() {
            continue;
        }
        let id = hash_path(&path);

        if !db.library.contains_key(&id) {
            let kind = detect_library_kind(&path).unwrap_or(LibraryKind::Document);
            let file_name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            let meta = extract_book_meta(&path);
            let meta_fs = fs::metadata(&path).ok();
            let title = meta
                .title
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| clean_book_title(&file_name));
            db.library.insert(
                id.clone(),
                LibraryEntry {
                    id: id.clone(),
                    item_id: id.clone(),
                    kind,
                    title,
                    path: path.clone(),
                    author: meta.author,
                    series: meta.series,
                    series_index: meta.series_index,
                    publisher: meta.publisher,
                    publish_year: meta.publish_year,
                    isbn: meta.isbn,
                    tags: Vec::new(),
                    rating: None,
                    description: None,
                    cover_url: None,
                    added_at: now,
                    last_read_at: None,
                    read_progress: None,
                    collections: Vec::new(),
                    favorite: false,
                    format: Some(normalize_format(&path)),
                    file_size: meta_fs.as_ref().map(|m| m.len()).unwrap_or(0),
                    modified_at: meta_fs
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0),
                },
            );
            added += 1;
        }

        if let Some(entry) = db.library.get_mut(&id) {
            if !entry.collections.contains(&collection_id) {
                entry.collections.push(collection_id.clone());
            }
        }
    }

    db.save()?;
    Ok(added)
}

#[tauri::command]
pub fn library_remove_from_collection(
    ids: Vec<String>,
    collection_id: String,
) -> Result<(), String> {
    let mut db = LibraryDb::load();
    for id in ids {
        if let Some(entry) = db.library.get_mut(&id) {
            entry.collections.retain(|c| c != &collection_id);
        }
    }
    db.save()
}

/// 把一本从图书馆移除（只移出记录，磁盘上的文件分毫不动）
#[tauri::command]
pub fn library_remove_entry(id: String) -> Result<(), String> {
    let mut db = LibraryDb::load();
    db.library.remove(&id);
    db.save()
}

#[tauri::command]
pub fn library_toggle_entry_favorite(id: String) -> Result<bool, String> {
    let mut db = LibraryDb::load();
    let entry = db
        .library
        .get_mut(&id)
        .ok_or_else(|| format!("未找到书目: {}", id))?;
    entry.favorite = !entry.favorite;
    let fav = entry.favorite;
    db.save()?;
    Ok(fav)
}

/// 设置阅读状态：unread / reading / finished
#[tauri::command]
pub fn library_set_read_status(id: String, status: String) -> Result<(), String> {
    let mut db = LibraryDb::load();
    let entry = db
        .library
        .get_mut(&id)
        .ok_or_else(|| format!("未找到书目: {}", id))?;
    match status.as_str() {
        "unread" => {
            entry.read_progress = None;
            entry.last_read_at = None;
        }
        "reading" => {
            // 只标状态不改进度：已经读到 60% 的书标回「在读」不该退回 0
            if entry.read_progress.unwrap_or(0.0) <= 0.0 {
                entry.read_progress = Some(0.01);
            }
            entry.last_read_at = Some(Utc::now().timestamp());
        }
        "finished" => {
            entry.read_progress = Some(1.0);
            entry.last_read_at = Some(Utc::now().timestamp());
        }
        _ => return Err("status 必须是 unread / reading / finished".into()),
    }
    db.save()
}

/// 记录阅读进度（0..1）。阅读器每隔几页回写一次。
///
/// 进度 0 存成 0.01 而不是 0：0 会被 `read_status` 判成「未读」，
/// 于是"打开过又停在开头"的书仍躺在未读里，看起来像没生效。
#[tauri::command]
pub fn library_set_read_progress(id: String, progress: f32) -> Result<(), String> {
    let mut db = LibraryDb::load();
    let entry = db
        .library
        .get_mut(&id)
        .ok_or_else(|| format!("未找到书目: {}", id))?;
    let p = if progress.is_finite() {
        progress.clamp(0.0, 1.0)
    } else {
        0.0
    };
    entry.read_progress = Some(if p <= 0.0 { 0.01 } else { p });
    // 往回翻也算"刚读"。用户点开一本书，书架上的最近阅读就该把它顶到前面
    entry.last_read_at = Some(Utc::now().timestamp());
    db.save()
}

/// 批量修补书目元数据（前端「编辑信息」面板用）。
///
/// 每个字段 `Option`：不传 = 不改。想清空就传空串 —— 这样前端不必区分
/// "字段没出现在表单里" 和 "字段被清空了" 两种 null。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryMetaPatch {
    pub title: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub publish_year: Option<u32>,
    pub series: Option<String>,
    pub series_index: Option<u32>,
    pub tags: Option<Vec<String>>,
    pub rating: Option<u8>,
    pub description: Option<String>,
}

#[tauri::command]
pub fn library_update_entry_meta(id: String, patch: EntryMetaPatch) -> Result<(), String> {
    let mut db = LibraryDb::load();
    let e = db
        .library
        .get_mut(&id)
        .ok_or_else(|| format!("未找到书目: {}", id))?;
    fn norm(s: Option<String>) -> Option<String> {
        s.and_then(|v| {
            let t = v.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        })
    }
    if let Some(t) = patch.title {
        let t = t.trim().to_string();
        if !t.is_empty() {
            e.title = t;
        }
    }
    if patch.author.is_some() {
        e.author = norm(patch.author);
    }
    if patch.publisher.is_some() {
        e.publisher = norm(patch.publisher);
    }
    if patch.series.is_some() {
        e.series = norm(patch.series);
    }
    if patch.description.is_some() {
        e.description = norm(patch.description);
    }
    if let Some(y) = patch.publish_year {
        e.publish_year = if y == 0 { None } else { Some(y) };
    }
    if patch.series_index.is_some() {
        e.series_index = patch.series_index.filter(|i| *i > 0);
    }
    if let Some(tags) = patch.tags {
        e.tags = tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
    }
    if let Some(r) = patch.rating {
        e.rating = if r == 0 { None } else { Some(r.min(5)) };
    }
    db.save()
}

/// 归纳结果：一次把侧栏要的全部维度和计数取回
#[tauri::command]
pub fn library_facets() -> Result<LibraryFacets, String> {
    let db = LibraryDb::load();
    let entries: Vec<&LibraryEntry> = db.library.values().collect();

    let mut authors: HashMap<String, u32> = HashMap::new();
    let mut publishers: HashMap<String, u32> = HashMap::new();
    let mut years: HashMap<String, u32> = HashMap::new();
    let mut series: HashMap<String, u32> = HashMap::new();
    let mut tags: HashMap<String, u32> = HashMap::new();
    let mut formats: HashMap<String, u32> = HashMap::new();

    let mut unread = 0u32;
    let mut reading = 0u32;
    let mut finished = 0u32;
    let mut favorites = 0u32;

    for e in &entries {
        let p = e.read_progress.unwrap_or(0.0);
        if p >= 0.99 {
            finished += 1;
        } else if p > 0.0 {
            reading += 1;
        } else {
            unread += 1;
        }
        if e.favorite {
            favorites += 1;
        }
        *authors
            .entry(
                e.author
                    .clone()
                    .unwrap_or_else(|| UNKNOWN_FACET.to_string()),
            )
            .or_insert(0) += 1;
        if let Some(v) = &e.publisher {
            *publishers.entry(v.clone()).or_insert(0) += 1;
        }
        if let Some(y) = e.publish_year {
            *years.entry(y.to_string()).or_insert(0) += 1;
        }
        if let Some(v) = &e.series {
            *series.entry(v.clone()).or_insert(0) += 1;
        }
        for t in &e.tags {
            *tags.entry(t.clone()).or_insert(0) += 1;
        }
        let fmt = e
            .format
            .clone()
            .unwrap_or_else(|| normalize_format(&e.path));
        *formats.entry(fmt).or_insert(0) += 1;
    }

    let collections = db
        .collections
        .iter()
        .map(|c| CollectionCount {
            collection: c.clone(),
            count: entries
                .iter()
                .filter(|e| e.collections.contains(&c.id))
                .count() as u32,
        })
        .collect();

    Ok(LibraryFacets {
        total: entries.len() as u32,
        unread,
        reading,
        finished,
        favorites,
        authors: sort_facets(authors),
        publishers: sort_facets(publishers),
        // 年份特殊：按数值倒序，新的在前 —— 按 count 排会让「哪年书最多」挤到第一，
        // 而用户扫年份是在找"我今年买的"。
        years: {
            let mut v: Vec<FacetValue> = years
                .into_iter()
                .map(|(value, count)| FacetValue { value, count })
                .collect();
            v.sort_by(|a, b| b.value.cmp(&a.value));
            v
        },
        series: sort_facets(series),
        tags: sort_facets(tags),
        formats: sort_facets(formats),
        collections,
    })
}

/// 按条件查书目（图书馆 app 的主查询）
#[tauri::command]
pub fn library_query(filter: LibraryFilter) -> Result<Vec<LibraryEntry>, String> {
    let db = LibraryDb::load();
    let mut items: Vec<LibraryEntry> = db.library.values().cloned().collect();

    let unknown = UNKNOWN_FACET.to_string();
    if let Some(v) = filter.collection_id.as_ref().filter(|s| !s.is_empty()) {
        items.retain(|i| i.collections.contains(v));
    }
    if let Some(v) = filter.author.as_ref().filter(|s| !s.is_empty()) {
        items.retain(|i| i.author.clone().unwrap_or_else(|| unknown.clone()) == *v);
    }
    if let Some(v) = filter.publisher.as_ref().filter(|s| !s.is_empty()) {
        items.retain(|i| i.publisher.as_deref() == Some(v.as_str()));
    }
    if let Some(v) = filter.year.as_ref().filter(|s| !s.is_empty()) {
        items.retain(|i| i.publish_year.map(|y| y.to_string()).as_deref() == Some(v.as_str()));
    }
    if let Some(v) = filter.series.as_ref().filter(|s| !s.is_empty()) {
        items.retain(|i| i.series.as_deref() == Some(v.as_str()));
    }
    if let Some(v) = filter.tag.as_ref().filter(|s| !s.is_empty()) {
        items.retain(|i| i.tags.iter().any(|t| t == v));
    }
    if let Some(v) = filter.format.as_ref().filter(|s| !s.is_empty()) {
        items.retain(|i| {
            i.format
                .clone()
                .unwrap_or_else(|| normalize_format(&i.path))
                == *v
        });
    }
    if let Some(v) = filter.status.as_ref().filter(|s| !s.is_empty()) {
        items.retain(|i| {
            let p = i.read_progress.unwrap_or(0.0);
            match v.as_str() {
                "finished" => p >= 0.99,
                "reading" => p > 0.0 && p < 0.99,
                "unread" => p <= 0.0,
                _ => true,
            }
        });
    }
    if filter.favorites_only.unwrap_or(false) {
        items.retain(|i| i.favorite);
    }
    if let Some(s) = filter.search.as_ref().filter(|s| !s.trim().is_empty()) {
        let s = s.to_lowercase();
        items.retain(|i| {
            i.title.to_lowercase().contains(&s)
                || i.author
                    .as_ref()
                    .map(|a| a.to_lowercase().contains(&s))
                    .unwrap_or(false)
                || i.path.to_lowercase().contains(&s)
                || i.tags.iter().any(|t| t.to_lowercase().contains(&s))
                || i.series
                    .as_ref()
                    .map(|v| v.to_lowercase().contains(&s))
                    .unwrap_or(false)
        });
    }

    match filter.sort.as_deref().unwrap_or("added") {
        "title" => items.sort_by(|a, b| a.title.cmp(&b.title)),
        "author" => items.sort_by(|a, b| {
            a.author
                .as_deref()
                .unwrap_or("")
                .cmp(b.author.as_deref().unwrap_or(""))
                .then(a.title.cmp(&b.title))
        }),
        "year" => items.sort_by_key(|a| std::cmp::Reverse(a.publish_year)),
        "rating" => items.sort_by_key(|a| std::cmp::Reverse(a.rating.unwrap_or(0))),
        "lastRead" => items.sort_by(|a, b| {
            b.last_read_at
                .unwrap_or(0)
                .cmp(&a.last_read_at.unwrap_or(0))
        }),
        _ => items.sort_by_key(|a| std::cmp::Reverse(a.added_at)),
    }

    Ok(items)
}

/// 给缺元数据的书目补抽（扫描时为了速度没抽的、以及从右键加进来又没作者的老条目）
#[tauri::command]
pub async fn library_enrich_metadata(limit: Option<usize>) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || library_enrich_metadata_blocking(limit))
        .await
        .map_err(|e| e.to_string())?
}

pub fn library_enrich_metadata_blocking(limit: Option<usize>) -> Result<u32, String> {
    let mut db = LibraryDb::load();
    let limit = limit.unwrap_or(50);
    let targets: Vec<String> = db
        .library
        .values()
        .filter(|e| e.author.is_none() && Path::new(&e.path).is_file())
        .map(|e| e.id.clone())
        .take(limit)
        .collect();

    let mut filled = 0u32;
    for id in targets {
        let path = match db.library.get(&id) {
            Some(e) => e.path.clone(),
            None => continue,
        };
        let meta = extract_book_meta(&path);
        if meta.author.is_none() && meta.title.is_none() && meta.publisher.is_none() {
            continue;
        }
        if let Some(e) = db.library.get_mut(&id) {
            if e.author.is_none() {
                e.author = meta.author;
            }
            if e.publisher.is_none() {
                e.publisher = meta.publisher;
            }
            if e.publish_year.is_none() {
                e.publish_year = meta.publish_year;
            }
            if e.isbn.is_none() {
                e.isbn = meta.isbn;
            }
            if e.series.is_none() {
                e.series = meta.series;
                e.series_index = meta.series_index;
            }
            if e.format.is_none() {
                e.format = Some(normalize_format(&path));
            }
            filled += 1;
        }
    }
    if filled > 0 {
        db.save()?;
    }
    Ok(filled)
}

// =============== 工具函数 ===============

/// 侧栏里「没有这一维取值」的那一档统一叫这个名字。
/// 用字符串而不是跳过：跳过会让 300 本书里有 180 本作者为空时，侧栏作者列表
/// 只剩零星几个名字，用户会以为书丢了。
const UNKNOWN_FACET: &str = "未标注";

#[derive(Debug, Default)]
struct BookMeta {
    title: Option<String>,
    author: Option<String>,
    publisher: Option<String>,
    publish_year: Option<u32>,
    isbn: Option<String>,
    series: Option<String>,
    series_index: Option<u32>,
}

/// 从文件本身抽元数据。抽不到就返回空 —— 调用方用文件名兜底。
///
/// 只做「读几个小文件」的活：EPUB 走 container.xml → OPF（不解章节正文），
/// PDF 走 cap-doc 的 Info 字典。整本解析留给阅读器，扫描时分母可能是几千本。
fn extract_book_meta(path: &str) -> BookMeta {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "epub" | "azw3" => extract_epub_meta(path),
        "pdf" => extract_pdf_meta(path),
        _ => BookMeta::default(),
    }
}

fn extract_pdf_meta(path: &str) -> BookMeta {
    match cap_doc::get_pdf_metadata(path) {
        Ok(m) => BookMeta {
            title: non_empty(m.title),
            author: non_empty(m.author),
            ..Default::default()
        },
        // 加密 / 损坏 / 非标准 PDF 都会走到这里。这不是错误 —— 扫描要能继续。
        Err(_) => BookMeta::default(),
    }
}

/// EPUB：读 META-INF/container.xml 拿到 OPF 路径，再从 OPF 里正则抽 dc:* 字段。
///
/// 为什么不用 `cap_doc::parse_epub`：那个函数会把全书章节正文都解析出来，
/// 单本几十毫秒，几千本书就是几十秒的「扫描中」，而这里只需要几个字符串。
fn extract_epub_meta(path: &str) -> BookMeta {
    use std::io::Read;

    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return BookMeta::default(),
    };
    let mut zip = match zip::ZipArchive::new(file) {
        Ok(z) => z,
        Err(_) => return BookMeta::default(),
    };

    let read_entry = |zip: &mut zip::ZipArchive<fs::File>, name: &str| -> Option<String> {
        let mut f = zip.by_name(name).ok()?;
        let mut s = String::new();
        f.read_to_string(&mut s).ok()?;
        Some(s)
    };

    let container = match read_entry(&mut zip, "META-INF/container.xml") {
        Some(c) => c,
        None => return BookMeta::default(),
    };
    let opf_path = match re_first(&container, r#"full-path\s*=\s*"([^"]+)""#) {
        Some(p) => p,
        None => return BookMeta::default(),
    };
    let opf = match read_entry(&mut zip, &opf_path) {
        Some(o) => o,
        None => return BookMeta::default(),
    };

    let pick = |re: &str| -> Option<String> { re_first(&opf, re).map(|v| unescape_xml(&v)) };

    let title = pick(r#"(?is)<(?:dc:)?title[^>]*>(.*?)</(?:dc:)?title>"#)
        .map(|s| collapse_spaces(&strip_tags(&s)));
    let author = pick(r#"(?is)<(?:dc:)?creator[^>]*>(.*?)</(?:dc:)?creator>"#)
        .map(|s| collapse_spaces(&strip_tags(&s)));
    let publisher = pick(r#"(?is)<(?:dc:)?publisher[^>]*>(.*?)</(?:dc:)?publisher>"#)
        .map(|s| collapse_spaces(&strip_tags(&s)));
    let language = pick(r#"(?is)<(?:dc:)?language[^>]*>(.*?)</(?:dc:)?language>"#);
    let _ = language; // 目前不作为归纳维度，留着免得将来又要改签名

    // 日期：OPF 里可能是 "2019" 也可能是 "2019-03-01T00:00:00+00:00"
    let publish_year = pick(r#"(?is)<(?:dc:)?date[^>]*>(.*?)</(?:dc:)?date>"#)
        .and_then(|d| crate::library::re_first(&d, r"(\d{4})"))
        .and_then(|y| y.parse::<u32>().ok())
        .filter(|y| (1000..=2999).contains(y));

    // ISBN：dc:identifier 里形如 urn:isbn:9787… 或裸号
    let isbn = pick(r#"(?is)<(?:dc:)?identifier[^>]*>(.*?)</(?:dc:)?identifier>"#).and_then(|s| {
        let digits: String = s
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == 'X')
            .collect();
        if digits.len() == 13 || digits.len() == 10 {
            Some(digits)
        } else {
            None
        }
    });

    // calibre 写进去的系列信息（属性顺序不固定，两个属性各抓一次）
    let series = re_first(&opf, r#"(?i)name\s*=\s*"calibre:series""#).and_then(|_| {
        // 命中说明有这个名字，再抓同标签里的 content
        opf.split("<meta").find_map(|seg| {
            if seg.contains("calibre:series") && !seg.contains("series_index") {
                re_first(seg, r#"(?i)content\s*=\s*"([^"]*)""#)
            } else {
                None
            }
        })
    });
    let series_index = opf
        .split("<meta")
        .find_map(|seg| {
            if seg.contains("calibre:series_index") {
                re_first(seg, r#"(?i)content\s*=\s*"([^"]*)""#)
            } else {
                None
            }
        })
        .and_then(|v| v.trim().parse::<f32>().ok())
        .map(|v| v.round() as u32);

    BookMeta {
        title: title.filter(|s| !s.is_empty() && !looks_like_path(s)),
        author: author.filter(|s| !s.is_empty()),
        publisher: publisher.filter(|s| !s.is_empty()),
        publish_year,
        isbn,
        series: series
            .map(|s| collapse_spaces(&s))
            .filter(|s| !s.is_empty()),
        series_index,
    }
}

/// 取第一个捕获组
fn re_first(hay: &str, pattern: &str) -> Option<String> {
    let re = regex::Regex::new(pattern).ok()?;
    re.captures(hay)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

fn non_empty(s: String) -> Option<String> {
    let t = s.trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

fn strip_tags(s: &str) -> String {
    let re = regex::Regex::new(r"(?is)<[^>]+>").unwrap();
    re.replace_all(s, "").to_string()
}

fn unescape_xml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn collapse_spaces(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// OPF 里偶尔会把路径当标题写进去，这种还不如用文件名
fn looks_like_path(s: &str) -> bool {
    s.contains('/')
        || s.contains('\\')
        || s.to_lowercase().ends_with(".html")
        || s.to_lowercase().ends_with(".xhtml")
}

/// 文件名 → 书名：去扩展名、下划线换空格、剥掉下载站塞的尾巴
fn clean_book_title(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    let mut t = stem.replace('_', " ");
    // (epub) (pdf) (z-lib.org) (1) 【高清】 这类后缀：只在结尾、且不长的时候剥，
    // 免得把「深入理解计算机系统(第3版)」的版本号也削掉
    if let Ok(re) = regex::Regex::new(
        r"(?i)\s*[\(\[【]\s*(epub|pdf|mobi|azw3?|txt|扫描版|高清|z-lib\.org|1lib|libgen)[^\)\]】]{0,12}[\)\]】]\s*$",
    ) {
        t = re.replace(&t, "").to_string();
    }
    collapse_spaces(&t)
}

/// 扩展名 → 归纳用的格式名（全小写；.jpeg 这种同义后缀不在这里，书本格式没有歧义）
fn normalize_format(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "unknown".to_string())
}

fn sort_facets(map: HashMap<String, u32>) -> Vec<FacetValue> {
    let mut v: Vec<FacetValue> = map
        .into_iter()
        .map(|(value, count)| FacetValue { value, count })
        .collect();
    // 书目多的在前；同数量按名字，保证每次刷新顺序一致（HashMap 的遍历顺序是随机的）
    v.sort_by(|a, b| b.count.cmp(&a.count).then(a.value.cmp(&b.value)));
    v
}

fn hash_path(path: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    format!("{:x}", h.finish())
}

fn detect_media_kind(path: &str) -> Option<MediaKind> {
    let ext = Path::new(path)
        .extension()?
        .to_string_lossy()
        .to_lowercase();
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
    let ext = Path::new(path)
        .extension()?
        .to_string_lossy()
        .to_lowercase();
    match ext.as_str() {
        "epub" | "mobi" | "azw" | "azw3" | "fb2" | "pdf" => Some(LibraryKind::Book),
        "cbr" | "cbz" => Some(LibraryKind::Comic),
        "mp3" | "flac" | "ogg" | "m4a" | "opus" => Some(LibraryKind::Music),
        "mp4" | "mkv" | "avi" | "mov" | "webm" => Some(LibraryKind::Movie),
        _ => None,
    }
}
