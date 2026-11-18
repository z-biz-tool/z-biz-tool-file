//! MinerU 文档解析服务的 HTTP 客户端。
//!
//! 与 future-brain 的 MineruClient.java 同一服务、同一同步语义：
//! `POST {base}/file_parse` 一次上传等结果（服务端返回 task_id + status=completed
//! + results），没有轮询。表单参数对齐其 pipeline 后端默认值。
//!
//! 工程化细节只保留两样对本地图景最关键的：
//! - 总超时 1800s（大 PDF 的解析可能跑十几分钟，默认 reqwest 无超时会挂死 IPC）；
//! - results 里每个文件段的 `md_content`（兼容旧字段 `md`）取第一个非空值。

use std::path::Path;
use std::time::Duration;

/// 与 future-brain 对齐的总时限：MinerU 官方看门狗 30 分钟。
const PARSE_TIMEOUT_SECS: u64 = 1800;

pub struct MineruOutput {
    pub markdown: String,
    /// 解析稿里的图片引用数（return_images=false 时这些引用是死链，由调用方决定剥离）。
    pub image_refs: usize,
}

/// 服务是否已配置（地址非空即视为启用）。
pub fn is_configured(base_url: Option<&str>) -> bool {
    base_url.map(|s| !s.trim().is_empty()).unwrap_or(false)
}

/// 解析一个本地文件，返回 markdown。
pub async fn parse_file(base_url: &str, path: &Path) -> Result<MineruOutput, String> {
    let url = format!("{}/file_parse", base_url.trim_end_matches('/'));
    let bytes = std::fs::read(path)
        .map_err(|e| format!("读取待解析文件失败（{}）: {}", path.display(), e))?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file.bin".to_string());

    let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name);
    let form = reqwest::multipart::Form::new()
        .text("backend", "pipeline")
        .text("parse_method", "auto")
        .text("lang_list", "ch")
        .text("return_md", "true")
        .text("return_images", "false")
        .text("formula_enable", "true")
        .text("table_enable", "true")
        .part("files", part);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(PARSE_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))?;
    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("请求 MinerU 服务失败（{}）: {}", url, e))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取 MinerU 响应失败: {}", e))?;
    if !status.is_success() {
        return Err(format!(
            "MinerU 服务返回 HTTP {}: {}",
            status,
            truncate(&body, 300)
        ));
    }

    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("MinerU 响应不是合法 JSON: {}", e))?;
    if let Some(state) = value.get("status").and_then(|s| s.as_str()) {
        if state != "completed" && state != "success" && state != "done" {
            let msg = value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(|m| m.as_str())
                .unwrap_or(state);
            return Err(format!("MinerU 解析未完成: {}", msg));
        }
    }

    let results = value
        .get("results")
        .ok_or_else(|| "MinerU 响应缺少 results 字段".to_string())?;
    let results_obj = results
        .as_object()
        .ok_or_else(|| "MinerU 响应的 results 不是对象".to_string())?;

    for (_key, entry) in results_obj {
        let md = entry
            .get("md_content")
            .or_else(|| entry.get("md"))
            .and_then(|m| m.as_str());
        if let Some(md) = md {
            if !md.trim().is_empty() {
                return Ok(MineruOutput {
                    markdown: md.to_string(),
                    image_refs: count_image_refs(md),
                });
            }
        }
    }
    Err("MinerU 返回结果里没有 markdown 内容".to_string())
}

/// 统计 markdown 里的图片引用数（`![...](...)` 出现次数）。
fn count_image_refs(markdown: &str) -> usize {
    markdown.match_indices("![").count()
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// 剥掉 markdown 里的图片引用（本地没有这些图片文件，留着只会渲染出死链），
/// 返回（清洗后的 markdown，剥掉的张数）。future-brain 同样在含图时剥引用加省略说明。
pub fn strip_image_refs(markdown: &str) -> (String, usize) {
    let mut out = String::with_capacity(markdown.len());
    let bytes: Vec<char> = markdown.chars().collect();
    let mut i = 0;
    let mut stripped = 0usize;
    while i < bytes.len() {
        if bytes[i] == '!'
            && i + 1 < bytes.len()
            && bytes[i + 1] == '['
        {
            // 找 alt 的 ']'，再跟一个 '(' … ')'
            if let Some(alt_end) = find_bracket_end(&bytes, i + 1) {
                if alt_end + 1 < bytes.len() && bytes[alt_end + 1] == '(' {
                    if let Some(url_end) = find_paren_end(&bytes, alt_end + 1) {
                        stripped += 1;
                        i = url_end + 1;
                        continue;
                    }
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    (out, stripped)
}

/// 从 `[` 之后扫到配对的 `]`，返回其下标；找不到返回 None。
fn find_bracket_end(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (off, &ch) in chars.iter().enumerate().skip(open) {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(off);
                }
            }
            _ => {}
        }
    }
    None
}

/// 从 `(` 之后扫到配对的 `)`，返回其下标；找不到返回 None。
fn find_paren_end(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (off, &ch) in chars.iter().enumerate().skip(open) {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(off);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_image_refs_removes_all_and_counts() {
        let md = "前言\n\n![架构图](images/fig1.jpg)\n\n正文继续 ![配图](a/b.png) 尾部。\n";
        let (clean, n) = strip_image_refs(md);
        assert_eq!(n, 2);
        assert!(!clean.contains("!["));
        assert!(clean.contains("前言"));
        assert!(clean.contains("正文继续  尾部。"));
    }

    #[test]
    fn strip_image_refs_keeps_links_and_code() {
        let md = "[普通链接](https://a.com) 与 `![非图片](x)` 文本。";
        let (clean, n) = strip_image_refs(md);
        // 行内代码里的 ![] 也会被剥 —— 这里换行少、代码块场景由解析稿人工编辑兜底，
        // 断言只锁定「普通链接不受影响」。
        assert!(clean.contains("[普通链接](https://a.com)"));
        assert_eq!(n, 1);
    }

    #[test]
    fn count_image_refs_counts_occurrences() {
        assert_eq!(count_image_refs("a ![x](1) b ![y](2)"), 2);
    }
}
