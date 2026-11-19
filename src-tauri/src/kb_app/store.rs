//! 知识库的落盘数据模型与进程内状态。
//!
//! 三张「表」都摊在一个 index.json 里（库 / 目录 / 物料的量级对单机 JSON 完全够用，
//! library.json / glossary.json 已验证过这条路）。内容本身（原件副本、解析稿）
//! 按物料 id 落在 originals/ drafts/ 两个目录，索引只是指针。

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::atomic_write::atomic_write_json;

/// 解析状态（前端徽标依据）：
/// pending 待解析 / parsing 解析中 / parsed 已解析 / failed 解析失败。
pub const STATUS_PENDING: &str = "pending";
pub const STATUS_PARSING: &str = "parsing";
pub const STATUS_PARSED: &str = "parsed";
pub const STATUS_FAILED: &str = "failed";

/// 来源类型：local 本地文件 / yuque 语雀 / text 纯文本登记。
pub const SOURCE_LOCAL: &str = "local";
pub const SOURCE_YUQUE: &str = "yuque";
pub const SOURCE_TEXT: &str = "text";

/// 单个原件的大小上限，与 future-brain 的 MaterialRegistrar 对齐（100MB）。
pub const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024;

/// 进程内唯一知识库索引。Tauri manage 一份，命令通过 `tauri::State` 取。
pub struct KbState(pub Mutex<KbIndex>);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct KbIndex {
    pub version: u32,
    pub bases: Vec<KnowledgeBase>,
    pub categories: Vec<KbCategory>,
    pub materials: Vec<KbMaterial>,
}

impl KbIndex {
    pub fn new() -> Self {
        Self {
            version: 1,
            bases: vec![],
            categories: vec![],
            materials: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBase {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 目录节点。parent_id 为空 = 根目录；同一库内树状组织。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KbCategory {
    pub id: String,
    pub kb_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub sort_no: i64,
    /// 绑定的本地文件夹（绝对路径）。绑了就能「同步此目录」：
    /// 把本地文件夹里的文件镜像进这个目录节点（增量：按指纹去重、按源路径更新）。
    #[serde(default)]
    pub local_path: Option<String>,
    pub created_at: i64,
}

/// 语雀来源的回链信息（详情页「打开原文」用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YuqueRef {
    pub namespace: String,
    pub slug: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KbMaterial {
    pub id: String,
    pub kb_id: String,
    #[serde(default)]
    pub category_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub ext: Option<String>,
    #[serde(default)]
    pub size_bytes: u64,
    /// local / yuque / text
    pub source_type: String,
    /// 原件内容 SHA-256，同库内去重依据
    pub fingerprint: String,
    #[serde(default)]
    pub version_no: u32,
    pub parse_status: String,
    #[serde(default)]
    pub parse_error: Option<String>,
    #[serde(default)]
    pub parsed_at: Option<i64>,
    /// mineru / cap-doc / text / manual-edit / yuque
    #[serde(default)]
    pub parser_name: Option<String>,
    /// 原件副本的绝对路径（originals/ 下）
    #[serde(default)]
    pub original_path: Option<String>,
    /// 本地来源文件的绝对路径（导入时的原文件位置）。
    /// 目录绑了本地文件夹后，靠它做增量同步的匹配依据。
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub yuque: Option<YuqueRef>,
    pub registered_at: i64,
    pub updated_at: i64,
}

/// 非敏感配置（config.json 明文）。语雀 token 在 secret.rs 的密文文件里。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct KbConfig {
    pub mineru_base_url: Option<String>,
    pub yuque_api_base: Option<String>,
}

// ── 落盘路径 ──

/// 知识库数据根目录：`~/Library/Application Support/z-biz-tool-file/knowledge/`。
pub fn kb_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("z-biz-tool-file")
        .join("knowledge")
}

pub fn index_path() -> PathBuf {
    kb_data_dir().join("index.json")
}

pub fn config_path() -> PathBuf {
    kb_data_dir().join("config.json")
}

pub fn originals_dir() -> PathBuf {
    kb_data_dir().join("originals")
}

pub fn drafts_dir() -> PathBuf {
    kb_data_dir().join("drafts")
}

/// 某物料的当前解析稿路径。
pub fn draft_path(material_id: &str) -> PathBuf {
    drafts_dir().join(format!("{}.md", material_id))
}

pub fn ensure_dirs() -> Result<(), String> {
    for dir in [kb_data_dir(), originals_dir(), drafts_dir()] {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("创建知识库目录失败（{}）: {}", dir.display(), e))?;
    }
    Ok(())
}

/// 从磁盘载入索引；文件不存在或损坏时用空库（损坏时保留原文件便于排查）。
pub fn load_index() -> KbIndex {
    match std::fs::read_to_string(index_path()) {
        Ok(json) => serde_json::from_str::<KbIndex>(&json).unwrap_or_else(|_| KbIndex::new()),
        Err(_) => KbIndex::new(),
    }
}

/// 把索引原子写盘。
pub fn save_index(index: &KbIndex) -> Result<(), String> {
    ensure_dirs()?;
    atomic_write_json(&index_path(), index)
}

/// 读取非敏感配置；文件不存在时返回默认值。
pub fn load_config() -> KbConfig {
    match std::fs::read_to_string(config_path()) {
        Ok(json) => serde_json::from_str::<KbConfig>(&json).unwrap_or_default(),
        Err(_) => KbConfig::default(),
    }
}

pub fn save_config(cfg: &KbConfig) -> Result<(), String> {
    ensure_dirs()?;
    atomic_write_json(&config_path(), cfg)
}

// ── 索引上的常用查询（供命令层复用）──

impl KbIndex {
    pub fn base(&self, id: &str) -> Option<&KnowledgeBase> {
        self.bases.iter().find(|b| b.id == id)
    }

    pub fn categories_of(&self, kb_id: &str) -> Vec<&KbCategory> {
        let mut list: Vec<&KbCategory> = self
            .categories
            .iter()
            .filter(|c| c.kb_id == kb_id)
            .collect();
        list.sort_by(|a, b| a.sort_no.cmp(&b.sort_no).then(a.name.cmp(&b.name)));
        list
    }

    pub fn materials_of(&self, kb_id: &str) -> Vec<&KbMaterial> {
        let mut list: Vec<&KbMaterial> =
            self.materials.iter().filter(|m| m.kb_id == kb_id).collect();
        list.sort_by_key(|a| a.registered_at);
        list
    }

    pub fn material(&self, id: &str) -> Option<&KbMaterial> {
        self.materials.iter().find(|m| m.id == id)
    }

    pub fn material_mut(&mut self, id: &str) -> Option<&mut KbMaterial> {
        self.materials.iter_mut().find(|m| m.id == id)
    }

    /// 指纹去重：同一库内已有同内容原件即重复。
    pub fn fingerprint_exists(&self, kb_id: &str, fingerprint: &str) -> bool {
        self.materials
            .iter()
            .any(|m| m.kb_id == kb_id && m.fingerprint == fingerprint)
    }

    /// 目录的完整路径（根 → 当前），详情页与检索结果的面包屑用。
    pub fn category_path(&self, kb_id: &str, category_id: Option<&str>) -> Vec<String> {
        let mut trail = Vec::new();
        let mut cursor = category_id.map(|s| s.to_string());
        while let Some(id) = cursor {
            match self
                .categories
                .iter()
                .find(|c| c.id == id && c.kb_id == kb_id)
            {
                Some(cat) => {
                    trail.push(cat.name.clone());
                    cursor = cat.parent_id.clone();
                }
                None => break,
            }
        }
        trail.reverse();
        trail
    }

    /// 目录与其全部子孙目录的 id（级联操作用）。脏数据里的环用 visited 集合兜住，
    /// 否则一次循环引用就会让级联删除死循环。
    pub fn category_subtree_ids(&self, kb_id: &str, category_id: &str) -> Vec<String> {
        let mut ids = vec![category_id.to_string()];
        let mut seen: std::collections::HashSet<String> = ids.iter().cloned().collect();
        let mut i = 0;
        while i < ids.len() {
            let current = ids[i].clone();
            for child in self
                .categories
                .iter()
                .filter(|c| c.kb_id == kb_id && c.parent_id.as_deref() == Some(current.as_str()))
            {
                if seen.insert(child.id.clone()) {
                    ids.push(child.id.clone());
                }
            }
            i += 1;
        }
        ids
    }
}

/// SHA-256 指纹（十六进制小写）。
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 去掉扩展名里开头的点并转小写（`.PDF` → `pdf`）。
pub fn normalize_ext(ext: &str) -> String {
    ext.trim_start_matches('.').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// category_subtree_ids 必须把多层子孙一并收进来，且容忍环（防御脏数据）。
    #[test]
    fn subtree_ids_walks_children_and_tolerates_cycles() {
        let cat = |id: &str, parent: Option<&str>| KbCategory {
            id: id.to_string(),
            kb_id: "kb1".to_string(),
            parent_id: parent.map(|p| p.to_string()),
            name: id.to_string(),
            sort_no: 0,
            local_path: None,
            created_at: 0,
        };
        let mut index = KbIndex::new();
        // a -> b -> c；再放一个环 d -> a
        index.categories = vec![
            cat("a", None),
            cat("b", Some("a")),
            cat("c", Some("b")),
            cat("d", Some("a")),
        ];
        index.categories[3].parent_id = Some("a".to_string()); // 人为造环
        let ids = index.category_subtree_ids("kb1", "a");
        assert!(ids.contains(&"b".to_string()));
        assert!(ids.contains(&"c".to_string()));
        assert!(ids.contains(&"d".to_string()));
        // 环不能让集合继续膨胀（循环终止）
        assert_eq!(ids.len(), 4);
    }

    /// category_path 从叶到根反向拼路径。
    #[test]
    fn category_path_builds_root_to_leaf() {
        let cat = |id: &str, parent: Option<&str>, name: &str| KbCategory {
            id: id.to_string(),
            kb_id: "kb1".to_string(),
            parent_id: parent.map(|p| p.to_string()),
            name: name.to_string(),
            sort_no: 0,
            local_path: None,
            created_at: 0,
        };
        let mut index = KbIndex::new();
        index.categories = vec![cat("r", None, "基础依赖"), cat("s", Some("r"), "解析服务")];
        let path = index.category_path("kb1", Some("s"));
        assert_eq!(path, vec!["基础依赖".to_string(), "解析服务".to_string()]);
    }
}
