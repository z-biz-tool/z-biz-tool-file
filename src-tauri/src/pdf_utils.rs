use crate::pdf_ops::load_doc;
use crate::path_guard;
use lopdf::{Document, Object};
use serde::{Deserialize, Serialize};

/// PDF元数据
#[derive(Debug, Serialize, Deserialize)]
pub struct PdfMeta {
    pub title: String,
    pub author: String,
    pub page_count: u32,
    pub creator: String,
}

/// 解码 PDF 字符串：规范里有 PDFDocEncoding、UTF-16BE（带/不带 BOM）和 UTF-8 三种常见写法。
pub(crate) fn decode_pdf_string(raw: &[u8]) -> String {
    if let Some(body) = raw.strip_prefix(&[0xFE, 0xFF]) {
        return utf16be_to_string(body);
    }
    // 不带 BOM 的 ASCII UTF-16BE（00 41 00 42 …）本身也是合法 UTF-8，必须先于 UTF-8 分支判断
    if raw.len() >= 4 && raw.len() % 2 == 0 && raw.iter().step_by(2).all(|&b| b == 0) {
        return utf16be_to_string(raw);
    }
    if let Ok(text) = std::str::from_utf8(raw) {
        if !text.contains('\0') {
            return text.to_string();
        }
    }
    // 中文标题常被写成无 BOM 的 UTF-16BE；解不出可读字符就退回逐字节
    if raw.len() >= 2 && raw.len() % 2 == 0 {
        let guess = utf16be_to_string(raw);
        if !guess.is_empty() && guess.chars().all(|c| !c.is_control()) {
            return guess;
        }
    }
    raw.iter().map(|&b| b as char).collect()
}

fn utf16be_to_string(raw: &[u8]) -> String {
    let units: Vec<u16> = raw
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

fn is_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    ) || byte.is_ascii_whitespace()
}

/// 读一个字面字符串 `(...)`，`i` 指向起始左括号。返回内容和右括号之后的位置。
/// 括号可以嵌套，转义序列按 PDF 规范处理（含八进制）。
fn read_literal(buf: &[u8], start: usize) -> (Vec<u8>, usize) {
    let mut out: Vec<u8> = Vec::new();
    let mut i = start + 1;
    let mut depth = 1usize;
    while i < buf.len() {
        match buf[i] {
            b'\\' => {
                i += 1;
                if i >= buf.len() {
                    break;
                }
                match buf[i] {
                    b'n' => out.push(b'\n'),
                    b'r' => out.push(b'\r'),
                    b't' => out.push(b'\t'),
                    b'b' => out.push(0x08),
                    b'f' => out.push(0x0C),
                    b'(' | b')' | b'\\' => out.push(buf[i]),
                    digit @ b'0'..=b'7' => {
                        let mut value = (digit - b'0') as u32;
                        let mut taken = 1;
                        while taken < 3 && i + 1 < buf.len() && (b'0'..=b'7').contains(&buf[i + 1]) {
                            i += 1;
                            value = value * 8 + (buf[i] - b'0') as u32;
                            taken += 1;
                        }
                        out.push(value as u8);
                    }
                    // 反斜杠 + 换行是行延续，本身不产出字符
                    other if other != b'\n' && other != b'\r' => out.push(other),
                    _ => {}
                }
                i += 1;
            }
            b'(' => {
                depth += 1;
                out.push(b'(');
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return (out, i);
                }
                out.push(b')');
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    (out, i)
}

/// 读一个十六进制字符串 `<...>`，`i` 指向起始 `<`。
fn read_hex(buf: &[u8], i: usize) -> Option<(Vec<u8>, usize)> {
    let end = (i + 1..buf.len()).find(|&j| buf[j] == b'>')?;
    let digits: Vec<u8> = buf[i + 1..end]
        .iter()
        .filter(|b| b.is_ascii_hexdigit())
        .copied()
        .collect();
    let mut out = Vec::with_capacity(digits.len() / 2);
    let mut pair = digits.chunks(2);
    while let Some(chunk) = pair.next() {
        if chunk.len() == 2 {
            let hi = (chunk[0] as char).to_digit(16)?;
            let lo = (chunk[1] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
        } else {
            // 奇数位补零尾，规范如此
            out.push(((chunk[0] as char).to_digit(16)? * 16) as u8);
        }
    }
    Some((out, end + 1))
}

/// 从一页（已解码的）内容流里取出可见文本。
/// 只认展示文本的操作符（Tj、TJ、'、"），并把换行/定位操作符折算成行边界，
/// 否则整页会挤成一行。
fn page_text(content: &[u8]) -> String {
    let mut out = String::new();
    // 连续出现的字符串操作数；遇到展示操作符才被消费
    let mut pending: Vec<String> = Vec::new();
    let mut i = 0usize;

    while i < content.len() {
        let byte = content[i];
        if byte == b'(' {
            let (raw, next) = read_literal(content, i);
            pending.push(decode_pdf_string(&raw));
            i = next;
            continue;
        }
        if byte == b'<' && content.get(i + 1) != Some(&b'<') {
            match read_hex(content, i) {
                Some((raw, next)) => {
                    pending.push(decode_pdf_string(&raw));
                    i = next;
                    continue;
                }
                None => i += 1,
            }
            continue;
        }
        if is_delimiter(byte) || byte.is_ascii_digit() || byte == b'-' || byte == b'.' || byte == b'+' {
            i += 1;
            continue;
        }
        // 到这里是一个关键字：可能是操作符，也可能是 /Name 之后的片段
        let start = i;
        while i < content.len() && !is_delimiter(content[i]) {
            i += 1;
        }
        match &content[start..i] {
            b"Tj" | b"'" | b"\"" => {
                if let Some(text) = pending.last() {
                    out.push_str(text);
                }
                pending.clear();
            }
            b"TJ" => {
                for text in pending.drain(..) {
                    out.push_str(&text);
                }
            }
            b"Td" | b"TD" | b"T*" | b"ET" => {
                pending.clear();
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            _ => {}
        }
    }
    out
}

/// 提取PDF全部文本
#[tauri::command]
pub fn extract_pdf_text(path: &str) -> Result<String, String> {
    let file = path_guard::readable(path)?;
    let doc = load_doc(&file)?;
    let mut pages = Vec::new();
    for (_, id) in doc.get_pages() {
        let content = doc
            .get_page_content(id)
            .map_err(|e| format!("读取页面内容失败: {:?}", e))?;
        let text = page_text(&content);
        let trimmed = text.trim_matches(|c| c == '\n' || c == ' ');
        if !trimmed.is_empty() {
            pages.push(trimmed.to_string());
        }
    }

    let result = pages.join("\n");
    if result.trim().is_empty() {
        Ok("无法提取PDF文本内容。该PDF可能是扫描件或加密文件。".to_string())
    } else {
        Ok(result)
    }
}

fn info_string(doc: &Document, key: &[u8]) -> Option<String> {
    let info_ref = doc.trailer.get(b"Info").ok()?;
    let info_id = info_ref.as_reference().ok()?;
    let info_obj = doc.get_object(info_id).ok()?;
    let dict = info_obj.as_dict().ok()?;
    match dict.get(key).ok()? {
        Object::String(bytes, _) => {
            let text = decode_pdf_string(bytes);
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

/// 获取PDF元数据
#[tauri::command]
pub fn get_pdf_metadata(path: &str) -> Result<PdfMeta, String> {
    let file = path_guard::readable(path)?;
    let doc = load_doc(&file)?;

    let title = info_string(&doc, b"Title").unwrap_or_else(|| {
        file.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知".to_string())
    });
    let author = info_string(&doc, b"Author").unwrap_or_else(|| "未知".to_string());
    let creator = info_string(&doc, b"Creator").unwrap_or_default();
    // 页数只能数页树：/Type /Pages 里含 "/Type /Page" 子串，按字节匹配必然多算，
    // 而现代 PDF 的页对象常藏在压缩对象流里，按字节又根本扫不到。
    let page_count = doc.get_pages().len() as u32;

    Ok(PdfMeta {
        title,
        author,
        page_count,
        creator,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// 手写一个结构完整、内容流可选 Flate 压缩的 PDF。
    /// 页面上画的每一行文字来自 `lines`，用于验证文本提取。
    fn make_pdf(lines: &[&str], compressed: bool) -> Vec<u8> {
        let stream_plain = {
            let mut buf = String::from("BT /F1 24 Tf 72 700 Td ");
            for line in lines {
                buf.push_str(&format!("({}) Tj 0 -28 Td ", line));
            }
            buf.push_str("ET");
            buf.into_bytes()
        };
        let (content, filter) = if compressed {
            use flate2::write::ZlibEncoder;
            use flate2::Compression;
            use std::io::Write;
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&stream_plain).unwrap();
            (encoder.finish().unwrap(), " /Filter /FlateDecode")
        } else {
            (stream_plain, "")
        };

        let mut objects: Vec<Vec<u8>> = Vec::new();
        objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        objects.push(
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>".to_vec(),
        );
        objects.push(
            b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
                .to_vec(),
        );
        objects.push(format!("<< /Length {}{} >>", content.len(), filter).into_bytes());
        objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec());

        let mut body = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, text) in objects.iter().enumerate() {
            offsets.push(body.len());
            body.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            body.extend_from_slice(text);
            body.extend_from_slice(b"\n");
            if i == 3 {
                body.extend_from_slice(b"stream\n");
                body.extend_from_slice(&content);
                body.extend_from_slice(b"\nendstream\n");
            }
            body.extend_from_slice(b"endobj\n");
        }
        let start = body.len();
        let count = objects.len() + 1;
        body.extend_from_slice(format!("xref\n0 {}\n", count).as_bytes());
        body.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            body.extend_from_slice(format!("{:010} 00000 n \n", offset).as_bytes());
        }
        body.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                count, start
            )
            .as_bytes(),
        );
        body
    }

    fn write_fixture(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn text_extracts_from_plain_content_stream() {
        let dir = crate::test_bridge::TempDir::new("pdftext-plain");
        let file = write_fixture(&dir, "plain.pdf", &make_pdf(&["Hello PDF", "second line"], false));
        let text = extract_pdf_text(file.to_str().unwrap()).unwrap();
        assert!(text.contains("Hello PDF"), "{}", text);
        assert!(text.contains("second line"), "{}", text);
        // 两个 Td 之间要折行，否则整页文字会糊成一行
        assert!(
            text.contains("Hello PDF\nsecond line"),
            "应该按定位操作符换行: {:?}",
            text
        );
    }

    /// 现代 PDF 的内容流几乎都压缩过；旧实现直接按字节扫原文，这类文件一个字符都取不出。
    #[test]
    fn text_extracts_from_flate_compressed_stream() {
        let dir = crate::test_bridge::TempDir::new("pdftext-zip");
        let file = write_fixture(
            &dir,
            "comp.pdf",
            &make_pdf(&["Compressed Hidden Text"], true),
        );
        let raw = fs::read(&file).unwrap();
        assert!(
            !String::from_utf8_lossy(&raw).contains("Compressed Hidden Text"),
            "fixture 必须真的是压缩过的，否则这条测试没有意义"
        );
        let text = extract_pdf_text(file.to_str().unwrap()).unwrap();
        assert_eq!(text, "Compressed Hidden Text");
    }

    #[test]
    fn text_reports_scan_or_encrypted_pdfs() {
        let dir = crate::test_bridge::TempDir::new("pdftext-empty");
        // 页面上一个字都没有（等价于扫描件：内容流只有绘制指令）
        let file = write_fixture(&dir, "blank.pdf", &make_pdf(&[], false));
        let text = extract_pdf_text(file.to_str().unwrap()).unwrap();
        assert!(text.contains("无法提取"), "{}", text);
    }

    #[test]
    fn text_rejects_blocked_path() {
        if !Path::new("/etc").exists() {
            return;
        }
        let err = extract_pdf_text("/etc/passwd").expect_err("系统文件必须被拦下");
        assert!(err.contains("系统保护") || err.contains("拒绝"), "{}", err);
    }

    #[test]
    fn metadata_pages_and_info_fields() {
        let dir = crate::test_bridge::TempDir::new("pdfmeta-info");
        // 3 页文档：/Type /Pages 节点本身含 "/Type /Page" 子串，旧的字节计数会数成 4
        let file = write_fixture(&dir, "meta.pdf", &make_meta_pdf(3, true));
        let meta = get_pdf_metadata(file.to_str().unwrap()).unwrap();
        assert_eq!(meta.page_count, 3);
        assert_eq!(meta.author, "张三");
        assert_eq!(meta.title, "年度报告");
        assert_eq!(meta.creator, "WPS");

        // 标题缺失时回退到文件名
        let no_title = write_fixture(&dir, "untitled.pdf", &make_meta_pdf(1, false));
        let meta = get_pdf_metadata(no_title.to_str().unwrap()).unwrap();
        assert_eq!(meta.title, "untitled");
        assert_eq!(meta.page_count, 1);
    }

    /// 多页 + 带 Info（UTF-16BE 中文）的最小 PDF
    fn make_meta_pdf(pages: usize, with_title: bool) -> Vec<u8> {
        let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", 3 + i)).collect();
        let mut objects: Vec<String> = Vec::new();
        objects.push("<< /Type /Catalog /Pages 2 0 R >>".to_string());
        objects.push(format!(
            "<< /Type /Pages /Kids [{}] /Count {} /MediaBox [0 0 612 792] >>",
            kids.join(" "),
            pages
        ));
        for i in 0..pages {
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /Contents {} 0 R >>",
                3 + pages + i
            ));
        }
        for i in 0..pages {
            let stream = format!("BT ({}) Tj ET", i + 1);
            objects.push(format!(
                "<< /Length {} >>\nstream\n{}\nendstream",
                stream.len(),
                stream
            ));
        }
        // Info：中文按 UTF-16BE + BOM 写（真实生产者的常见写法）
        let title = if with_title {
            format!("/Title <{}> ", utf16be_hex("年度报告"))
        } else {
            String::new()
        };
        objects.push(format!(
            "<< {} /Author <{}> /Creator (WPS) >>",
            title,
            utf16be_hex("张三")
        ));

        let mut body = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, text) in objects.iter().enumerate() {
            offsets.push(body.len());
            body.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, text).as_bytes());
        }
        let info_number = objects.len(); // Info 是最后一个对象
        let start = body.len();
        let count = objects.len() + 1;
        body.extend_from_slice(format!("xref\n0 {}\n", count).as_bytes());
        body.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            body.extend_from_slice(format!("{:010} 00000 n \n", offset).as_bytes());
        }
        body.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R /Info {} 0 R >>\nstartxref\n{}\n%%EOF\n",
                count, info_number, start
            )
            .as_bytes(),
        );
        body
    }

    fn utf16be_hex(text: &str) -> String {
        let mut hex = String::from("FEFF");
        for unit in text.encode_utf16() {
            hex.push_str(&format!("{:04X}", unit));
        }
        hex
    }

    #[test]
    fn decoding_handles_the_three_string_encodings() {
        assert_eq!(decode_pdf_string(b"plain"), "plain");
        assert_eq!(
            decode_pdf_string(&[0xFE, 0xFF, 0x4E, 0x2D, 0x65, 0x87]),
            "中文"
        );
        assert_eq!(decode_pdf_string(&utf16be_bytes("中文")), "中文");
        assert_eq!(decode_pdf_string(&utf16be_bytes("ascii")), "ascii");
        assert_eq!(
            decode_pdf_string("中文".as_bytes()),
            "中文",
            "UTF-8 字面量不该被当成 UTF-16"
        );
    }

    fn utf16be_bytes(text: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for unit in text.encode_utf16() {
            out.push((unit >> 8) as u8);
            out.push((unit & 0xFF) as u8);
        }
        out
    }

    #[test]
    fn literal_parsing_respects_escapes_and_nesting() {
        let buf = b"(a\\(b\\)c\\n\\101) Tj";
        let (raw, next) = read_literal(buf, 0);
        assert_eq!(decode_pdf_string(&raw), "a(b)c\nA");
        assert_eq!(next, 15);
        // 嵌套括号不需要转义
        let nested = b"(x (y) z) Tj";
        let (raw, _) = read_literal(nested, 0);
        assert_eq!(decode_pdf_string(&raw), "x (y) z");
    }

    #[test]
    fn hex_string_parsing() {
        let buf = b"<48656C6C6F> Tj";
        let (raw, next) = read_hex(buf, 0).unwrap();
        assert_eq!(decode_pdf_string(&raw), "Hello");
        assert_eq!(next, 12);
        // 奇数位补零尾
        let short = b"<414> Tj";
        let (raw, _) = read_hex(short, 0).unwrap();
        assert_eq!(raw, vec![0x41, 0x40]);
    }

    #[test]
    fn tj_array_concatenates_its_pieces() {
        let stream = b"BT /F1 24 Tf [(He) -500 (llo) ( world)] TJ ET";
        assert_eq!(page_text(stream).trim(), "Hello world");
    }
}
