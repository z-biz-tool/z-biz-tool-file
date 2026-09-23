use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use walkdir::WalkDir;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

/// 索引目录解析：固定到用户本地数据目录，避免 CWD 漂移。
/// 旧版本使用相对路径 `index/`，导致不同启动方式下索引被写入不同位置。
fn resolve_index_dir() -> PathBuf {
    let mut p = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("z-biz-tool-file");
    p.push("index");
    let _ = fs::create_dir_all(&p);
    p
}

const FILE_INDEX_FILE: &str = "file_index.json";
const CONTENT_INDEX_FILE: &str = "content_index.json";

/// 全局索引缓存：第一次 load 后驻留内存，后续搜索直接命中，
/// 避免每次都 fs::read_to_string + serde_json::from_str。
fn index_cache() -> &'static Mutex<Option<SimpleIndexer>> {
    static CACHE: OnceLock<Mutex<Option<SimpleIndexer>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// 文件索引项
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileIndexItem {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub ext: String,
    pub tags: Vec<String>,
    pub content_hash: Option<String>,
}

/// 索引元数据
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexMetadata {
    pub version: u32,
    pub built_at: u64,
    pub total_files: usize,
    pub total_size: u64,
}

/// 索引构建进度
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexProgress {
    pub total: usize,
    pub processed: usize,
    pub current_file: String,
    pub status: IndexStatus,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum IndexStatus {
    Idle,
    Building,
    Ready,
    Error,
}

/// 全文索引项
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContentIndexItem {
    pub path: String,
    pub word: String,
    pub line_number: usize,
    pub snippet: String,
}

/// 简单的全文索引器
#[derive(Clone)]
pub struct SimpleIndexer {
    file_index: HashMap<String, FileIndexItem>,
    content_index: HashMap<String, Vec<ContentIndexItem>>,
    metadata: IndexMetadata,
}

impl SimpleIndexer {
    pub fn new() -> Self {
        Self {
            file_index: HashMap::new(),
            content_index: HashMap::new(),
            metadata: IndexMetadata {
                version: 1,
                built_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                total_files: 0,
                total_size: 0,
            },
        }
    }

    /// 保存索引到文件（同时更新内存缓存）
    pub fn save(&self) -> Result<(), String> {
        let index_path = resolve_index_dir();

        // 保存文件索引
        let file_index_path = index_path.join(FILE_INDEX_FILE);
        let file_index_data = serde_json::to_string(&self.file_index)
            .map_err(|e| e.to_string())?;
        crate::atomic_write::atomic_write(&file_index_path, file_index_data.as_bytes())
            .map_err(|e| e.to_string())?;

        // 保存内容索引（只保存最常见的词）
        let content_index_path = index_path.join(CONTENT_INDEX_FILE);
        let content_index_data = serde_json::to_string(&self.content_index)
            .map_err(|e| e.to_string())?;
        crate::atomic_write::atomic_write(&content_index_path, content_index_data.as_bytes())
            .map_err(|e| e.to_string())?;

        // 保存元数据
        let metadata_path = index_path.join("metadata.json");
        let metadata_data = serde_json::to_string(&self.metadata)
            .map_err(|e| e.to_string())?;
        crate::atomic_write::atomic_write(&metadata_path, metadata_data.as_bytes())
            .map_err(|e| e.to_string())?;

        // 同步缓存
        *index_cache().lock().unwrap() = Some(self.clone());

        Ok(())
    }

    /// 从文件加载索引（带全局缓存）
    pub fn load() -> Result<Self, String> {
        // 命中缓存：直接 clone 出副本
        if let Some(cached) = index_cache().lock().unwrap().clone() {
            return Ok(cached);
        }

        let index_path = resolve_index_dir();
        if !index_path.exists() {
            let fresh = Self::new();
            *index_cache().lock().unwrap() = Some(fresh.clone());
            return Ok(fresh);
        }

        let file_index_path = index_path.join(FILE_INDEX_FILE);
        let content_index_path = index_path.join(CONTENT_INDEX_FILE);

        let file_index: HashMap<String, FileIndexItem> = if file_index_path.exists() {
            let data = fs::read_to_string(&file_index_path)
                .map_err(|e| e.to_string())?;
            serde_json::from_str(&data).map_err(|e| e.to_string())?
        } else {
            HashMap::new()
        };

        let content_index: HashMap<String, Vec<ContentIndexItem>> = if content_index_path.exists() {
            let data = fs::read_to_string(&content_index_path)
                .map_err(|e| e.to_string())?;
            serde_json::from_str(&data).map_err(|e| e.to_string())?
        } else {
            HashMap::new()
        };

        let metadata_path = index_path.join("metadata.json");
        let metadata: IndexMetadata = if metadata_path.exists() {
            let data = fs::read_to_string(&metadata_path)
                .map_err(|e| e.to_string())?;
            serde_json::from_str(&data).map_err(|e| e.to_string())?
        } else {
            IndexMetadata {
                version: 1,
                built_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                total_files: 0,
                total_size: 0,
            }
        };

        let loaded = Self {
            file_index,
            content_index,
            metadata,
        };
        *index_cache().lock().unwrap() = Some(loaded.clone());
        Ok(loaded)
    }

    /// 索引整个目录
    pub fn index_directory(
        &mut self,
        root_path: &str,
        progress_callback: &dyn Fn(IndexProgress),
    ) -> Result<(), String> {
        let root = Path::new(root_path);
        if !root.exists() {
            return Err(format!("目录不存在: {}", root_path));
        }

        progress_callback(IndexProgress {
            total: 0,
            processed: 0,
            current_file: "开始索引...".to_string(),
            status: IndexStatus::Building,
        });

        let mut total_files = 0;
        let mut total_size = 0u64;
        let mut processed = 0;

        for entry in WalkDir::new(root)
            .max_depth(10)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                // 跳过隐藏文件和常见不需要索引的目录
                !name.starts_with('.')
                    && !name.starts_with("node_modules")
                    && !name.starts_with("vendor")
                    && !name.starts_with(".git")
                    && !name.starts_with(".DS_Store")
            })
            .filter_map(|e| e.ok())
        {
            total_files += 1;

            let path = entry.path();
            let metadata = entry.metadata().ok();

            if let Some(meta) = &metadata {
                total_size += meta.len();
            }

            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();

            // 索引文件元数据
            let file_path = path.to_string_lossy().to_string();
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            let item = FileIndexItem {
                path: file_path.clone(),
                name: file_name.clone(),
                is_dir: metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: metadata
                    .and_then(|m| m.modified().ok())
                    .map(|t| t.duration_since(UNIX_EPOCH).unwrap().as_secs())
                    .unwrap_or(0),
                ext: ext.clone(),
                tags: vec![],
                content_hash: None,
            };

            self.file_index.insert(file_path.clone(), item);

            // 简单的内容索引（只索引小的文本文件）
            self.index_file_content(&file_path, &ext.clone())?;

            processed += 1;

            if processed % 100 == 0 {
                progress_callback(IndexProgress {
                    total: total_files,
                    processed,
                    current_file: file_name.clone(),
                    status: IndexStatus::Building,
                });
            }
        }

        self.metadata.total_files = total_files;
        self.metadata.total_size = total_size;
        self.metadata.built_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        self.save()?;

        progress_callback(IndexProgress {
            total: total_files,
            processed,
            current_file: "索引完成".to_string(),
            status: IndexStatus::Ready,
        });

        Ok(())
    }

    /// 索引单个文件的内容
    fn index_file_content(&mut self, path: &str, ext: &str) -> Result<(), String> {
        // 只索引文本文件
        let text_exts = [
            "txt", "md", "rs", "go", "py", "js", "ts", "tsx", "jsx", "json", "yaml", "yml",
            "toml", "xml", "html", "css", "scss", "less", "sh", "bat", "java", "c", "cpp", "h",
            "hpp", "cs", "rb", "php", "swift", "kt", "sql", "log", "csv", "conf", "ini", "env",
        ];

        if !text_exts.contains(&ext.to_lowercase().as_str()) {
            return Ok(());
        }

        // 限制文件大小
        if let Ok(meta) = fs::metadata(path) {
            if meta.len() > 1024 * 1024 {
                return Ok(());
            }
        }

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return Ok(()),
        };

        // 简单的分词和索引
        let words = self.tokenize(&content);
        for (word, line_numbers) in words {
            for line_num in line_numbers {
                let snippet = self.get_snippet(&content, line_num);
                let item = ContentIndexItem {
                    path: path.to_string(),
                    word: word.clone().to_lowercase(),
                    line_number: line_num,
                    snippet,
                };

                self.content_index
                    .entry(word.to_lowercase())
                    .or_insert_with(Vec::new)
                    .push(item);
            }
        }

        Ok(())
    }

    /// 简单的分词（按空格和标点分割）
    fn tokenize(&self, text: &str) -> HashMap<String, Vec<usize>> {
        let mut words: HashMap<String, Vec<usize>> = HashMap::new();
        let mut current_line = 1;

        for line in text.lines() {
            let words_in_line: Vec<&str> = line
                .split(|c: char| c.is_whitespace() || c.is_ascii_punctuation())
                .filter(|w| w.len() > 2)
                .collect();

            for word in words_in_line {
                words
                    .entry(word.to_lowercase())
                    .or_insert_with(Vec::new)
                    .push(current_line);
            }

            current_line += 1;
        }

        words
    }

    /// 获取 snippets
    fn get_snippet(&self, content: &str, line_num: usize) -> String {
        let lines: Vec<&str> = content.lines().collect();
        let start = line_num.saturating_sub(2).min(lines.len());
        let end = (line_num + 2).min(lines.len());

        lines[start..end].join(" ... ")
    }

    /// 搜索文件名
    pub fn search_files(&self, query: &str, max_results: usize) -> Vec<&FileIndexItem> {
        let query_lower = query.to_lowercase();
        let mut results: Vec<&FileIndexItem> = self
            .file_index
            .values()
            .filter(|item| {
                item.name.to_lowercase().contains(&query_lower)
                    || item.path.to_lowercase().contains(&query_lower)
            })
            .collect();

        // 按相关性排序（文件名匹配优先）
        results.sort_by(|a, b| {
            let a_match = a.name.to_lowercase().starts_with(&query_lower) as i32;
            let b_match = b.name.to_lowercase().starts_with(&query_lower) as i32;
            b_match.cmp(&a_match)
        });

        results.into_iter().take(max_results).collect()
    }

    /// 搜索内容
    pub fn search_content(&self, query: &str, max_results: usize) -> Vec<&ContentIndexItem> {
        let query_lower = query.to_lowercase();
        let mut results: Vec<&ContentIndexItem> = self
            .content_index
            .values()
            .flatten()
            .filter(|item| item.word.contains(&query_lower) || item.snippet.contains(&query_lower))
            .collect();

        results.sort_by(|a, b| a.path.cmp(&b.path));

        results.into_iter().take(max_results).collect()
    }

    /// 获取索引统计
    pub fn get_stats(&self) -> &IndexMetadata {
        &self.metadata
    }

    /// 更新单个文件的索引
    pub fn update_file(&mut self, path: &str) -> Result<(), String> {
        let path = Path::new(path);
        if !path.exists() {
            self.file_index.remove(&path.to_string_lossy().to_string());
            return Ok(());
        }

        let metadata = path.metadata().ok();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let file_path = path.to_string_lossy().to_string();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let item = FileIndexItem {
            path: file_path.clone(),
            name: file_name.clone(),
            is_dir: metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
            modified: metadata
                .and_then(|m| m.modified().ok())
                .map(|t| t.duration_since(UNIX_EPOCH).unwrap().as_secs())
                .unwrap_or(0),
            ext: ext.clone(),
            tags: vec![],
            content_hash: None,
        };

        self.file_index.insert(file_path.clone(), item);
        self.index_file_content(&file_path, &ext)?;

        Ok(())
    }

    /// 删除文件的索引
    pub fn remove_file(&mut self, path: &str) {
        self.file_index.remove(path);
        // 清理内容索引中该文件的条目
        self.content_index
            .iter_mut()
            .for_each(|(_, items)| {
                items.retain(|item| item.path != path);
            });
    }
}

/// 目录级"对齐"用的纯决策：给定该目录里已索引的子项与实际列到的子项，
/// 得出该删掉谁、该刷新谁。
///
/// 为什么单独拿出来：这一步是全部风险的所在 —— 判断错了会把还在的文件从索引里删掉，
/// 或者反过来让删掉的文件一直留在搜索结果里。做成纯函数才能不碰磁盘就断言。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DirSyncPlan {
    /// 已索引但实际已经不在（或不在本次可见范围内）→ 从索引里删
    pub drop: Vec<String>,
    /// 实际有、但索引里没有或元数据对不上 → 重新索引（会读盘）
    pub refresh: Vec<String>,
    /// 索引与实际一致，什么都不做（稳态浏览就该全是这一档，否则每次进目录都在读盘）
    pub unchanged: usize,
}

/// listing_includes_hidden = false 时，隐藏条目不参与"删"的判断：
/// 列表按当前设置没列 dotfile，而索引里有（walkdir 默认收录），
/// 不加这道判断的话，每进一次目录就会把该目录的隐藏文件从索引里清出去。
pub fn plan_dir_sync(
    dir: &str,
    indexed: &[(String, u64, u64)],
    present: &[(String, u64, u64)],
    listing_includes_hidden: bool,
) -> DirSyncPlan {
    let prefix = if dir.ends_with('/') { dir.to_string() } else { format!("{}/", dir) };
    let mut plan = DirSyncPlan::default();

    let present_map: HashMap<String, (u64, u64)> = present
        .iter()
        .map(|(name, size, modified)| (format!("{}{}", prefix, name), (*size, *modified)))
        .collect();

    for (path, size, modified) in indexed {
        if !path.starts_with(&prefix) {
            continue;
        }
        let rest = &path[prefix.len()..];
        // 只对齐这一层：子目录里的东西由它们自己的列表负责
        if rest.is_empty() || rest.contains('/') {
            continue;
        }
        if !listing_includes_hidden && rest.starts_with('.') {
            continue;
        }
        match present_map.get(path) {
            None => plan.drop.push(path.clone()),
            Some((p_size, p_mod)) => {
                if p_size == size && p_mod == modified {
                    plan.unchanged += 1;
                } else {
                    plan.refresh.push(path.clone());
                }
            }
        }
    }

    for (name, _, _) in present {
        let path = format!("{}{}", prefix, name);
        if indexed.iter().any(|(p, _, _)| p == &path) {
            continue;
        }
        plan.refresh.push(path);
    }

    plan
}

// Tauri 命令
#[tauri::command]
pub fn indexer_init() -> Result<Value, String> {
    let indexer = SimpleIndexer::load()?;
    Ok(json!({
        "status": "loaded",
        "stats": indexer.get_stats()
    }))
}

#[tauri::command]
pub fn indexer_build(root_path: &str) -> Result<Value, String> {
    let mut indexer = SimpleIndexer::new();
    
    // 使用简单的进度回调
    let progress_callback = |progress: IndexProgress| {
        println!("Progress: {progress:?}");
    };

    indexer.index_directory(root_path, &progress_callback)?;
    
    Ok(json!({
        "status": "built",
        "stats": indexer.get_stats()
    }))
}

#[tauri::command]
pub fn indexer_search_files(query: &str, max_results: Option<usize>) -> Result<Value, String> {
    let indexer = SimpleIndexer::load()?;
    let results = indexer.search_files(query, max_results.unwrap_or(50));
    
    Ok(json!({
        "results": results.iter().map(|item| json!({
            "path": item.path,
            "name": item.name,
            "is_dir": item.is_dir,
            "size": item.size,
            "modified": item.modified,
            "ext": item.ext
        })).collect::<Vec<_>>()
    }))
}

#[tauri::command]
pub fn indexer_search_content(query: &str, max_results: Option<usize>) -> Result<Value, String> {
    let indexer = SimpleIndexer::load()?;
    let results = indexer.search_content(query, max_results.unwrap_or(50));
    
    Ok(json!({
        "results": results.iter().map(|item| json!({
            "path": item.path,
            "word": item.word,
            "line_number": item.line_number,
            "snippet": item.snippet
        })).collect::<Vec<_>>()
    }))
}

#[tauri::command]
pub fn indexer_get_stats() -> Result<Value, String> {
    let indexer = SimpleIndexer::load()?;
    Ok(json!({
        "stats": indexer.get_stats()
    }))
}

/// 列表刷新后顺手把这一层的索引对齐：删掉已经不在的、补上新的、刷新改过的。
/// 搜索索引原来只在手动「重新构建」时才更新，于是新建/改名/删除之后
/// 搜索结果里还留着旧文件（点开的却是"文件不存在"）。
#[tauri::command]
pub fn indexer_sync_dir(
    dir: String,
    entries: Vec<Value>,
    listing_includes_hidden: Option<bool>,
) -> Result<Value, String> {
    let mut indexer = SimpleIndexer::load()?;
    let prefix = if dir.ends_with('/') { dir.clone() } else { format!("{}/", dir) };
    let indexed: Vec<(String, u64, u64)> = indexer
        .file_index
        .values()
        .filter(|i| i.path.starts_with(&prefix))
        .map(|i| (i.path.clone(), i.size, i.modified))
        .collect();
    let present: Vec<(String, u64, u64)> = entries
        .iter()
        .filter_map(|e| {
            let name = e.get("name")?.as_str()?.to_string();
            let size = e.get("size")?.as_u64().unwrap_or(0);
            let modified = e.get("modified")?.as_u64().unwrap_or(0);
            Some((name, size, modified))
        })
        .collect();

    let plan = plan_dir_sync(&dir, &indexed, &present, listing_includes_hidden.unwrap_or(false));
    if plan.drop.is_empty() && plan.refresh.is_empty() {
        // 稳态浏览一个字节都不该动：既不读盘也不重写 index json
        return Ok(json!({ "dropped": 0, "refreshed": 0, "unchanged": plan.unchanged }));
    }
    for path in &plan.drop {
        indexer.remove_file(path);
    }
    for path in &plan.refresh {
        // 已经不在磁盘上的会被 update_file 自己剔掉，这里不重复判断
        indexer.update_file(path)?;
    }
    indexer.save()?;
    Ok(json!({
        "dropped": plan.drop.len(),
        "refreshed": plan.refresh.len(),
        "unchanged": plan.unchanged,
    }))
}

#[cfg(test)]
mod tests {
    use super::plan_dir_sync;

    #[test]
    fn 消失的文件要从索引里剔掉() {
        let indexed = vec![
            ("/d/a.txt".to_string(), 10u64, 1u64),
            ("/d/b.txt".to_string(), 20u64, 1u64),
        ];
        let present = vec![("a.txt".to_string(), 10u64, 1u64)];
        let plan = plan_dir_sync("/d", &indexed, &present, false);
        assert_eq!(plan.drop, vec!["/d/b.txt".to_string()]);
        assert!(plan.refresh.is_empty());
        assert_eq!(plan.unchanged, 1);
    }

    #[test]
    fn 大小或时间变了才重新索引() {
        let indexed = vec![("/d/a.txt".to_string(), 10u64, 1u64)];
        let same = vec![("a.txt".to_string(), 10u64, 1u64)];
        assert!(plan_dir_sync("/d", &indexed, &same, false).refresh.is_empty());

        let changed_size = vec![("a.txt".to_string(), 11u64, 1u64)];
        assert_eq!(
            plan_dir_sync("/d", &indexed, &changed_size, false).refresh,
            vec!["/d/a.txt".to_string()]
        );
        let changed_mtime = vec![("a.txt".to_string(), 10u64, 2u64)];
        assert_eq!(
            plan_dir_sync("/d", &indexed, &changed_mtime, false).refresh,
            vec!["/d/a.txt".to_string()]
        );
    }

    #[test]
    fn 隐藏文件在没开显示隐藏时不许被剔掉() {
        // 列表按当前设置不列 dotfile，索引里有（walkdir 默认收录）：
        // 不加这道判断，每进一次目录就会把该目录的隐藏文件从索引清出去
        let indexed = vec![("/d/.env".to_string(), 5u64, 1u64)];
        let plan_hidden_out = plan_dir_sync("/d", &indexed, &[], false);
        assert!(plan_hidden_out.drop.is_empty(), "实得 {:?}", plan_hidden_out);
        let plan_shown = plan_dir_sync("/d", &indexed, &[], true);
        assert_eq!(plan_shown.drop, vec!["/d/.env".to_string()]);
    }

    #[test]
    fn 只对齐本层不动子目录() {
        let indexed = vec![("/d/sub/x.txt".to_string(), 1u64, 1u64)];
        let plan = plan_dir_sync("/d", &indexed, &[], false);
        assert!(plan.drop.is_empty(), "子目录条目不该被本层列表删掉：{:?}", plan);
    }

    #[test]
    fn 目录尾斜杠与无斜杠等价() {
        let indexed = vec![("/d/a.txt".to_string(), 10u64, 1u64)];
        let with_slash = plan_dir_sync("/d/", &indexed, &[], false);
        let without = plan_dir_sync("/d", &indexed, &[], false);
        assert_eq!(with_slash.drop, without.drop);
        assert_eq!(with_slash.drop, vec!["/d/a.txt".to_string()]);
    }

    #[test]
    fn 新文件要补进索引() {
        let present = vec![("new.txt".to_string(), 3u64, 9u64)];
        let plan = plan_dir_sync("/d", &[], &present, false);
        assert_eq!(plan.refresh, vec!["/d/new.txt".to_string()]);
        assert_eq!(plan.unchanged, 0);
    }
}
