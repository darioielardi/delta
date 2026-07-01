mod anchor;
mod cli;
mod commands;
mod export;
mod git;
mod ipc;
mod launch;
mod registry;
mod review;
mod storage;
mod walkthrough;
mod watch;

#[cfg(debug_assertions)]
mod devbridge;

use tauri::Manager;

pub use cli::{cli_main, invoked_as_cli};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Single-instance and the non-repo CLI guard now live in the `delta` shim
    // (`cli`/`ipc`): a CLI invocation forwards over the socket or `open -b`s the
    // bundle, which Launch Services single-instances. The app is only entered via
    // LS/dock/dev, so the old in-process TTY guard is gone.
    let builder = tauri::Builder::default();
    builder
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
        .manage(crate::walkthrough::ChildRegistry::default())
        .invoke_handler(tauri::generate_handler![
            commands::compute_diff,
            commands::get_file_diff,
            commands::list_commits,
            commands::open_review,
            commands::refresh_review,
            commands::save_review,
            commands::export_review,
            commands::open_target,
            commands::open_guide,
            commands::rewatch_window,
            commands::list_registry,
            commands::list_picker,
            commands::list_worktrees,
            commands::import_repo,
            commands::delete_review,
            commands::install_cli,
            commands::cli_status,
            commands::claude_status,
            commands::generate_walkthrough,
            commands::cancel_walkthrough,
            commands::open_in_editor
        ])
        .setup(|app| {
            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            crate::launch::route_launch(app.handle(), &args, &cwd);
            crate::ipc::start(app.handle());
            #[cfg(debug_assertions)]
            crate::devbridge::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                // A window is gone: stop its watcher. When the last window closes we
                // deliberately do NOT resurrect the launcher — the pop-up was unwanted.
                // (#9 cleanup, #14)
                tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
                    crate::watch::stop(app_handle, &label);
                    let remaining = app_handle
                        .webview_windows()
                        .into_keys()
                        .filter(|l| l != &label)
                        .count();
                    if remaining == 0 {
                        // macOS: stay alive so the `delta` shim socket-forwards warm (#23)
                        // and a dock-click reopens home (Reopen handler below). Other
                        // platforms have no dock/tray to recover a windowless process, so
                        // exit to avoid an orphan.
                        #[cfg(not(target_os = "macos"))]
                        app_handle.exit(0);
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
