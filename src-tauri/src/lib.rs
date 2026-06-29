mod anchor;
mod commands;
mod export;
mod git;
mod launch;
mod registry;
mod review;
mod storage;
mod watch;

#[cfg(debug_assertions)]
mod devbridge;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance MUST be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            crate::launch::route_launch(app, &args, std::path::Path::new(&cwd));
        }))
        // Restore size/position but NOT visibility — windows are created hidden
        // and shown by the frontend after first paint (cold-start flash fix), so
        // the plugin must not re-show them early.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(crate::watch::Watchers::default())
        .invoke_handler(tauri::generate_handler![
            commands::compute_diff,
            commands::get_file_diff,
            commands::open_review,
            commands::refresh_review,
            commands::save_review,
            commands::export_review,
            commands::open_target,
            commands::list_registry,
            commands::list_picker,
            commands::list_worktrees,
            commands::import_repo,
            commands::delete_review,
            commands::install_cli,
            commands::cli_status,
            commands::open_in_editor
        ])
        .setup(|app| {
            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            crate::launch::route_launch(app.handle(), &args, &cwd);
            #[cfg(debug_assertions)]
            crate::devbridge::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                // A window is gone: stop its watcher, and if the last review
                // window just closed, return to the launcher. (#9 cleanup, #14)
                tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
                    crate::watch::stop(app_handle, &label);
                    let remaining = app_handle
                        .webview_windows()
                        .into_keys()
                        .filter(|l| l != &label)
                        .count();
                    if remaining == 0 && label.starts_with("review-") {
                        let _ = crate::launch::open_home_window(app_handle);
                    }
                }
                // macOS: clicking the dock icon with no open windows reopens home.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    if !has_visible_windows {
                        let _ = crate::launch::open_home_window(app_handle);
                    }
                }
                _ => {}
            }
        });
}
