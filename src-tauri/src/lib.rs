mod commands;
mod search;
mod ebook;
mod pdf_utils;

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
            search::full_disk_search,
            search::search_file_content,
            ebook::parse_epub,
            ebook::parse_mobi,
            ebook::get_epub_cover,
            pdf_utils::extract_pdf_text,
            pdf_utils::get_pdf_metadata,
        ])
        .setup(|_app| {
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
