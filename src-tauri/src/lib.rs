mod anchor;
mod commands;
mod export;
mod git;
mod review;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::compute_diff,
            commands::get_file_diff,
            commands::open_review,
            commands::refresh_review,
            commands::save_review,
            commands::export_review
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
