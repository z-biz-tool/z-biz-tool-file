//! 文档类命令的薄封装层。
//!
//! 解析与操作逻辑已下沉到 `cap-doc`（`z-biz-tool-capability/crates/cap-doc`）。
//! 本模块只剩两件事，且这两件事**都属于本仓的策略，不属于原语层**：
//!
//! 1. **安全校验**：所有路径先过 [`path_guard`]。读黑名单 / 写黑名单 / 敏感目录
//!    拒绝 / 相对路径拒绝是本仓的安全策略，cap-doc 的 `paths` 只查「文件存在」。
//!    这是搬迁时最容易漏的一处：原实现把 `path_guard::readable/writable` 写在
//!    解析函数内部，随函数一起被搬走就会**静默丢守卫**。因此这里显式前置。
//! 2. **线程调度**：压缩 / 水印 / 抽图是整篇文档级的重编码，同步跑会卡死窗口，
//!    统一挪到 blocking 池。
//!
//! ## 为什么拆出 `*_checked`
//!
//! 每个重活命令都有一个同步的 `*_checked`（守卫 → 调 cap-doc），async 命令只是
//! 把它丢进 blocking 池。这样 `test_bridge` 能在**不 await** 的前提下验证
//! 「命令层真的过守卫了」——而守卫测试恰恰必须留在本仓，不能留在原语层。
//!
//! ## 一处有意的行为收紧
//!
//! `parse_epub` / `parse_mobi` / `get_epub_cover` 原本只做 `path.exists()`，
//! 没有过 `path_guard`（是历史遗漏）。这里补上 `readable`，与本仓其它读命令一致。
//! 属于收紧，不影响正常书籍路径。

use crate::path_guard;
use cap_doc::{CompressReport, EpubBook, ExtractReport, PdfMeta, PdfPageInfo};

// ───────────────────────── PDF · 只读 ─────────────────────────

#[tauri::command]
pub fn get_pdf_pages(path: &str) -> Result<Vec<PdfPageInfo>, String> {
    path_guard::readable(path)?;
    cap_doc::get_pdf_pages(path)
}

#[tauri::command]
pub fn extract_pdf_text(path: &str) -> Result<String, String> {
    path_guard::readable(path)?;
    cap_doc::extract_pdf_text(path)
}

#[tauri::command]
pub fn get_pdf_metadata(path: &str) -> Result<PdfMeta, String> {
    path_guard::readable(path)?;
    cap_doc::get_pdf_metadata(path)
}

// ───────────────────────── PDF · 写操作 ─────────────────────────

#[tauri::command]
pub fn merge_pdfs(input_paths: Vec<String>, output_path: String) -> Result<u32, String> {
    // 输入逐个过读守卫，输出过写守卫 —— 与搬迁前同一条策略链。
    // 空/单元素输入由 cap-doc 自己报「合并至少需要两个 PDF」，
    // 所以这里的循环对空输入是空转，错误措辞不会漂移。
    for path in &input_paths {
        path_guard::readable(path)?;
    }
    path_guard::writable(&output_path)?;
    cap_doc::merge_pdfs(input_paths, output_path)
}

#[tauri::command]
pub fn split_pdf(
    input_path: String,
    output_dir: String,
    page_ranges: Vec<[u32; 2]>,
) -> Result<Vec<String>, String> {
    path_guard::readable(&input_path)?;
    // 输出目录先拦：原实现在解析完输入之后才校验输出，这里提到最前
    // （fail fast，且保证「拒绝之前不把敏感目录建出来」）。
    path_guard::writable(&output_dir)?;
    cap_doc::split_pdf(input_path, output_dir, page_ranges)
}

#[tauri::command]
pub fn watermark_pdf(
    input_path: String,
    output_path: String,
    text: String,
    opacity: f64,
) -> Result<u32, String> {
    watermark_pdf_checked(input_path, output_path, text, opacity)
}

/// 同步版本：守卫 → 盖水印。命令层与测试桥共用同一条路径。
pub fn watermark_pdf_checked(
    input_path: String,
    output_path: String,
    text: String,
    opacity: f64,
) -> Result<u32, String> {
    path_guard::readable(&input_path)?;
    path_guard::writable(&output_path)?;
    cap_doc::watermark_pdf_blocking(input_path, output_path, text, opacity)
}

#[tauri::command]
pub async fn compress_pdf(
    input_path: String,
    output_path: String,
    quality: Option<u8>,
    max_dimension: Option<u32>,
) -> Result<CompressReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        compress_pdf_checked(input_path, output_path, quality, max_dimension)
    })
    .await
    .map_err(|e| format!("压缩任务中断: {}", e))?
}

/// 同步版本：守卫 → 压缩。
pub fn compress_pdf_checked(
    input_path: String,
    output_path: String,
    quality: Option<u8>,
    max_dimension: Option<u32>,
) -> Result<CompressReport, String> {
    path_guard::readable(&input_path)?;
    path_guard::writable(&output_path)?;
    cap_doc::compress_pdf_blocking(input_path, output_path, quality, max_dimension)
}

#[tauri::command]
pub async fn extract_pdf_images(
    input_path: String,
    output_dir: String,
) -> Result<ExtractReport, String> {
    tauri::async_runtime::spawn_blocking(move || extract_pdf_images_checked(input_path, output_dir))
        .await
        .map_err(|e| format!("提取任务中断: {}", e))?
}

/// 同步版本：守卫 → 抽图。
pub fn extract_pdf_images_checked(
    input_path: String,
    output_dir: String,
) -> Result<ExtractReport, String> {
    path_guard::readable(&input_path)?;
    path_guard::writable(&output_dir)?;
    cap_doc::extract_pdf_images_blocking(input_path, output_dir)
}

// ───────────────────────── EPUB / MOBI ─────────────────────────

#[tauri::command]
pub fn parse_epub(path: &str) -> Result<EpubBook, String> {
    path_guard::readable(path)?;
    cap_doc::parse_epub(path)
}

#[tauri::command]
pub fn parse_mobi(path: &str) -> Result<EpubBook, String> {
    path_guard::readable(path)?;
    cap_doc::parse_mobi(path)
}

#[tauri::command]
pub fn get_epub_cover(path: &str) -> Result<String, String> {
    path_guard::readable(path)?;
    cap_doc::get_epub_cover(path)
}

#[cfg(test)]
mod guard_tests {
    //! 守卫测试必须留在本仓：它们验证的是 `path_guard` 在文档命令上的拦截，
    //! 而这层策略不在 cap-doc 里。搬迁前这些用例写在各个解析模块内部，
    //! 搬走时若不跟着搬回，就等于「静默删掉了安全回归测试」。
    //!
    //! 这里只断言「被拦下」，不需要合法 PDF —— 守卫在解析之前执行。

    use super::*;

    #[test]
    fn read_commands_refuse_system_paths() {
        if !std::path::Path::new("/etc").exists() {
            return;
        }
        for err in [
            get_pdf_pages("/etc/passwd").unwrap_err(),
            extract_pdf_text("/etc/passwd").unwrap_err(),
            get_pdf_metadata("/etc/passwd").unwrap_err(),
            parse_epub("/etc/passwd").unwrap_err(),
        ] {
            assert!(
                err.contains("系统保护") || err.contains("拒绝"),
                "系统目录必须被拦下，实际: {}",
                err
            );
        }
    }

    #[test]
    fn write_commands_refuse_sensitive_destination() {
        let dir = std::env::temp_dir().join(format!("zbiz-docguard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 输入只要「存在」即可：读守卫放行后，写守卫会在解析之前拦下输出。
        let input_path = dir.join("input.pdf");
        std::fs::write(&input_path, b"%PDF-1.4\n%%EOF\n").unwrap();
        let input = input_path.to_string_lossy().to_string();
        let dest = dir.join(".ssh/out.pdf").to_string_lossy().to_string();

        let err = compress_pdf_checked(input.clone(), dest.clone(), Some(70), Some(1600))
            .expect_err("敏感目录必须被拦下");
        assert!(
            err.contains("保护") || err.contains("拒绝"),
            "compress 输出未过写守卫: {}",
            err
        );

        let err = watermark_pdf_checked(input, dest, "x".into(), 0.3)
            .expect_err("敏感目录必须被拦下");
        assert!(
            err.contains("保护") || err.contains("拒绝"),
            "watermark 输出未过写守卫: {}",
            err
        );

        assert!(
            !dir.join(".ssh").exists(),
            "拒绝之前不能把敏感目录建出来"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn traversal_output_dir_is_refused() {
        let dir = std::env::temp_dir().join(format!("zbiz-doctrav-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 同上：存在即可，不需要合法 PDF —— 写守卫先于解析。
        let input_path = dir.join("src.pdf");
        std::fs::write(&input_path, b"%PDF-1.4\n%%EOF\n").unwrap();
        let input = input_path.to_string_lossy().to_string();
        let traversal = dir.join("..").join("evil-out").to_string_lossy().to_string();

        let err = split_pdf(input, traversal, vec![[1, 1]]).expect_err("`..` 必须被拒");
        assert!(err.contains("不允许相对路径"), "实际: {}", err);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
