//! xlsx 的本地文本抽取：表格 → Markdown，不需要任何外部服务。
//!
//! 与 cap-doc 的 ooxml 模块同一哲学：不建 DOM，按 `<tag>…</tag>` 手扫。
//! xlsx 比 docx 麻烦的一点是「单元格的值在共享字符串表里」——
//! `<c t="s"><v>3</v></c>` 的 3 是 sharedStrings 的下标，要拼回来才是真文本。
//!
//! 抽取形态对齐检索/问答的需要：每个工作表一张 Markdown 表，
//! 行/列都设上限（超长表格截断并在表尾注明），避免一份几十万行的
//! 流水账把解析稿和 BM25 语料撑爆。

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use zip::ZipArchive;

/// 每个工作表最多抽多少行（含表头行）。
const MAX_ROWS_PER_SHEET: usize = 200;
/// 每个工作表最多抽多少列。
const MAX_COLS_PER_SHEET: usize = 40;
/// 单份 xlsx 抽取输出的总字符上限。
const MAX_OUTPUT_CHARS: usize = 400_000;

/// 抽取结果：(工作表名，Markdown 表) 列表。
pub fn extract_xlsx(path: &Path) -> Result<Vec<(String, String)>, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("打开 {} 失败: {}", path.display(), e))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("打开 xlsx 压缩包失败（{}）: {}", path.display(), e))?;

    let shared = read_shared_strings(&mut archive)?;
    let sheets = read_sheet_list(&mut archive)?;
    if sheets.is_empty() {
        return Err("xlsx 里没有工作表".to_string());
    }

    let mut out = Vec::with_capacity(sheets.len());
    let mut total = 0usize;
    for (name, target) in sheets {
        let table = match read_sheet_table(&mut archive, &target, &shared) {
            Ok(t) if !t.is_empty() => t,
            _ => continue,
        };
        let remaining = MAX_OUTPUT_CHARS.saturating_sub(total);
        if remaining == 0 {
            break;
        }
        let table = if table.len() > remaining {
            table.chars().take(remaining).collect::<String>()
        } else {
            table
        };
        total += table.len();
        out.push((name, table));
    }
    if out.is_empty() {
        return Err("xlsx 的工作表都没有可抽取的内容（可能是空表或全图片）".to_string());
    }
    Ok(out)
}

/// sharedStrings.xml 里的全部字符串（`<si>` 内所有 `<t>` 拼接）。
fn read_shared_strings<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<Vec<String>, String> {
    let Ok(mut entry) = archive.by_name("xl/sharedStrings.xml") else {
        return Ok(vec![]);
    };
    let mut xml = String::new();
    entry
        .read_to_string(&mut xml)
        .map_err(|e| format!("读 sharedStrings.xml 失败: {}", e))?;
    let mut strings = Vec::new();
    let mut cursor = 0;
    while let Some(start) = find_from(&xml, "<si>", cursor) {
        let Some(end) = find_from(&xml, "</si>", start) else {
            break;
        };
        let block = &xml[start + 4..end];
        strings.push(concat_tags(block, "<t", "</t>"));
        cursor = end + 5;
    }
    Ok(strings)
}

/// workbook.xml 里的（表名，部件路径）有序列表。
fn read_sheet_list<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<Vec<(String, String)>, String> {
    let xml = {
        // ZipFile 带 Drop，借用活到作用域结束 —— 必须用块收窄，
        // 否则后面 read_sheet_rels(archive) 撞双重可变借用。
        let mut entry = archive
            .by_name("xl/workbook.xml")
            .map_err(|e| format!("xlsx 缺少 workbook.xml: {}", e))?;
        let mut xml = String::new();
        entry
            .read_to_string(&mut xml)
            .map_err(|e| format!("读 workbook.xml 失败: {}", e))?;
        xml
    };

    let rels = read_sheet_rels(archive)?;
    let mut sheets = Vec::new();
    let mut cursor = 0;
    while let Some(tag_start) = find_from(&xml, "<sheet ", cursor) {
        let Some(tag_end) = find_from(&xml, ">", tag_start) else {
            break;
        };
        let tag = &xml[tag_start..tag_end + 1];
        let name = xml_attr(tag, "name").unwrap_or_default();
        let rid = xml_attr(tag, "r:id").or_else(|| xml_attr(tag, "id"));
        if let Some(rid) = rid {
            if let Some(target) = rels.get(&rid) {
                // Target 可能带前导 "/"，统一折算成 xl/ 下的相对路径
                let path = target.trim_start_matches('/').to_string();
                let path = if path.starts_with("xl/") {
                    path
                } else {
                    format!("xl/{}", path)
                };
                sheets.push((name, path));
            }
        }
        cursor = tag_end + 1;
    }
    Ok(sheets)
}

/// workbook.xml.rels：rId → worksheets/sheetN.xml。
fn read_sheet_rels<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let Ok(mut entry) = archive.by_name("xl/_rels/workbook.xml.rels") else {
        return Ok(std::collections::HashMap::new());
    };
    let mut xml = String::new();
    entry
        .read_to_string(&mut xml)
        .map_err(|e| format!("读 workbook.xml.rels 失败: {}", e))?;
    let mut map = std::collections::HashMap::new();
    let mut cursor = 0;
    while let Some(start) = find_from(&xml, "<Relationship ", cursor) {
        let Some(end) = find_from(&xml, ">", start) else {
            break;
        };
        let tag = &xml[start..end + 1];
        if let (Some(id), Some(target)) = (xml_attr(tag, "Id"), xml_attr(tag, "Target")) {
            map.insert(id, target);
        }
        cursor = end + 1;
    }
    Ok(map)
}

/// 一个工作表 → Markdown 表（含截断说明）。空表返回空串。
fn read_sheet_table<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    target: &str,
    shared: &[String],
) -> Result<String, String> {
    let Ok(mut entry) = archive.by_name(target) else {
        return Ok(String::new());
    };
    let mut xml = String::new();
    entry
        .read_to_string(&mut xml)
        .map_err(|e| format!("读 {} 失败: {}", target, e))?;

    // BTreeMap<行号, BTreeMap<列号, 文本>>：天然按行列有序
    let mut grid: BTreeMap<u32, BTreeMap<u32, String>> = BTreeMap::new();
    let mut cursor = 0;
    while let Some(start) = find_from(&xml, "<c ", cursor) {
        let Some(tag_end) = find_from(&xml, ">", start) else {
            break;
        };
        let self_close = find_from(&xml, "/>", start).filter(|p| *p < tag_end);
        let full_close = find_from(&xml, "</c>", tag_end);

        if let Some(sc) = self_close {
            // 自闭合 `<c r="A1" s="1"/>`：只有样式没有值
            cursor = sc + 2;
            continue;
        }
        let Some(fc) = full_close else {
            break;
        };
        let tag = &xml[start..tag_end + 1];
        let block = &xml[tag_end + 1..fc];
        if let Some(text) = cell_text(tag, block, shared) {
            if !text.is_empty() {
                if let Some((row, col)) = cell_ref(tag) {
                    grid.entry(row).or_default().insert(col, text);
                }
            }
        }
        cursor = fc + 4;
    }

    render_markdown(&grid)
}

/// 单元格取值：t="s" 共享字符串下标 / t="inlineStr" 内联 / 其余按原文。
fn cell_text(tag: &str, inner: &str, shared: &[String]) -> Option<String> {
    let t = xml_attr(tag, "t").unwrap_or_default();
    if t == "inlineStr" {
        let text = concat_tags(inner, "<t", "</t>");
        return Some(unescape_xml(&text));
    }
    let v_start = find_from(inner, "<v>", 0)? + 3;
    let v_end = find_from(inner, "</v>", v_start)?;
    let raw = inner[v_start..v_end].trim();
    if raw.is_empty() {
        return None;
    }
    if t == "s" {
        let idx: usize = raw.parse().ok()?;
        return shared.get(idx).cloned();
    }
    Some(unescape_xml(raw))
}

/// 从 `<c r="B12" ...>` 的 r 属性拆出 (行, 列下标)。
fn cell_ref(tag: &str) -> Option<(u32, u32)> {
    let r = xml_attr(tag, "r")?;
    parse_ref(&r)
}

fn parse_ref(reference: &str) -> Option<(u32, u32)> {
    let mut col = 0u32;
    let mut chars = reference.chars();
    let mut row_part = String::new();
    for c in chars.by_ref() {
        if c.is_ascii_alphabetic() {
            col = col * 26 + (c.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
        } else {
            row_part.push(c);
        }
    }
    if col == 0 || row_part.is_empty() {
        return None;
    }
    let row: u32 = row_part.parse().ok()?;
    Some((row, col - 1))
}

/// 网格 → Markdown 表，带行列截断。首行当表头（Markdown 表需要表头行）。
fn render_markdown(grid: &BTreeMap<u32, BTreeMap<u32, String>>) -> Result<String, String> {
    if grid.is_empty() {
        return Ok(String::new());
    }
    let total_rows = grid.len();
    let max_col = grid
        .values()
        .map(|row| row.keys().max().copied().unwrap_or(0))
        .max()
        .unwrap_or(0);
    let cols = (max_col + 1).min(MAX_COLS_PER_SHEET as u32) as usize;

    let mut table = String::new();
    let mut shown = 0usize;
    for (_, cells) in grid.iter() {
        if shown >= MAX_ROWS_PER_SHEET {
            table.push_str(&format!(
                "\n> 工作表共 {} 行，已截断显示前 {} 行。\n",
                total_rows, shown
            ));
            break;
        }
        let mut line = String::from("|");
        for col in 0..cols {
            let cell = cells.get(&(col as u32)).map(|s| s.as_str()).unwrap_or("");
            line.push(' ');
            line.push_str(&cell.replace('|', "\\|").replace('\n', " "));
            line.push_str(" |");
        }
        table.push_str(&line);
        table.push('\n');
        if shown == 0 {
            table.push_str(&format!("|{}|\n", "---|".repeat(cols)));
        }
        shown += 1;
    }
    Ok(table)
}

// ── 手扫 XML 的小工具（与 cap-doc ooxml 同风格，不引 XML 库）──

fn find_from(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    haystack[from..].find(needle).map(|p| p + from)
}

fn xml_attr(tag: &str, name: &str) -> Option<String> {
    let pattern = format!("{}=\"", name);
    let start = find_from(tag, &pattern, 0)? + pattern.len();
    let end = tag[start..].find('"').map(|p| p + start)?;
    Some(tag[start..end].to_string())
}

/// 把 block 里所有 `<t…>text</t>` 的文本按出现顺序拼接。
fn concat_tags(block: &str, open_prefix: &str, close: &str) -> String {
    let mut out = String::new();
    let mut cursor = 0;
    while let Some(start) = find_from(block, open_prefix, cursor) {
        // 跳过开标签本体（可能有属性/命名空间后缀），从 '>' 后取文本
        let Some(gt) = find_from(block, ">", start) else {
            break;
        };
        let Some(end) = find_from(block, close, gt) else {
            break;
        };
        out.push_str(&block[gt + 1..end]);
        cursor = end + close.len();
    }
    out
}

fn unescape_xml(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用 std::zip 手工造一个最小 xlsx（sharedStrings + 一个工作表），
    /// 验证共享字符串回拼、行列表格化与单元格转义。
    #[test]
    fn extracts_shared_strings_and_grid() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("kb-xlsx-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.xlsx");

        let shared = r#"<?xml version="1.0"?><sst><si><t>名称</t></si><si><t>MinerU</t></si><si><t>价格|含税</t></si></sst>"#;
        let sheet = r#"<?xml version="1.0"?><worksheet><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c></row></worksheet>"#;
        let book = r#"<?xml version="1.0"?><workbook><sheets><sheet name="流水" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        let rels = r#"<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#;

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = Default::default();
        for (name, content) in [
            ("xl/workbook.xml", book),
            ("xl/_rels/workbook.xml.rels", rels),
            ("xl/worksheets/sheet1.xml", sheet),
            ("xl/sharedStrings.xml", shared),
        ] {
            zip.start_file(name, opts).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();

        let sheets = extract_xlsx(&path).expect("抽取成功");
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].0, "流水");
        let md = &sheets[0].1;
        assert!(md.contains("| 名称 | MinerU |"), "首行应是共享字符串回拼: {}", md);
        assert!(md.contains("价格\\|含税"), "竖线要转义: {}", md);
        assert!(md.contains("12.5"), "数值单元格原文保留: {}", md);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// 列字母 → 下标（A=0, Z=25, AA=26）。
    #[test]
    fn parses_cell_refs() {
        assert_eq!(parse_ref("A1"), Some((1, 0)));
        assert_eq!(parse_ref("Z9"), Some((9, 25)));
        assert_eq!(parse_ref("AA10"), Some((10, 26)));
        assert_eq!(parse_ref("1"), None);
    }
}
