/// 让**单元测试**那个 exe 也带上 Windows manifest 资源，细节见 `build.rs`。
///
/// 一句话：manifest 声明了 Common-Controls 6.0.0.0，只有它才能让进程加载 WinSxS 里的
/// comctl32 **v6**；muda / rfd 静态导入的 `TaskDialogIndirect` 只有 v6 才导出。
/// 没有 manifest 就落到 System32 的 v5，`cargo test --lib` 一个用例都跑不起来，
/// 直接 0xc0000139（STATUS_ENTRYPOINT_NOT_FOUND）退出。
#[cfg(all(test, windows))]
#[link(name = "resource")]
extern "C" {}

mod commands;
mod archive;
mod conflict;
mod search;
mod ebook;
mod pdf_utils;
mod pdf_font;
mod pdf_image;
mod pdf_watermark;
mod pdf_compress;
mod pdf_ops;
mod image_utils;
mod convert;
mod watcher;
mod llm_config;
mod trash;
mod ai;
mod office;
mod sftp;
mod tags;
mod image_exif;
mod video_thumb;
mod indexer;
mod atomic_write;
mod path_guard;
mod ocr;
mod aria2;
mod library;
mod updater;

use watcher::WatcherState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(WatcherState::default())
        .manage(aria2::Aria2State::default())
        .manage(archive::job::Jobs::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_directory,
            commands::read_file_content,
            commands::search_files,
            commands::get_file_info,
            commands::rename_file,
            commands::delete_file,
            commands::move_file,
            commands::copy_file,
            conflict::occupied_names,
            conflict::existing_paths,
            commands::create_file,
            commands::create_directory,
            commands::batch_rename,
            commands::cleanup_epub_temp,
            commands::list_directory_with_hidden,
            commands::get_file_permissions,
            commands::open_with_default_app,
            commands::get_directory_size,
            commands::calculate_file_hash,
            commands::secure_delete_file,
            commands::find_duplicate_files,
            commands::set_file_permissions,
            commands::compare_directories,
            commands::sync_directories,
            commands::execute_command,
            commands::quick_look_preview,
            commands::get_file_tags,
            commands::set_file_tags,
            archive::cmds::archive_probe,
            archive::cmds::archive_info,
            archive::cmds::archive_conflicts,
            archive::cmds::archive_formats,
            archive::cmds::archive_extensions,
            archive::cmds::archive_open_extensions,
            archive::cmds::archive_extract_dir_name,
            archive::cmds::archive_extract,
            archive::cmds::archive_create,
            archive::cmds::archive_add,
            archive::cmds::archive_test,
            archive::cmds::archive_open_entry,
            archive::cmds::archive_cancel,
            archive::cmds::archive_job_state,
            search::full_disk_search,
            search::search_file_content,
            ebook::parse_epub,
            ebook::parse_mobi,
            ebook::get_epub_cover,
            pdf_utils::extract_pdf_text,
            pdf_utils::get_pdf_metadata,
            pdf_ops::get_pdf_pages,
            pdf_ops::merge_pdfs,
            pdf_ops::split_pdf,
            pdf_image::extract_pdf_images,
            pdf_watermark::watermark_pdf,
            pdf_compress::compress_pdf,
            commands::diff_files,
            commands::quick_diff_dirs,
            ocr::list_ocr_languages,
            ocr::ocr_image,
            ocr::ocr_pdf,
            ocr::check_tesseract,
            aria2::aria2_ping,
            aria2::aria2_add_uri,
            aria2::aria2_get_tasks,
            aria2::aria2_pause,
            aria2::aria2_remove,
            aria2::aria2_global_stat,
            aria2::start_aria2_daemon,
            library::library_stats,
            library::library_add_scan_dir,
            library::library_remove_scan_dir,
            library::library_scan_media,
            library::library_scan_books,
            library::library_query_media,
            library::library_query_books,
            library::library_toggle_favorite,
            library::library_set_rating,
            library::library_add_tag,
            library::library_update_read_progress,
            library::library_clear,
            updater::updater_current_version,
            updater::updater_check,
            updater::updater_download,
            updater::updater_download_latest,
            updater::updater_open_install_guide,
            updater::updater_silent_check,
            commands::reveal_in_finder,
            commands::open_terminal_at,
            image_utils::get_image_info,
            image_utils::save_image_data,
            llm_config::load_llm_config,
            llm_config::save_llm_config,
            llm_config::get_llm_config_path,
            llm_config::test_llm_config,
            trash::move_to_trash,
            trash::list_trash,
            trash::restore_from_trash,
            trash::permanent_delete,
            trash::empty_trash,
            trash::get_trash_size,
            trash::get_trash_path,
            trash::cleanup_expired_trash,
            commands::delete_to_trash,
            commands::analyze_storage,
            commands::run_shell_command,
            commands::list_allowed_programs,
            ai::ai_summarize_file,
            ai::ai_chat,
            office::convert_office_to_pdf,
            office::cleanup_office_cache,
            office::get_office_status,
            sftp::ssh_test_connection,
            sftp::ssh_list_dir,
            sftp::ssh_read_file,
            tags::get_all_tags,
            tags::set_file_tag,
            tags::delete_file_tag,
            indexer::indexer_init,
            indexer::indexer_build,
            indexer::indexer_search_files,
            indexer::indexer_search_content,
            indexer::indexer_get_stats,
            indexer::indexer_sync_dir,
            image_exif::read_exif,
            video_thumb::get_video_thumbnail,
            image_utils::export_image,
            image_utils::resize_image,
            image_utils::rotate_image,
            image_utils::flip_image,
            image_utils::crop_image,
            image_utils::apply_filter,
            image_utils::get_image_thumbnail,
            convert::text_to_epub,
            convert::text_to_mobi,
            convert::text_to_pdf,
            watcher::start_watching,
            watcher::stop_watching,
            watcher::get_watching_path,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 集成测试桥接：把内部模块的关键 API 暴露为 #[doc(hidden)] pub，
/// 让 tests/ 目录的集成测试可以直接调用真实生产代码路径。
#[doc(hidden)]
pub mod test_bridge {
    use std::path::{Path, PathBuf};

    // 集成测试要给这些类型**起名**（写函数签名、按 path 建索引），而 `archive` 模块是私有的：
    // pub struct 藏在私有模块里，外面拿得到值却写不出路径，只能靠类型推导绕着走。
    pub use crate::archive::{ArchiveInfo, CreateOptions, Entry, ProbeResult, Stats};
    pub use crate::archive::format::{Format, FormatOption};
    pub use crate::archive::Route;

    /// 当前能写的所有格式。测试**遍历这个**而不是自己列一张表：
    /// 自己列的话，后端加一种格式而测试忘了跟，那种格式就永远没被往返验过 ——
    /// 而这恰恰是最需要验的时刻。
    pub fn call_archive_writable_formats() -> Vec<FormatOption> {
        crate::archive::format::writable_formats()
    }

    /// 这个可写格式是不是"单流"（gz/xz/bz2/zst/lz4/br/lzma）——即只能装**一个文件**。
    ///
    /// `FormatOption` 是给前端渲染下拉框的，里面没有这个信息（前端不需要：它只把用户选的
    /// 路径原样交回后端，多源时 `single::create` 自己退回 tar 家族）。测试要按格式分派语料，
    /// 又不想再列一张字符串表——那样就是第二份真相，早晚和路由表长歪。
    /// 于是直接问 `Route::of`，它是后端分派唯一认的那份。
    pub fn is_single_stream_format(opt: &FormatOption) -> bool {
        Format::from_id(&opt.id)
            .map(|f| Route::of(f) == Some(Route::Single))
            .unwrap_or(false)
    }

    /// 测试专用临时目录：随作用域结束递归删除。
    ///
    /// 之前各测试的 `tempdir()/case()` 只建不删（注释里写的是"让 OS 回收"），
    /// 实测一次 `cargo test` 就在临时目录留下 1000+ 个目录、约 211 MB，每次 CI
    /// 与本地跑都再翻一倍。Drop 连测试 panic 的路径也能清掉。
    ///
    /// 通过 `Deref<Target = Path>` 保持和原来返回 `PathBuf` 时的写法完全一致。
    pub struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        pub fn new(tag: &str) -> Self {
            // 本机时钟粒度实测只有 1 µs（连续取 199 次时间戳，185 次完全相同），
            // 靠纳秒戳保证唯一是自欺欺人：两个并行测试会拿到同一个目录，
            // 先结束那个的 Drop 会把另一个还在用的目录整个删掉，
            // 表现成"偶发 ENOENT"的假故障。这里改成原子创建撞名就重试。
            static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let pid = std::process::id();
            for _ in 0..1000 {
                let nonce: u128 = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "z-biz-tool-file-{}-{}-{}-{}",
                    tag, pid, nonce, seq
                ));
                // create_dir（不是 create_dir_all）在目录已存在时报错，等于原子占位
                match std::fs::create_dir(&path) {
                    Ok(()) => return Self { path },
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        std::thread::yield_now();
                    }
                    // TMPDIR 指向已被系统回收的目录时先把它补出来
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        let _ = std::fs::create_dir_all(&*std::env::temp_dir());
                    }
                    Err(e) => panic!("创建临时目录失败: {}", e),
                }
            }
            panic!("创建临时目录失败：连续 1000 次都撞名");
        }
    }

    impl std::ops::Deref for TempDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.path
        }
    }

    /// 让 `fs::read_dir(&dir)` 这类泛型 `P: AsRef<Path>` 的调用点原样可用
    impl AsRef<Path> for TempDir {
        fn as_ref(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    pub fn validate_path_concurrent(raw: &str) -> Result<std::path::PathBuf, String> {
        match crate::path_guard::validate(raw) {
            Ok(p) => Ok(p),
            Err(e) => Err(format!("{:?}", e)),
        }
    }

    pub fn atomic_write_concurrent(p: &Path, bytes: &[u8]) -> Result<(), String> {
        crate::atomic_write::atomic_write(p, bytes)
    }

    /// 直接调真实 Tauri 命令函数做端到端集成验证
    pub fn call_delete_file(path: &str) -> Result<(), String> {
        crate::commands::delete_file_blocking(path)
    }
    pub fn call_move_file(src: &str, dest: &str) -> Result<String, String> {
        crate::commands::move_file_blocking(src, dest, None)
    }
    pub fn call_copy_file(src: &str, dest: &str) -> Result<String, String> {
        crate::commands::copy_file_blocking(src, dest, None)
    }
    /// 指定重名策略的版本；不指定时命令默认走 Rename（绝不静默覆盖）
    pub fn call_copy_file_with(
        src: &str,
        dest: &str,
        policy: crate::commands::ConflictPolicy,
    ) -> Result<String, String> {
        crate::commands::copy_file_blocking(src, dest, Some(policy))
    }
    pub fn call_move_file_with(
        src: &str,
        dest: &str,
        policy: crate::commands::ConflictPolicy,
    ) -> Result<String, String> {
        crate::commands::move_file_blocking(src, dest, Some(policy))
    }
    pub fn call_rename_file(old: &str, new: &str) -> Result<String, String> {
        crate::commands::rename_file_blocking(old, new)
    }
    pub fn call_create_file(path: &str, content: Option<String>) -> Result<(), String> {
        crate::commands::create_file_blocking(path, content)
    }
    // ---- 统一归档引擎（archive/）----
    //
    // 集成测试里没有 WebView 也没有 AppHandle，所以用 `Reporter::detached`：它只更新
    // 内存里的快照、不发事件，但驱动的是**和命令完全同一条生产代码路径**
    // （preflight → 分发到后端 → 统计）。这样"能不能解开真实世界的包"这件事
    // 不依赖前端就能验。

    fn archive_reporter(
        kind: crate::archive::job::Kind,
        a: &str,
        d: &str,
    ) -> crate::archive::job::Reporter {
        crate::archive::job::Reporter::detached(
            crate::archive::job::new_job_id(kind),
            kind,
            a.to_string(),
            d.to_string(),
        )
    }

    pub fn call_archive_probe(path: &str) -> crate::archive::ProbeResult {
        crate::archive::probe(Path::new(path))
    }

    pub fn call_archive_info(path: &str) -> Result<crate::archive::ArchiveInfo, String> {
        crate::archive::info(Path::new(path), None).map_err(|e| e.to_string())
    }

    /// 与 `archive::cmds::archive_extract` 同一套前置：先过 `path_guard`，再 preflight，再解压。
    ///
    /// 那两个 guard 调用**必须**留在这儿。它们不在引擎里（引擎只管"怎么解"），
    /// 少了这一步，"解压到 `/etc`"这类目标就没人拦，而集成测试会照样绿——
    /// 因为被测的那条路径压根没经过拦截逻辑。
    pub fn call_archive_extract(src: &str, dest: &str) -> Result<crate::archive::Stats, String> {
        call_archive_extract_with(src, dest, &crate::archive::ExtractOptions::default())
    }

    /// 只解指定条目。`keep_broken` 打开：真实大包里坏一条不该让整轮验证前功尽弃，
    /// 错误进 `Stats::errors`，由调用方决定算不算失败。
    pub fn call_archive_extract_entries(
        src: &str,
        dest: &str,
        entries: &[String],
    ) -> Result<crate::archive::Stats, String> {
        call_archive_extract_with(
            src,
            dest,
            &crate::archive::ExtractOptions {
                entries: Some(entries.to_vec()),
                keep_broken: true,
                include_children: true,
                ..Default::default()
            },
        )
    }

    fn call_archive_extract_with(
        src: &str,
        dest: &str,
        opts: &crate::archive::ExtractOptions,
    ) -> Result<crate::archive::Stats, String> {
        let src = crate::path_guard::readable(src).map_err(|e| e.to_string())?;
        // dest 通常还不存在，所以是 writable（按最近的已存在祖先校验）而不是 validate
        let dest = crate::path_guard::writable(dest).map_err(|e| e.to_string())?;
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut rep = archive_reporter(
            crate::archive::job::Kind::Extract,
            &src.display().to_string(),
            &dest.display().to_string(),
        );
        let det = crate::archive::preflight(&src, opts.password.as_deref())
            .map_err(|e| e.to_string())?;
        crate::archive::extract(&src, &det, &dest, opts, &mut rep, &cancel)
    }

    pub fn call_archive_create(
        sources: &[String],
        dest: &str,
        format: &str,
    ) -> Result<crate::archive::Stats, String> {
        call_archive_create_with(
            sources,
            dest,
            &crate::archive::CreateOptions {
                format: format.to_string(),
                ..Default::default()
            },
        )
    }

    /// 带完整选项的版本：密码、加密文件名、分卷、等级、算法都要能从这里进去，
    /// 否则"能不能压出一个 7-Zip 认得的加密分卷包"这种问题就没有可测的入口。
    ///
    /// 和 `call_archive_extract_with` 不同，这里**不**过 `path_guard`：
    /// 命令层（`archive::cmds::archive_create`）做的是 readable/writable + "目标已存在就拒绝"，
    /// 而这两件事各有专门的测试；这里要测的是引擎写出来的东西对不对。
    pub fn call_archive_create_with(
        sources: &[String],
        dest: &str,
        opts: &crate::archive::CreateOptions,
    ) -> Result<crate::archive::Stats, String> {
        let srcs: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut rep = archive_reporter(crate::archive::job::Kind::Create, dest, dest);
        crate::archive::create(&srcs, Path::new(dest), opts, &mut rep, &cancel)
    }

    pub fn call_archive_test(path: &str) -> Result<crate::archive::Stats, String> {
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut rep = archive_reporter(crate::archive::job::Kind::Test, path, "");
        let det = crate::archive::preflight(Path::new(path), None).map_err(|e| e.to_string())?;
        crate::archive::test(Path::new(path), &det, None, &mut rep, &cancel)
    }
    pub fn call_read_file_content(path: &str) -> Result<crate::commands::ReadFileResult, String> {
        crate::commands::read_file_content_blocking(path)
    }
    pub fn call_search_files(
        path: &str,
        query: &str,
    ) -> Result<Vec<crate::commands::SearchResultItem>, String> {
        crate::commands::search_files_blocking(path, query)
    }
    pub fn call_secure_delete_file(path: &str, passes: Option<u32>) -> Result<(), String> {
        crate::commands::secure_delete_file_blocking(path, passes)
    }
    pub fn call_set_file_permissions(path: &str, mode: u32) -> Result<(), String> {
        crate::commands::set_file_permissions(path, mode)
    }
    pub fn call_calculate_file_hash(path: &str, algorithm: &str) -> Result<String, String> {
        crate::commands::calculate_file_hash_blocking(path, algorithm)
    }
    pub fn call_get_directory_size(path: &str) -> Result<u64, String> {
        crate::commands::get_directory_size_blocking(path)
    }
    pub fn call_watermark_pdf(
        input: &str,
        output: &str,
        text: &str,
        opacity: f64,
    ) -> Result<u32, String> {
        crate::pdf_watermark::watermark_pdf_blocking(
            input.to_string(),
            output.to_string(),
            text.to_string(),
            opacity,
        )
    }
    pub fn call_compress_pdf(
        input: &str,
        output: &str,
        quality: u8,
        max_dimension: u32,
    ) -> Result<crate::pdf_compress::CompressReport, String> {
        crate::pdf_compress::compress_pdf_blocking(
            input.to_string(),
            output.to_string(),
            Some(quality),
            Some(max_dimension),
        )
    }
}
