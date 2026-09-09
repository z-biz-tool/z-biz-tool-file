use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::path::Path;
use walkdir::WalkDir;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

/// 索引文件存储路径
const INDEX_DIR: &str = "index";
const FILE_INDEX_FILE: &str = "file_index.json";
const CONTENT_INDEX_FILE: &str = "content_index.json";

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
#[derive(Debug, Serialize, Deserialize)]
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

    /// 保存索引到文件
    pub fn save(&self) -> Result<(), String> {
        let index_path = Path::new(INDEX_DIR);
        if !index_path.exists() {
            fs::create_dir_all(index_path).map_err(|e| e.to_string())?;
        }

        // 保存文件索引
        let file_index_path = index_path.join(FILE_INDEX_FILE);
        let file_index_data = serde_json::to_string(&self.file_index)
            .map_err(|e| e.to_string())?;
        fs::write(&file_index_path, file_index_data)
            .map_err(|e| e.to_string())?;

        // 保存内容索引（只保存最常见的词）
        let content_index_path = index_path.join(CONTENT_INDEX_FILE);
        let content_index_data = serde_json::to_string(&self.content_index)
            .map_err(|e| e.to_string())?;
        fs::write(&content_index_path, content_index_data)
            .map_err(|e| e.to_string())?;

        // 保存元数据
        let metadata_path = index_path.join("metadata.json");
        let metadata_data = serde_json::to_string(&self.metadata)
            .map_err(|e| e.to_string())?;
        fs::write(&metadata_path, metadata_data)
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    /// 从文件加载索引
    pub fn load() -> Result<Self, String> {
        let index_path = Path::new(INDEX_DIR);
        if !index_path.exists() {
            return Ok(Self::new());
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

        Ok(Self {
            file_index,
            content_index,
            metadata,
        })
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
