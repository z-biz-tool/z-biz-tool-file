//! 本地 OCR：PP-OCRv6 管线（oar-ocr crate），图片与扫描件的离线识别。
//!
//! 引擎进程内只建一份（OnceLock）：ONNX 会话的初始化是秒级开销，
//! 逐张图重建一次会把批量导入拖死。首次 `build()` 时若 `~/.oar` 里没有
//! 模型，会从 ModelScope 拉一次（约 20MB，SHA-256 校验），之后完全离线。
//!
//! 文本拼装用 `predict_with_rows` 的行号：同一行的区域按 x 排序用空格连接，
//! 不同行换行 —— 读出来的顺序就是人眼的阅读顺序，而不是检测框的乱序。

use std::path::Path;
use std::sync::OnceLock;

use oar_ocr::prelude::{load_image, OAROCR, OAROCRBuilder, PpOcrV6Size};

/// 进程内唯一 OCR 引擎。Err 存首次初始化的失败原因（缺模型/网络等），
/// 下次调用原样返回 —— 不反复重试把用户晾在等待里。
static ENGINE: OnceLock<Result<OAROCR, String>> = OnceLock::new();

fn engine() -> Result<&'static OAROCR, String> {
    // OnceLock::get_or_init 的闭包可能联网拉模型，必须在调用方已进入
    // spawn_blocking 的前提下使用；本模块所有公开入口都满足这一前提。
    ENGINE
        .get_or_init(|| {
            OAROCRBuilder::pp_ocrv6(PpOcrV6Size::Small)
                .build()
                .map_err(|e| format!("初始化本地 OCR 引擎失败: {}（首次使用会从 ModelScope 下载约 20MB 模型到 ~/.oar，之后离线可用）", e))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// 识别一张图片，返回按阅读顺序拼好的纯文本。
///
/// 0.10.2 只有裸 `predict`（检测框乱序返回），这里自己重建阅读顺序：
/// 框按纵坐标排序，纵坐标差在行高一半以内的归为同一行，行内按横坐标排。
pub fn ocr_image(path: &Path) -> Result<String, String> {
    let engine = engine()?;
    let image = load_image(path)
        .map_err(|e| format!("读取图片失败（{}）: {}", path.display(), e))?;

    let results = engine
        .predict(vec![image])
        .map_err(|e| format!("OCR 推理失败: {}", e))?;

    let mut lines: Vec<(f32, f32, String)> = Vec::new(); // (min_y, min_x, text)
    let mut heights: Vec<f32> = Vec::new();
    for region in &results[0].text_regions {
        let Some((text, _confidence)) = region.text_with_confidence() else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let points = &region.bounding_box.points;
        if points.is_empty() {
            continue;
        }
        let min_y = points.iter().map(|p| p.y).fold(f32::INFINITY, f32::min);
        let max_y = points.iter().map(|p| p.y).fold(f32::NEG_INFINITY, f32::max);
        let min_x = points.iter().map(|p| p.x).fold(f32::INFINITY, f32::min);
        heights.push(max_y - min_y);
        lines.push((min_y, min_x, text.to_string()));
    }
    if lines.is_empty() {
        return Ok(String::new());
    }
    lines.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.partial_cmp(&b.1).unwrap()));

    // 行归组阈值：框高中位数的 0.6 倍，最低 10px（页眉小字）
    heights.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median_height = heights[heights.len() / 2].max(10.0);
    let tolerance = median_height * 0.6;

    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_y = f32::NEG_INFINITY;
    for (min_y, _min_x, text) in lines {
        if !current.is_empty() && min_y - current_y > tolerance {
            out.push(std::mem::take(&mut current));
        } else if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(&text);
        current_y = min_y;
    }
    if !current.is_empty() {
        out.push(current);
    }
    Ok(out.join("\n"))
}

/// 判断从 PDF 文字层抽出的文本是否算「无文字层」（扫描件）。
/// 经验阈值：一份正常文档抽出的可打印字符远多于这些；低于阈值即认为
/// 文字层缺失或只有页眉页码，值得走 OCR。
pub fn text_layer_looks_empty(text: &str) -> bool {
    let printable = text
        .chars()
        .filter(|c| !c.is_whitespace() && c.is_alphanumeric())
        .count();
    printable < 20
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 阈值判定的两侧都要能证伪：正常文本不算空，空白/页码算空。
    #[test]
    fn text_layer_empty_threshold() {
        assert!(!text_layer_looks_empty("MinerU 对接验证文档，包含正文内容若干。"));
        assert!(text_layer_looks_empty("   \n\t "));
        assert!(text_layer_looks_empty("1\n2\n3"));
    }
}
