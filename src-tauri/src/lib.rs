mod commands;
mod git;
mod review;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::compute_diff,
            commands::get_file_diff
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
