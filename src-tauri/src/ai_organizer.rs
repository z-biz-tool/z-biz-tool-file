use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

/// 智能整理规则
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrganizeRule {
    pub name: String,
    pub pattern: String, // 正则表达式或关键词
    pub action: OrganizeAction,
}

/// 整理动作类型
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum OrganizeAction {
    Move { target: String },
    Copy { target: String },
    Tag { tags: Vec<String> },
    Rename { pattern: String },
    Archive { days: u64 },
}

/// 文件分类结果
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileCategory {
    pub r#type: String,           // image, document, video, audio, archive, code, other
    pub sub_type: String,         // 具体子类型
    pub topic: Option<String>,    // 主题（AI 推断）
    pub confidence: f64,          // 置信度
    pub tags: Vec<String>,        // 推荐标签
}

/// 智能整理器
pub struct SmartOrganizer {
    rules: Vec<OrganizeRule>,
    categories: HashMap<String, FileCategory>,
}

impl SmartOrganizer {
    pub fn new() -> Self {
        Self {
            rules: Self::default_rules(),
            categories: HashMap::new(),
        }
    }

    /// 默认整理规则
    fn default_rules() -> Vec<OrganizeRule> {
        vec![
            // 图片整理
            OrganizeRule {
                name: "Sort images by month".to_string(),
                pattern: ".*\\.(jpg|jpeg|png|gif|bmp|webp|heic|svg)$".to_string(),
                action: OrganizeAction::Move {
                    target: "Images/{year}/{month}".to_string(),
                },
            },
            // 文档整理
            OrganizeRule {
                name: "Sort documents by type".to_string(),
                pattern: ".*\\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|rtf)$".to_string(),
                action: OrganizeAction::Move {
                    target: "Documents/{type}".to_string(),
                },
            },
            // 视频整理
            OrganizeRule {
                name: "Sort videos by month".to_string(),
                pattern: ".*\\.(mp4|avi|mov|wmv|mkv|flv|webm)$".to_string(),
                action: OrganizeAction::Move {
                    target: "Videos/{year}/{month}".to_string(),
                },
            },
            // 音频整理
            OrganizeRule {
                name: "Sort audio by artist".to_string(),
                pattern: ".*\\.(mp3|wav|flac|aac|ogg|m4a)$".to_string(),
                action: OrganizeAction::Move {
                    target: "Music/{artist}".to_string(),
                },
            },
            // 压缩文件
            OrganizeRule {
                name: "Sort archives".to_string(),
                pattern: ".*\\.(zip|rar|7z|tar|gz|bz2|xz)$".to_string(),
                action: OrganizeAction::Move {
                    target: "Archives".to_string(),
                },
            },
            // 代码文件
            OrganizeRule {
                name: "Sort code files".to_string(),
                pattern: ".*\\.(rs|go|py|js|ts|tsx|jsx|java|c|cpp|h|hpp|cs|rb|php|swift|kt)$".to_string(),
                action: OrganizeAction::Move {
                    target: "Code/{ext}".to_string(),
                },
            },
        ]
    }

    /// 分类单个文件
    pub fn categorize_file(&mut self, path: &str) -> Result<FileCategory, String> {
        let path = Path::new(path);
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let (file_type, sub_type) = self.classify_by_extension(&ext);

        // 使用 AI 服务进行内容分析（需要调用 AI 接口）
        let topic = None; // TODO: 调用 AI 接口获取主题
        let confidence = 0.9;
        let tags = self.generate_tags(&file_type, &sub_type, path);

        let category = FileCategory {
            r#type: file_type,
            sub_type,
            topic,
            confidence,
            tags,
        };

        Ok(category)
    }

    /// 根据扩展名分类
    fn classify_by_extension(&self, ext: &str) -> (String, String) {
        let image_exts = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "svg"];
        let document_exts = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "rtf"];
        let video_exts = ["mp4", "avi", "mov", "wmv", "mkv", "flv", "webm"];
        let audio_exts = ["mp3", "wav", "flac", "aac", "ogg", "m4a"];
        let archive_exts = ["zip", "rar", "7z", "tar", "gz", "bz2", "xlsx"];
        let code_exts = [
            "rs", "go", "py", "js", "ts", "tsx", "jsx", "java", "c", "cpp", "h", "hpp", "cs", "rb",
            "php", "swift", "kt", "sql", "sh", "bat",
        ];

        if image_exts.contains(&ext.as_str()) {
            ("image", ext)
        } else if document_exts.contains(&ext.as_str()) {
            ("document", ext)
        } else if video_exts.contains(&ext.as_str()) {
            ("video", ext)
        } else if audio_exts.contains(&ext.as_str()) {
            ("audio", ext)
        } else if archive_exts.contains(&ext.as_str()) {
            ("archive", ext)
        } else if code_exts.contains(&ext.as_str()) {
            ("code", ext)
        } else {
            ("other", ext)
        }
    }

    /// 生成标签
    fn generate_tags(&self, file_type: &str, sub_type: &str, path: &Path) -> Vec<String> {
        let mut tags = Vec::new();
        tags.push(file_type.to_string());
        tags.push(sub_type.to_string());

        // 根据文件名添加标签
        let filename = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        if filename.contains("invoice") || filename.contains("账单") {
            tags.push("invoice".to_string());
            tags.push("finance".to_string());
        }
        if filename.contains("contract") || filename.contains("合同") {
            tags.push("contract".to_string());
            tags.push("legal".to_string());
        }
        if filename.contains("report") || filename.contains("报告") {
            tags.push("report".to_string());
        }
        if filename.contains("photo") || filename.contains("照片") {
            tags.push("photo".to_string());
        }
        if filename.contains("video") || filename.contains("视频") {
            tags.push("video".to_string());
        }
        if filename.contains("project") || filename.contains("项目") {
            tags.push("project".to_string());
        }

        tags
    }

    /// 应用整理规则
    pub fn apply_rules(&self, path: &str) -> Result<Vec<OrganizeAction>, String> {
        let path = Path::new(path);
        let filename = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        let mut actions = Vec::new();

        for rule in &self.rules {
            if regex::Regex::new(&rule.pattern).is_ok() {
                let regex = regex::Regex::new(&rule.pattern).unwrap();
                if regex.is_match(&filename) {
                    actions.push(rule.action.clone());
                }
            }
        }

        Ok(actions)
    }

    /// 批量整理目录
    pub fn organize_directory(&self, root_path: &str) -> Result<Vec<OrganizePlan>, String> {
        let root = Path::new(root_path);
        if !root.exists() {
            return Err(format!("目录不存在: {}", root_path));
        }

        let mut plans = Vec::new();

        for entry in WalkDir::new(root)
            .max_depth(5)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if path.is_file() {
                let filename = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();

                for rule in &self.rules {
                    if regex::Regex::new(&rule.pattern).is_ok() {
                        let regex = regex::Regex::new(&rule.pattern).unwrap();
                        if regex.is_match(&filename) {
                            let plan = self.create_organize_plan(path, rule);
                            plans.push(plan);
                        }
                    }
                }
            }
        }

        Ok(plans)
    }

    /// 创建整理计划
    fn create_organize_plan(&self, path: &Path, rule: &OrganizeRule) -> OrganizePlan {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let year = chrono::NaiveDateTime::from_timestamp_opt(
            now as i64,
            0,
        )
        .map(|dt| dt.year())
            .unwrap_or(2026);

        let month = chrono::NaiveDateTime::from_timestamp_opt(
            now as i64,
            0,
        )
        .map(|dt| dt.month())
            .unwrap_or(1);

        let target = match &rule.action {
            OrganizeAction::Move { target } => target
                .replace("{year}", &year.to_string())
                .replace("{month}", &format!("{:02}", month)),
            _ => String::new(),
        };

        OrganizePlan {
            source: path.to_string_lossy().to_string(),
            target,
            action: rule.action.clone(),
            rule_name: rule.name.clone(),
            created_at: now,
        }
    }

    /// 获取分类统计
    pub fn get_category_stats(&self) -> HashMap<String, usize> {
        let mut stats = HashMap::new();
        for category in self.categories.values() {
            *stats.entry(category.r#type.clone()).or_insert(0) += 1;
        }
        stats
    }
}

/// 整理计划
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrganizePlan {
    pub source: String,
    pub target: String,
    pub action: OrganizeAction,
    pub rule_name: String,
    pub created_at: u64,
}

// Tauri 命令
#[tauri::command]
pub fn organizer_categorize(path: &str) -> Result<Value, String> {
    let mut organizer = SmartOrganizer::new();
    let category = organizer.categorize_file(path)?;
    Ok(serde_json::to_value(category)?)
}

#[tauri::command]
pub fn organizer_organize_directory(root_path: &str) -> Result<Value, String> {
    let organizer = SmartOrganizer::new();
    let plans = organizer.organize_directory(root_path)?;
    Ok(json!({
        "plans": plans.iter().map(|plan| json!({
            "source": plan.source,
            "target": plan.target,
            "action": plan.action,
            "rule_name": plan.rule_name,
        })).collect::<Vec<_>>()
    }))
}

#[tauri::command]
pub fn organizer_get_categories() -> Result<Value, String> {
    let organizer = SmartOrganizer::new();
    let stats = organizer.get_category_stats();
    Ok(json!({
        "categories": stats
    }))
}
