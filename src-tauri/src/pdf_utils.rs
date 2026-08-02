use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// PDF元数据
#[derive(Debug, Serialize, Deserialize)]
pub struct PdfMeta {
    pub title: String,
    pub author: String,
    pub page_count: u32,
    pub creator: String,
}

/// 提取PDF全部文本
#[tauri::command]
pub fn extract_pdf_text(path: &str) -> Result<String, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let bytes = fs::read(file_path).map_err(|e| format!("读取PDF失败: {}", e))?;

    // 简单提取PDF文本：查找流对象中的文本
    let content = String::from_utf8_lossy(&bytes);
    let mut text_parts = Vec::new();

    // 提取BT...ET块中的文本
    let mut pos = 0;
    while let Some(bt_start) = content[pos..].find("BT") {
        let abs_start = pos + bt_start;
        if let Some(et_end) = content[abs_start..].find("ET") {
            let block = &content[abs_start..abs_start + et_end + 2];
            // 提取Tj和TJ操作符中的文本
            for line in block.lines() {
                let line = line.trim();
                // (text) Tj 格式
                if line.ends_with("Tj") {
                    if let Some(text_start) = line.find('(') {
                        if let Some(text_end) = line.rfind(") Tj").or_else(|| line.rfind(")Tj")) {
                            let text = &line[text_start + 1..text_end];
                            if !text.is_empty() {
                                text_parts.push(text.to_string());
                            }
                        }
                    }
                }
            }
            pos = abs_start + et_end + 2;
        } else {
            pos = abs_start + 2;
        }
    }

    if text_parts.is_empty() {
        // 回退：尝试提取所有括号内的文本
        let bytes_str = &content;
        let mut in_paren = false;
        let mut current = String::new();
        let mut depth = 0;
        for ch in bytes_str.chars() {
            if ch == '(' && !in_paren {
                in_paren = true;
                depth = 1;
            } else if ch == '(' && in_paren {
                depth += 1;
            } else if ch == ')' && in_paren {
                depth -= 1;
                if depth == 0 {
                    in_paren = false;
                    let t = current.trim();
                    if t.len() > 1 && !t.chars().all(|c| c.is_control() || c == '\\') {
                        text_parts.push(t.to_string());
                    }
                    current.clear();
                }
            } else if in_paren {
                if ch != '\\' && ch.is_alphabetic() || ch == ' ' || ch > '\u{4e00}' {
                    current.push(ch);
                }
            }
        }
    }

    let result = text_parts.join(" ");
    if result.is_empty() {
        Ok("无法提取PDF文本内容。该PDF可能是扫描件或加密文件。".to_string())
    } else {
        Ok(result)
    }
}

/// 获取PDF元数据
#[tauri::command]
pub fn get_pdf_metadata(path: &str) -> Result<PdfMeta, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let bytes = fs::read(file_path).map_err(|e| format!("读取PDF失败: {}", e))?;
    let content = String::from_utf8_lossy(&bytes);

    let title = extract_pdf_field(&content, "Title").unwrap_or_else(|| {
        file_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知".to_string())
    });
    let author = extract_pdf_field(&content, "Author").unwrap_or_else(|| "未知".to_string());
    let creator = extract_pdf_field(&content, "Creator").unwrap_or_else(|| "".to_string());

    // 计算页数
    let page_count = content.matches("/Type /Page").count() as u32;
    let page_count = if page_count == 0 {
        // 回退：查找Pages对象的Count
        if let Some(count_start) = content.find("/Count ") {
            let after = &content[count_start + 7..];
            let num_str: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            num_str.parse().unwrap_or(1)
        } else {
            1
        }
    } else {
        page_count
    };

    Ok(PdfMeta {
        title,
        author,
        page_count,
        creator,
    })
}

/// 从PDF元数据中提取字段
fn extract_pdf_field(content: &str, field: &str) -> Option<String> {
    let pattern = format!("/{} ", field);
    if let Some(start) = content.find(&pattern) {
        let after = &content[start + pattern.len()..];
        // 处理 (text) 格式
        if after.starts_with('(') {
            if let Some(end) = after.find(')') {
                let text = &after[1..end];
                return Some(text.to_string());
            }
        }
        // 处理 /Name 格式
        if after.starts_with('/') {
            let name: String = after[1..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}
