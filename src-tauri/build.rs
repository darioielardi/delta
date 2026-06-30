use std::fs;

fn main() {
    // The app version's single source of truth is package.json (same as
    // tauri.conf.json's `"version": "../package.json"`). The Cargo crate version is
    // decoupled, so expose package.json's value to the CLI's `--version` at build time.
    let version = fs::read_to_string("../package.json")
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.trim().strip_prefix("\"version\":").map(str::to_string))
        })
        .map(|v| v.trim_matches(|c: char| c == ' ' || c == '"' || c == ',').to_string())
        .unwrap_or_else(|| "0.0.0".to_string());
    println!("cargo:rustc-env=DELTA_VERSION={version}");
    println!("cargo:rerun-if-changed=../package.json");

    tauri_build::build()
}
