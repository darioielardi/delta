pub fn lang_for(path: &str) -> Option<String> {
    let ext = path.rsplit('.').next()?;
    let lang = match ext {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "rb" => "ruby",
        "json" => "json",
        "css" => "css",
        "html" => "html",
        "md" => "markdown",
        "sh" | "bash" => "bash",
        "toml" => "toml",
        "yml" | "yaml" => "yaml",
        _ => return None,
    };
    Some(lang.to_string())
}
