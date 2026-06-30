// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Invoked through the `delta`/`delta-dev` shim → run the CLI client and exit,
    // without ever constructing the Tauri/webview runtime.
    if delta_lib::invoked_as_cli() {
        std::process::exit(delta_lib::cli_main());
    }
    delta_lib::run()
}
