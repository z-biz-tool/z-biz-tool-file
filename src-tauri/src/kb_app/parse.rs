//! 解析引擎：本地能力优先，按扩展名路由到 文本直读 / cap-doc 文本层 /
//! xlsx 本地抽表 / 内嵌 PP-OCR，MinerU 只是配置了才启用的可选增强。
//!
//! 路由规则：
//! - 文本类（md/txt/代码/JSON/HTML…）UTF-8 直读，零依赖；
//! - pdf → cap-doc 文字层；文字层为空判定为扫描件 → 抽内嵌整页图 → 本地 OCR；
//!   （MinerU 配置了则扫描件先走 MinerU，失败回落本地 OCR）
//! - docx/pptx → cap-doc（本地失败且配置了 MinerU 时才借道增强通道）；
//! - xlsx → 本地 zip+XML 抽表（Markdown 表格）；.doc/.xls 旧格式只能靠 MinerU；
//! - 图片 → MinerU（配置了）或本地 PP-OCR；
//! - 音视频只登记原件，解析显式失败（不静默假装成功）。
//!
//! 解析稿永远是 `drafts/{material_id}.md` 一个当前稿；人工编辑覆盖写回，
//! parser_name 改为 manual-edit（future-brain 的不可变版本链在本地单机场景
//! 收敛为单当前稿，历史从原件随时可以重新解析出来）。

use tauri::{AppHandle, Manager};

use crate::atomic_write::atomic_write;
use crate::kb_app::mineru;
use crate::kb_app::ocr;
use crate::kb_app::store::{self, KbConfig, KbMaterial, STATUS_FAILED, STATUS_PARSED};
use crate::kb_app::xlsx;
use crate::kb_app::KbState;

/// UTF-8 直读的文本类扩展名。
pub const TEXT_EXTS: &[&str] = &[
    "md", "markdown", "txt", "log", "csv", "tsv", "json", "jsonl", "ndjson", "html", "htm", "xml",
    "yaml", "yml", "toml", "ini", "conf", "py", "java", "js", "jsx", "ts", "tsx", "go", "rs", "c",
    "h", "cpp", "hpp", "cs", "rb", "php", "sh", "bash", "sql", "css", "scss", "less", "vue",
    "svelte", "swift", "kt", "scala", "lua",
];

/// 音视频只登记不解析。
pub const MEDIA_EXTS: &[&str] = &[
    "mp3", "wav", "m4a", "aac", "flac", "ogg", "wma", "amr", "mp4", "mov", "avi", "mkv", "webm",
    "flv", "wmv", "m4v",
];

pub fn is_text_ext(ext: &str) -> bool {
    TEXT_EXTS.contains(&ext)
}

/// 解析失败的统一口径：旧版二进制格式（.doc/.xls）本地没有解析路径，
/// MinerU 没配地址时明说，别让人猜。
fn mineru_required_hint(ext: &str) -> String {
    format!(
        "本地无法解析 .{ext}（旧版二进制格式）；可在「知识库 → 设置」配置 MinerU 服务（可选增强）后重试",
        ext = ext
    )
}

/// 重 IO/CPU 的同步抽取统一丢进 spawn_blocking，别占 tokio worker。
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

/// MinerU 增强通道：配置了才启用；成功则清洗图片引用后返回。
async fn try_mineru(url: &str, path: &std::path::Path) -> Option<Result<(String, String), String>> {
    match mineru::parse_file(url, path).await {
        Ok(out) => {
            let (clean, stripped) = mineru::strip_image_refs(&out.markdown);
            let mut md = clean;
            if stripped > 0 {
                md.push_str(&format!(
                    "\n\n> 原文包含 {} 张图片，本地解析未保存图片，已省略引用。\n",
                    stripped
                ));
            }
            Some(Ok((md, "mineru".to_string())))
        }
        Err(e) => Some(Err(e)),
    }
}

/// 扫描版 PDF：抽出内嵌的整页扫描图逐页 OCR（扫描件每页通常就是一张图，
/// 不需要 pdfium 渲染），页间加分页标记。
async fn ocr_scanned_pdf(
    path: &std::path::Path,
    material_id: &str,
) -> Result<(String, String), String> {
    let input = path.to_string_lossy().to_string();
    let out_dir = store::kb_data_dir().join("tmp").join(material_id);
    let report = run_blocking(move || {
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
        cap_doc::extract_pdf_images_blocking(input, out_dir.to_string_lossy().to_string())
    })
    .await?;
    let images = report.images;
    if images.is_empty() {
        return Err(
            "PDF 既没有文字层也抽不出内嵌图片，无法本地解析；可在设置里配置 MinerU 服务后重试"
                .to_string(),
        );
    }
    let total = images.len();
    let mut md = format!("（扫描版 PDF，共 {} 页，本地 OCR 识别）\n", total);
    for (i, img) in images.iter().enumerate() {
        let page = run_blocking({
            let img = img.clone();
            move || ocr::ocr_image(std::path::Path::new(&img))
        })
        .await?;
        md.push_str(&format!("\n\n--- 第 {} 页 ---\n\n{}", i + 1, page));
    }
    let _ = std::fs::remove_dir_all(store::kb_data_dir().join("tmp").join(material_id));
    Ok((md, "pp-ocr".to_string()))
}

/// 按路由规则产出 (markdown, parser_name)。本地能力优先，MinerU 只作为
/// 配置了才启用的图像增强通道 —— 默认全离线。
pub async fn produce_markdown(
    material: &KbMaterial,
    cfg: &KbConfig,
) -> Result<(String, String), String> {
    let ext = material
        .ext
        .as_deref()
        .map(store::normalize_ext)
        .unwrap_or_default();
    let original = material
        .original_path
        .clone()
        .ok_or_else(|| "物料没有原件副本（语雀/文本登记异常）".to_string())?;
    let path = std::path::PathBuf::from(&original);

    if is_text_ext(&ext) {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取文本失败（{}）: {}", original, e))?;
        return Ok((content, "text".to_string()));
    }

    if MEDIA_EXTS.contains(&ext.as_str()) {
        return Err("音视频暂不支持解析，仅登记保存原件".to_string());
    }

    let mineru_url = cfg
        .mineru_base_url
        .clone()
        .filter(|s| mineru::is_configured(Some(s)));

    // ── 本地优先：文字层 / OOXML / xlsx 表格，不依赖任何外部服务 ──
    match ext.as_str() {
        "docx" => {
            if let Ok(result) = run_blocking({
                let path = path.clone();
                move || cap_doc::extract_docx_text(&path).map(|d| (d.full, "cap-doc".to_string()))
            })
            .await
            {
                return Ok(result);
            }
        }
        "pptx" | "ppt" => {
            if let Ok(result) = run_blocking({
                let path = path.clone();
                move || {
                    cap_doc::extract_pptx_text(&path)
                        .map(|p| (p.with_page_marks, "cap-doc".to_string()))
                }
            })
            .await
            {
                return Ok(result);
            }
        }
        "xlsx" => {
            return run_blocking({
                let path = path.clone();
                move || {
                    let sheets = xlsx::extract_xlsx(&path)?;
                    let mut md = String::new();
                    for (name, table) in &sheets {
                        md.push_str(&format!("## {}\n\n{}\n", name, table));
                    }
                    Ok((md, "xlsx-local".to_string()))
                }
            })
            .await;
        }
        "pdf" => {
            let text = run_blocking({
                let original = original.clone();
                move || cap_doc::extract_pdf_text(&original)
            })
            .await?;
            if !ocr::text_layer_looks_empty(&text) {
                return Ok((text, "cap-doc".to_string()));
            }
            // 文字层缺失 = 扫描件，落到下面的图像理解通道
        }
        _ => {}
    }

    // ── 图像理解通道：图片 / 扫描件 PDF / 文字层兜底失败的 Office 旧格式 ──
    let is_image = matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tif" | "tiff"
    );
    let is_scanned_pdf = ext == "pdf";
    let needs_vision = is_image || is_scanned_pdf || matches!(ext.as_str(), "doc" | "xls");

    if needs_vision {
        // MinerU 配置了才走（用户内网服务，版面/表格效果更好），失败回落本地 OCR
        if let Some(url) = &mineru_url {
            if let Some(result) = try_mineru(url, &path).await {
                match result {
                    Ok(pair) => return Ok(pair),
                    Err(e) => {
                        if !is_image && !is_scanned_pdf {
                            // .doc/.xls：MinerU 失败且没有本地路径
                            return Err(format!(
                                "{}（MinerU 增强通道失败: {}）",
                                mineru_required_hint(&ext),
                                e
                            ));
                        }
                        eprintln!("[kb_app] MinerU 通道失败，回落本地 OCR: {}", e);
                    }
                }
            }
        }
        if is_scanned_pdf {
            return ocr_scanned_pdf(&path, &material.id).await;
        }
        if is_image {
            let img = path.clone();
            return run_blocking(move || ocr::ocr_image(&img))
                .await
                .map(|text| {
                    (
                        format!("（图片 OCR 识别）\n\n{}", text),
                        "pp-ocr".to_string(),
                    )
                });
        }
        return Err(mineru_required_hint(&ext));
    }

    // 非图像格式走到这里 = 本地抽取失败（如损坏的 docx）
    if let Some(url) = &mineru_url {
        if let Some(Ok(pair)) = try_mineru(url, &path).await {
            return Ok(pair);
        }
    }
    Err(format!(
        "本地解析 {} 失败（文件可能损坏）；可在设置里配置 MinerU 服务后重试",
        ext
    ))
}

/// 完整解析一个物料并落稿、更新状态。在后台任务里跑（`tauri::async_runtime::spawn`）。
pub async fn parse_and_store(app: &AppHandle, material_id: &str) -> Result<(), String> {
    // 快照：锁只保护「读物料 + 读配置」这一小段。
    let (material, cfg) = {
        let state = app.state::<KbState>();
        let index = state.0.lock().unwrap();
        let material = index
            .material(material_id)
            .cloned()
            .ok_or_else(|| format!("物料不存在: {}", material_id))?;
        (material, store::load_config())
    };

    let result = produce_markdown(&material, &cfg).await;
    let now = chrono::Utc::now().timestamp_millis();

    let (markdown, parser_name) = match result {
        Ok(pair) => pair,
        Err(err) => {
            // 失败：写明原因，前端徽标转红并展示。
            let state = app.state::<KbState>();
            let mut index = state.0.lock().unwrap();
            if let Some(mat) = index.material_mut(material_id) {
                mat.parse_status = STATUS_FAILED.to_string();
                mat.parse_error = Some(err.clone());
                mat.updated_at = now;
                eprintln!("[kb_app] 解析失败 {}: {}", mat.title, err);
            }
            store::save_index(&index)?;
            return Err(err);
        }
    };

    let chars = markdown.chars().count();
    // 与 future-brain 的解析稿上限对齐：超限截断并在状态里留警示，而不是拒绝入库。
    let (final_md, overflow_note) = if chars > 1_000_000 {
        (
            markdown.chars().take(1_000_000).collect::<String>(),
            Some(format!(
                "解析稿超过 100 万字符，已截断（原文 {} 字符）",
                chars
            )),
        )
    } else {
        (markdown, None)
    };
    let draft = store::draft_path(material_id);
    atomic_write(&draft, final_md.as_bytes())?;
    let state = app.state::<KbState>();
    let mut index = state.0.lock().unwrap();
    let Some(mat) = index.material_mut(material_id) else {
        return Err(format!("物料已被删除: {}", material_id));
    };
    mat.parse_status = STATUS_PARSED.to_string();
    mat.parse_error = overflow_note;
    mat.parser_name = Some(parser_name);
    mat.parsed_at = Some(now);
    mat.updated_at = now;
    store::save_index(&index)
}

/// 后台解析的统一入口：spawn 一个任务跑 parse_and_store，失败只打日志
/// （状态已经写进索引，前端轮询能看到 failed + 原因）。
pub fn spawn_parse(app: &AppHandle, material_id: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        eprintln!("[kb_parse] start {}", material_id);
        let r = parse_and_store(&app, &material_id).await;
        eprintln!("[kb_parse] done {} -> {:?}", material_id, r.is_ok());
        if let Err(e) = r {
            eprintln!("[kb_app] 后台解析任务失败 {}: {}", material_id, e);
        }
    });
}

/// 语雀导入用的：正文直接就是 markdown，登记时同步写稿。
pub fn write_initial_draft(material_id: &str, markdown: &str) -> Result<(), String> {
    store::ensure_dirs()?;
    atomic_write(&store::draft_path(material_id), markdown.as_bytes())
}
