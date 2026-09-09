// OCR (光学字符识别) - 基于 Tesseract
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrResult {
    pub text: String,
    pub confidence: f32,
    pub language: String,
    pub duration_ms: u64,
}

/// OCR 支持的语言
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrLanguage {
    pub code: String,
    pub name: String,
}

/// 获取 OCR 支持的语言列表（必须已通过 tesseract 安装训练数据）
#[tauri::command]
pub fn list_ocr_languages() -> Vec<OcrLanguage> {
    vec![
        OcrLanguage { code: "eng".into(), name: "英语".into() },
        OcrLanguage { code: "chi_sim".into(), name: "简体中文".into() },
        OcrLanguage { code: "chi_tra".into(), name: "繁体中文".into() },
        OcrLanguage { code: "jpn".into(), name: "日语".into() },
        OcrLanguage { code: "kor".into(), name: "韩语".into() },
        OcrLanguage { code: "fra".into(), name: "法语".into() },
        OcrLanguage { code: "deu".into(), name: "德语".into() },
        OcrLanguage { code: "rus".into(), name: "俄语".into() },
        OcrLanguage { code: "spa".into(), name: "西班牙语".into() },
        OcrLanguage { code: "por".into(), name: "葡萄牙语".into() },
    ]
}

/// 对图片执行 OCR
#[tauri::command]
pub fn ocr_image(path: String, language: String) -> Result<OcrResult, String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let start = std::time::Instant::now();

    // 加载图片
    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width() as i32, rgb.height() as i32);

    // 初始化 Tesseract
    let mut lt = leptess::LepTess::new(None, &language)
        .map_err(|e| format!("初始化 Tesseract 失败: {}（请确认系统已安装 tesseract 和 {} 训练数据）", e, language))?;
    lt.set_image(rgb.as_raw(), w as u32, h as u32, 3, w as usize * 3)
        .map_err(|e| format!("设置图片失败: {}", e))?;

    let text = lt.get_utf8_text().map_err(|e| format!("OCR 失败: {}", e))?;
    let confidence = lt.mean_text_conf();

    Ok(OcrResult {
        text,
        confidence: confidence as f32,
        language,
        duration_ms: start.elapsed().as_millis(),
    })
}

/// 对 PDF 第一页执行 OCR（简化版：转图片 + OCR）
#[tauri::command]
pub fn ocr_pdf(path: String, language: String, page: u32) -> Result<OcrResult, String> {
    // 简化实现：调用 ocr_image，前端需要先把 PDF 转图片
    // 这里仅占位实现
    Err("PDF OCR 待集成 pdf-to-image，可先用图片 OCR 测试".to_string())
}

/// 检查 Tesseract 是否已安装
#[tauri::command]
pub fn check_tesseract() -> bool {
    std::process::Command::new("tesseract")
        .arg("--version")
        .output()
        .is_ok()
}
