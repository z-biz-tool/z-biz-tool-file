mod commands;
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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(WatcherState::default())
        .manage(aria2::Aria2State::default())
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
            commands::create_file,
            commands::create_directory,
            commands::batch_rename,
            commands::cleanup_epub_temp,
            commands::list_directory_with_hidden,
            commands::compress_to_zip,
            commands::compress_to_tar,
            commands::extract_zip,
            commands::extract_archive,
            commands::is_archive_supported,
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
            commands::list_zip_contents,
            commands::extract_zip_file,
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
        crate::commands::delete_file(path)
    }
    pub fn call_move_file(src: &str, dest: &str) -> Result<String, String> {
        crate::commands::move_file(src, dest, None)
    }
    pub fn call_copy_file(src: &str, dest: &str) -> Result<String, String> {
        crate::commands::copy_file(src, dest, None)
    }
    /// 指定重名策略的版本；不指定时命令默认走 Rename（绝不静默覆盖）
    pub fn call_copy_file_with(
        src: &str,
        dest: &str,
        policy: crate::commands::ConflictPolicy,
    ) -> Result<String, String> {
        crate::commands::copy_file(src, dest, Some(policy))
    }
    pub fn call_move_file_with(
        src: &str,
        dest: &str,
        policy: crate::commands::ConflictPolicy,
    ) -> Result<String, String> {
        crate::commands::move_file(src, dest, Some(policy))
    }
    pub fn call_rename_file(old: &str, new: &str) -> Result<String, String> {
        crate::commands::rename_file(old, new)
    }
    pub fn call_create_file(path: &str, content: Option<String>) -> Result<(), String> {
        crate::commands::create_file(path, content)
    }
    pub fn call_extract_zip(zip_path: &str, dest_dir: &str) -> Result<(), String> {
        crate::commands::extract_zip(zip_path, dest_dir)
    }
    pub fn call_extract_archive(archive_path: &str, dest_dir: &str) -> Result<(), String> {
        crate::commands::extract_archive(archive_path, dest_dir)
    }
    pub fn call_read_file_content(path: &str) -> Result<crate::commands::ReadFileResult, String> {
        crate::commands::read_file_content(path)
    }
    pub fn call_search_files(
        path: &str,
        query: &str,
    ) -> Result<Vec<crate::commands::SearchResultItem>, String> {
        crate::commands::search_files(path, query)
    }
    pub fn call_secure_delete_file(path: &str, passes: Option<u32>) -> Result<(), String> {
        crate::commands::secure_delete_file(path, passes)
    }
    pub fn call_set_file_permissions(path: &str, mode: u32) -> Result<(), String> {
        crate::commands::set_file_permissions(path, mode)
    }
    pub fn call_calculate_file_hash(path: &str, algorithm: &str) -> Result<String, String> {
        crate::commands::calculate_file_hash(path, algorithm)
    }
    pub fn call_get_directory_size(path: &str) -> Result<u64, String> {
        crate::commands::get_directory_size(path)
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
