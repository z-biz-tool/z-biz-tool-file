use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::Path;

/// EPUB/MOBI 章节结构
#[derive(Debug, Serialize, Deserialize)]
pub struct Chapter {
    pub title: String,
    pub content: String,
    pub index: usize,
}

/// EPUB/MOBI 书籍结构
#[derive(Debug, Serialize, Deserialize)]
pub struct EpubBook {
    pub title: String,
    pub author: String,
    pub chapters: Vec<Chapter>,
    pub cover_path: String,
}

/// 解析EPUB文件（使用zip直接解析，不依赖epub crate的具体API）
#[tauri::command]
pub fn parse_epub(path: &str) -> Result<EpubBook, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let file = fs::File::open(file_path).map_err(|e| format!("打开EPUB失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解压EPUB失败: {}", e))?;

    // 1. 解析container.xml找到OPF路径
    let mut opf_path = String::new();
    for i in 0..archive.len() {
        let mut zf = archive.by_index(i).map_err(|e| format!("读取ZIP条目失败: {}", e))?;
        if zf.name().ends_with("container.xml") {
            let mut content = String::new();
            zf.read_to_string(&mut content).ok();
            // 简单提取rootfile路径
            if let Some(start) = content.find("full-path=\"") {
                let s = start + 11;
                if let Some(end) = content[s..].find('"') {
                    opf_path = content[s..s + end].to_string();
                    break;
                }
            }
        }
    }

    let file_stem = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "未知书名".to_string());

    let mut title = file_stem.clone();
    let mut author = "未知作者".to_string();
    let mut spine_order: Vec<String> = Vec::new();
    let mut manifest: std::collections::HashMap<String, (String, String)> = std::collections::HashMap::new();

    // 2. 解析OPF文件
    if !opf_path.is_empty() {
        let opf_dir = opf_path.rfind('/').map(|i| &opf_path[..i]).unwrap_or("");
        if let Ok(mut zf) = archive.by_name(&opf_path) {
            let mut opf_content = String::new();
            zf.read_to_string(&mut opf_content).ok();

            // 提取标题
            if let Some(s) = opf_content.find("<dc:title>") {
                if let Some(e) = opf_content[s + 10..].find("</dc:title>") {
                    let t = opf_content[s + 10..s + 10 + e].trim().to_string();
                    if !t.is_empty() { title = t; }
                }
            }

            // 提取作者
            if let Some(s) = opf_content.find("<dc:creator") {
                if let Some(gt) = opf_content[s..].find('>') {
                    if let Some(e) = opf_content[s + gt + 1..].find("</dc:creator>") {
                        let a = opf_content[s + gt + 1..s + gt + 1 + e].trim().to_string();
                        if !a.is_empty() { author = a; }
                    }
                }
            }

            // 解析manifest
            for part in opf_content.split("<item ") {
                let mut id = String::new();
                let mut href = String::new();
                let mut media_type = String::new();
                for attr in part.splitn(20, '"').collect::<Vec<_>>().chunks(2) {
                    if attr.len() == 2 {
                        let key = attr[0].trim().trim_end_matches('=').trim();
                        let val = attr[1];
                        match key {
                            "id" => id = val.to_string(),
                            "href" => href = val.to_string(),
                            "media-type" => media_type = val.to_string(),
                            _ => {}
                        }
                    }
                }
                if !id.is_empty() && !href.is_empty() {
                    let full_href = if href.starts_with("http") {
                        href.clone()
                    } else if !opf_dir.is_empty() {
                        format!("{}/{}", opf_dir, href)
                    } else {
                        href.clone()
                    };
                    manifest.insert(id, (full_href, media_type));
                }
            }

            // 解析spine
            if let Some(spine_start) = opf_content.find("<spine") {
                if let Some(spine_end) = opf_content[spine_start..].find("</spine>") {
                    let spine = &opf_content[spine_start..spine_start + spine_end];
                    for itemref in spine.split("<itemref") {
                        if let Some(idref_start) = itemref.find("idref=\"") {
                            let s = idref_start + 7;
                            if let Some(e) = itemref[s..].find('"') {
                                spine_order.push(itemref[s..s + e].to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. 按spine顺序读取章节
    let mut chapters = Vec::new();
    let mut index = 0;

    for item_id in &spine_order {
        if let Some((href, _media_type)) = manifest.get(item_id) {
            match archive.by_name(href) {
                Ok(mut zf) => {
                    let mut content = String::new();
                    if zf.read_to_string(&mut content).is_ok() && !content.trim().is_empty() {
                        let ch_title = extract_html_title(&content)
                            .unwrap_or_else(|| format!("章节 {}", index + 1));
                        chapters.push(Chapter {
                            title: ch_title,
                            content,
                            index,
                        });
                        index += 1;
                    }
                }
                Err(_) => continue,
            }
        }
    }

    // 回退：如果没有找到章节，扫描所有HTML文件
    if chapters.is_empty() {
        let mut html_entries: Vec<(String, String)> = Vec::new();
        for i in 0..archive.len() {
            let mut zf = archive.by_index(i).map_err(|e| format!("读取ZIP条目失败: {}", e))?;
            let name = zf.name().to_string();
            if name.ends_with(".html") || name.ends_with(".xhtml") || name.ends_with(".htm") {
                let mut content = String::new();
                if zf.read_to_string(&mut content).is_ok() && !content.trim().is_empty() {
                    html_entries.push((name, content));
                }
            }
        }
        for (_, content) in html_entries {
            let ch_title = extract_html_title(&content)
                .unwrap_or_else(|| format!("章节 {}", index + 1));
            chapters.push(Chapter {
                title: ch_title,
                content,
                index,
            });
            index += 1;
        }
    }

    if chapters.is_empty() {
        chapters.push(Chapter {
            title: "全文".to_string(),
            content: format!("<p>无法从EPUB中提取章节内容。书名: {}</p>", title),
            index: 0,
        });
    }

    Ok(EpubBook {
        title,
        author,
        chapters,
        cover_path: String::new(),
    })
}

/// 从HTML内容中提取标题
fn extract_html_title(html: &str) -> Option<String> {
    if let Some(start) = html.find("<title>") {
        if let Some(end) = html.find("</title>") {
            let title = html[start + 7..end].trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }
    if let Some(start) = html.find("<h1") {
        if let Some(tag_end) = html[start..].find('>') {
            let h1_start = start + tag_end + 1;
            if let Some(h1_end) = html[h1_start..].find("</h1>") {
                let title = strip_html_tags(&html[h1_start..h1_start + h1_end]);
                if !title.is_empty() {
                    return Some(title);
                }
            }
        }
    }
    if let Some(start) = html.find("<h2") {
        if let Some(tag_end) = html[start..].find('>') {
            let h2_start = start + tag_end + 1;
            if let Some(h2_end) = html[h2_start..].find("</h2>") {
                let title = strip_html_tags(&html[h2_start..h2_start + h2_end]);
                if !title.is_empty() {
                    return Some(title);
                }
            }
        }
    }
    None
}

fn strip_html_tags(html: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        if ch == '<' { in_tag = true; }
        else if ch == '>' { in_tag = false; }
        else if !in_tag { result.push(ch); }
    }
    result.trim().to_string()
}

/// 解析MOBI文件（简单实现）
#[tauri::command]
pub fn parse_mobi(path: &str) -> Result<EpubBook, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let bytes = fs::read(file_path).map_err(|e| format!("读取MOBI文件失败: {}", e))?;
    if bytes.len() < 64 {
        return Err("MOBI文件过小，无法解析".to_string());
    }

    // 检查MOBI header magic
    if &bytes[60..64] != b"MOBI" {
        return Err("不是有效的MOBI文件格式".to_string());
    }

    let file_stem = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "未知书名".to_string());

    // 提取书名
    let title = if bytes.len() > 92 {
        let name_offset = u32::from_be_bytes(bytes[84..88].try_into().unwrap_or([0,0,0,0])) as usize;
        let name_len = u32::from_be_bytes(bytes[88..92].try_into().unwrap_or([0,0,0,0])) as usize;
        if name_offset > 0 && name_len > 0 && name_offset + name_len <= bytes.len() {
            String::from_utf8_lossy(&bytes[name_offset..name_offset + name_len]).trim_end_matches('\0').to_string()
        } else {
            file_stem
        }
    } else {
        file_stem
    };

    let content = extract_mobi_text_content(&bytes);
    let chapters = if content.is_empty() {
        vec![Chapter {
            title: "全文".to_string(),
            content: "<p>无法从MOBI文件中提取文本内容。建议转换为EPUB格式后阅读。</p>".to_string(),
            index: 0,
        }]
    } else {
        // 按HTML heading分割
        let mut chs = Vec::new();
        let mut idx = 0;
        let parts: Vec<&str> = content.split(|c: char| c == '\x00').collect();
        for part in parts {
            let trimmed = part.trim();
            if !trimmed.is_empty() {
                let ch_title = extract_html_title(trimmed)
                    .unwrap_or_else(|| format!("章节 {}", idx + 1));
                chs.push(Chapter {
                    title: ch_title,
                    content: trimmed.to_string(),
                    index: idx,
                });
                idx += 1;
            }
        }
        if chs.is_empty() {
            vec![Chapter { title: "全文".to_string(), content, index: 0 }]
        } else {
            chs
        }
    };

    Ok(EpubBook {
        title,
        author: "未知作者".to_string(),
        chapters,
        cover_path: String::new(),
    })
}

/// 从MOBI提取文本内容（简单实现）
fn extract_mobi_text_content(bytes: &[u8]) -> String {
    if bytes.len() < 78 { return String::new(); }

    let num_records = u16::from_be_bytes(
        <[u8; 2]>::try_from(&bytes[76..78]).unwrap_or([0, 0]),
    ) as usize;

    if num_records < 2 || bytes.len() < 78 + num_records * 8 {
        return String::new();
    }

    let mut parts = Vec::new();
    for i in 1..num_records {
        let off_start = 78 + i * 8;
        if off_start + 8 > bytes.len() { break; }

        let start = u32::from_be_bytes(bytes[off_start..off_start + 4].try_into().unwrap_or([0,0,0,0])) as usize;
        let next_off = 78 + (i + 1) * 8;
        let end = if i + 1 < num_records && next_off + 4 <= bytes.len() {
            u32::from_be_bytes(bytes[next_off..next_off + 4].try_into().unwrap_or([0,0,0,0])) as usize
        } else {
            bytes.len()
        };

        if start >= bytes.len() || end <= start { continue; }
        let end = end.min(bytes.len());

        let text = String::from_utf8_lossy(&bytes[start..end]);
        if text.contains('<') || !text.trim().is_empty() {
            parts.push(text.to_string());
        }
    }
    parts.join("\n")
}

/// 提取EPUB封面（base64编码）
#[tauri::command]
pub fn get_epub_cover(path: &str) -> Result<String, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let file = fs::File::open(file_path).map_err(|e| format!("打开EPUB失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解压EPUB失败: {}", e))?;

    // 查找封面图片
    for i in 0..archive.len() {
        let mut zf = archive.by_index(i).map_err(|e| format!("读取ZIP条目失败: {}", e))?;
        let name = zf.name().to_string().to_lowercase();
        if name.contains("cover") && (name.ends_with(".jpg") || name.ends_with(".jpeg") || name.ends_with(".png")) {
            let mut buf = Vec::new();
            zf.read_to_end(&mut buf).map_err(|e| format!("读取封面失败: {}", e))?;
            // 使用标准base64编码
            use std::fmt::Write;
            const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut result = String::with_capacity(buf.len() * 4 / 3 + 4);
            let chunks = buf.chunks(3);
            for chunk in chunks {
                let b0 = chunk[0] as u32;
                let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
                let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
                let triple = (b0 << 16) | (b1 << 8) | b2;
                result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
                result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
                result.push(if chunk.len() > 1 { CHARS[((triple >> 6) & 0x3F) as usize] as char } else { '=' });
                result.push(if chunk.len() > 2 { CHARS[(triple & 0x3F) as usize] as char } else { '=' });
            }
            return Ok(result);
        }
    }

    Err("未找到封面图片".to_string())
}
