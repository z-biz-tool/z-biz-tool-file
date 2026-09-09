mod commands;
mod search;
mod ebook;
mod pdf_utils;
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
// mod ai_organizer; // 临时禁用: 旧代码编译错误
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
            commands::delete_to_trash,
            commands::analyze_storage,
            commands::run_shell_command,
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
