mod anchor;
mod commands;
mod export;
mod git;
mod launch;
mod registry;
mod review;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance MUST be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            crate::launch::route_launch(app, &args, std::path::Path::new(&cwd));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::compute_diff,
            commands::get_file_diff,
            commands::open_review,
            commands::refresh_review,
            commands::save_review,
            commands::export_review,
            commands::open_target,
            commands::show_picker,
            commands::hide_picker,
            commands::list_registry,
            commands::list_worktrees,
            commands::import_repo,
            commands::delete_review,
            commands::install_cli
        ])
        .setup(|app| {
            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            crate::launch::route_launch(app.handle(), &args, &cwd);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
