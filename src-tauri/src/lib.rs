mod commands;
mod search;
mod ebook;
mod pdf_utils;
mod image_utils;
mod convert;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
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
            commands::list_directory_with_hidden,
            commands::compress_to_zip,
            commands::extract_zip,
            commands::get_file_permissions,
            commands::open_with_default_app,
            commands::get_directory_size,
            search::full_disk_search,
            search::search_file_content,
            ebook::parse_epub,
            ebook::parse_mobi,
            ebook::get_epub_cover,
            pdf_utils::extract_pdf_text,
            pdf_utils::get_pdf_metadata,
            image_utils::get_image_info,
            image_utils::export_image,
            image_utils::resize_image,
            image_utils::rotate_image,
            image_utils::flip_image,
            image_utils::crop_image,
            image_utils::apply_filter,
            convert::text_to_epub,
            convert::text_to_mobi,
            convert::text_to_pdf,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
