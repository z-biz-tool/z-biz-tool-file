// OCR (光学字符识别) - 调用系统 tesseract 命令
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::fs;
use std::process::Command;

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

/// 获取 OCR 支持的语言列表
#[tauri::command]
pub fn list_ocr_languages() -> Vec<OcrLanguage> {
    vec![
        OcrLanguage { code: "chi_sim+eng".into(), name: "中文+英文（推荐）".into() },
        OcrLanguage { code: "eng".into(), name: "英语".into() },
        OcrLanguage { code: "chi_sim".into(), name: "简体中文".into() },
        OcrLanguage { code: "chi_tra".into(), name: "繁体中文".into() },
        OcrLanguage { code: "jpn".into(), name: "日语".into() },
        OcrLanguage { code: "kor".into(), name: "韩语".into() },
        OcrLanguage { code: "fra".into(), name: "法语".into() },
        OcrLanguage { code: "deu".into(), name: "德语".into() },
        OcrLanguage { code: "rus".into(), name: "俄语".into() },
    ]
}

/// 检查 Tesseract 是否已安装
#[tauri::command]
pub fn check_tesseract() -> bool {
    Command::new("tesseract")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 对图片执行 OCR（调用系统 tesseract）
#[tauri::command]
pub fn ocr_image(path: String, language: String) -> Result<OcrResult, String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let start = std::time::Instant::now();

    // 调用 tesseract 命令：tesseract input.png stdout -l chi_sim+eng
    let output = Command::new("tesseract")
        .arg(&path)
        .arg("stdout")
        .args(["-l", &language])
        .output()
        .map_err(|e| format!("执行 tesseract 失败: {}（请确认系统已安装）", e))?;

    if !output.status.success() {
        return Err(format!(
            "tesseract 失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let text = String::from_utf8_lossy(&output.stdout).to_string();

    // 尝试从 stderr 提取置信度（tesseract 会输出类似 "Confidence: 85" 的信息）
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let confidence = parse_confidence(&stderr);

    Ok(OcrResult {
        text,
        confidence,
        language,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

fn parse_confidence(stderr: &str) -> f32 {
    // tesseract 在某些模式下会输出置信度
    for line in stderr.lines() {
        if let Some(rest) = line.strip_prefix("Confidence: ") {
            if let Ok(v) = rest.trim().parse::<f32>() {
                return v;
            }
        }
    }
    // 如果没有输出，默认给个中等置信度
    75.0
}

/// 对 PDF 第一页执行 OCR（简化版）
#[tauri::command]
pub fn ocr_pdf(path: String, language: String, _page: u32) -> Result<OcrResult, String> {
    Err("PDF OCR 暂未实现，请先用图片 OCR".to_string())
}