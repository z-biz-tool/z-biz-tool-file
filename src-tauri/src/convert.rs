use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

/// 转换结果
#[derive(Serialize)]
pub struct ConvertResult {
    pub success: bool,
    pub message: String,
    pub output_path: String,
}

/// 简单Markdown转HTML
fn md_to_html(content: &str) -> String {
    let mut html = String::new();
    let mut in_code_block = false;
    let mut in_list = false;

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("```") {
            if in_code_block {
                html.push_str("</code></pre>\n");
                in_code_block = false;
            } else {
                html.push_str("<pre><code>");
                in_code_block = true;
            }
            continue;
        }

        if in_code_block {
            html.push_str(&html_escape(trimmed));
            html.push('\n');
            continue;
        }

        // 标题
        if trimmed.starts_with("### ") {
            if in_list { html.push_str("</ul>\n"); in_list = false; }
            html.push_str(&format!("<h3>{}</h3>\n", &trimmed[4..]));
        } else if trimmed.starts_with("## ") {
            if in_list { html.push_str("</ul>\n"); in_list = false; }
            html.push_str(&format!("<h2>{}</h2>\n", &trimmed[3..]));
        } else if trimmed.starts_with("# ") {
            if in_list { html.push_str("</ul>\n"); in_list = false; }
            html.push_str(&format!("<h1>{}</h1>\n", &trimmed[2..]));
        } else if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            if !in_list { html.push_str("<ul>\n"); in_list = true; }
            html.push_str(&format!("<li>{}</li>\n", inline_format(&trimmed[2..])));
        } else if trimmed.starts_with("> ") {
            if in_list { html.push_str("</ul>\n"); in_list = false; }
            html.push_str(&format!("<blockquote>{}</blockquote>\n", inline_format(&trimmed[2..])));
        } else if trimmed.is_empty() {
            if in_list { html.push_str("</ul>\n"); in_list = false; }
        } else {
            if in_list { html.push_str("</ul>\n"); in_list = false; }
            html.push_str(&format!("<p>{}</p>\n", inline_format(trimmed)));
        }
    }
    if in_list { html.push_str("</ul>\n"); }
    if in_code_block { html.push_str("</code></pre>\n"); }
    html
}

fn inline_format(text: &str) -> String {
    let mut result = html_escape(text);
    // **bold**
    while let Some(start) = result.find("**") {
        if let Some(end) = result[start + 2..].find("**") {
            let inner = &result[start + 2..start + 2 + end];
            result = format!("{}<strong>{}</strong>{}", &result[..start], inner, &result[start + 2 + end + 2..]);
        } else { break; }
    }
    // *italic*
    while let Some(start) = result.find('*') {
        if let Some(end) = result[start + 1..].find('*') {
            let inner = &result[start + 1..start + 1 + end];
            result = format!("{}<em>{}</em>{}", &result[..start], inner, &result[start + 1 + end + 1..]);
        } else { break; }
    }
    // `code`
    while let Some(start) = result.find('`') {
        if let Some(end) = result[start + 1..].find('`') {
            let inner = &result[start + 1..start + 1 + end];
            result = format!("{}<code>{}</code>{}", &result[..start], inner, &result[start + 1 + end + 1..]);
        } else { break; }
    }
    result
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// 纯文本转HTML段落
fn text_to_html(content: &str) -> String {
    let mut html = String::new();
    for para in content.split("\n\n") {
        let trimmed = para.trim();
        if !trimmed.is_empty() {
            html.push_str(&format!("<p>{}</p>\n", html_escape(trimmed).replace("\n", "<br/>\n")));
        }
    }
    html
}

/// 文本转EPUB
#[tauri::command]
pub fn text_to_epub(title: String, author: String, content: String, dest_path: String) -> Result<ConvertResult, String> {
    let is_md = content.contains("# ") || content.contains("**") || content.contains("- ");
    let html_body = if is_md { md_to_html(&content) } else { text_to_html(&content) };

    let uid = format!("urn:uuid:{}", uuid::Uuid::new_v4());
    let lang = if content.chars().any(|c| c > '\u{4e00}' && c < '\u{9fff}') { "zh" } else { "en" };

    let mimetype = "application/epub+zip";
    let container_xml = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#);

    let content_opf = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">{uid}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>{lang}</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>"#);

    let chapter_xhtml = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{lang}" lang="{lang}">
<head><title>{title}</title><style>body{{font-family:serif;margin:2em;line-height:1.6;}}h1{{font-size:1.8em;}}h2{{font-size:1.4em;}}h3{{font-size:1.2em;}}code{{background:#f0f0f0;padding:2px 4px;}}pre{{background:#f0f0f0;padding:1em;overflow:auto;}}</style></head>
<body>{html_body}</body>
</html>"#);

    let nav_xhtml = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{lang}">
<head><title>目录</title></head>
<body><nav epub:type="toc"><h1>目录</h1><ol><li><a href="chapter1.xhtml">{title}</a></li></ol></nav></body>
</html>"#);

    // 创建EPUB (ZIP)
    let file = fs::File::create(&dest_path).map_err(|e| format!("创建文件失败: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);

    // mimetype必须第一个且不压缩
    zip.start_file("mimetype", options).map_err(|e| format!("写入失败: {}", e))?;
    zip.write_all(mimetype.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;

    let options_compressed = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("META-INF/container.xml", options_compressed).map_err(|e| format!("写入失败: {}", e))?;
    zip.write_all(container_xml.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;

    zip.start_file("OEBPS/content.opf", options_compressed).map_err(|e| format!("写入失败: {}", e))?;
    zip.write_all(content_opf.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;

    zip.start_file("OEBPS/chapter1.xhtml", options_compressed).map_err(|e| format!("写入失败: {}", e))?;
    zip.write_all(chapter_xhtml.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;

    zip.start_file("OEBPS/nav.xhtml", options_compressed).map_err(|e| format!("写入失败: {}", e))?;
    zip.write_all(nav_xhtml.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;

    zip.finish().map_err(|e| format!("压缩失败: {}", e))?;

    Ok(ConvertResult {
        success: true,
        message: "EPUB转换成功".to_string(),
        output_path: dest_path,
    })
}

/// 文本转PDF (简化版: 先生成EPUB再提示用Calibre转PDF)
#[tauri::command]
pub fn text_to_pdf(title: String, content: String, dest_path: String) -> Result<ConvertResult, String> {
    let epub_path = dest_path.replace(".pdf", ".epub");
    let result = text_to_epub(title.clone(), "未知".to_string(), content, epub_path.clone())?;
    Ok(ConvertResult {
        success: true,
        message: format!("已生成EPUB文件: {}。PDF格式建议使用Calibre从EPUB转换。", epub_path),
        output_path: epub_path,
    })
}

/// 文本转MOBI (简化版: 生成EPUB后提示)
#[tauri::command]
pub fn text_to_mobi(title: String, author: String, content: String, dest_path: String) -> Result<ConvertResult, String> {
    // MOBI格式非常复杂，先转EPUB
    let epub_path = dest_path.replace(".mobi", ".epub");
    let result = text_to_epub(title.clone(), author.clone(), content, epub_path.clone())?;

    Ok(ConvertResult {
        success: true,
        message: format!("已生成EPUB文件: {}。MOBI格式建议使用Calibre从EPUB转换。", epub_path),
        output_path: epub_path,
    })
}
