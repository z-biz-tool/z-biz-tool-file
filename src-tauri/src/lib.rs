mod commands;
mod search;
mod ebook;
mod pdf_utils;
mod image_utils;
mod convert;
mod watcher;
mod llm_config;
mod trash;

use watcher::WatcherState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(WatcherState::default())
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
            commands::extract_zip,
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
            image_utils::get_image_info,
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
