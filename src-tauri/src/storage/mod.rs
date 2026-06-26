use crate::review::model::Review;
use std::fs;
use std::path::PathBuf;

pub trait Storage {
    fn load(&self, id: &str) -> Result<Option<Review>, String>;
    fn save(&self, review: &Review) -> Result<(), String>;
}

fn is_valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub struct JsonStorage {
    root: PathBuf,
}

impl JsonStorage {
    /// `root` is the directory holding `<id>.json` files (e.g. <app_data>/reviews).
    pub fn new(root: PathBuf) -> Self {
        JsonStorage { root }
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }
}

impl Storage for JsonStorage {
    fn load(&self, id: &str) -> Result<Option<Review>, String> {
        let path = self.path_for(id);
        match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("parse review {id}: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("read review {id}: {e}")),
        }
    }

    fn save(&self, review: &Review) -> Result<(), String> {
        if !is_valid_id(&review.id) {
            return Err(format!("invalid review id: {:?}", review.id));
        }
        fs::create_dir_all(&self.root).map_err(|e| format!("create reviews dir: {e}"))?;
        let text = serde_json::to_string_pretty(review).map_err(|e| format!("serialize review: {e}"))?;
        let final_path = self.path_for(&review.id);
        let tmp_path = self.root.join(format!("{}.json.tmp", review.id));
        fs::write(&tmp_path, text.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
        fs::rename(&tmp_path, &final_path).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::review::model::{Review, Snapshot};
    use tempfile::TempDir;

    fn sample() -> Review {
        let target = Target { repo_path: "/r".into(), worktree: Some("main".into()), mode: DiffMode::AllChanges, base: None };
        Review::new("0123456789abcdef".into(), target, Snapshot { base_oid: "b".into(), head_oid: None, captured_at: "t".into() }, "t".into())
    }

    #[test]
    fn load_missing_returns_none() {
        let dir = TempDir::new().unwrap();
        let s = JsonStorage::new(dir.path().join("reviews"));
        assert!(s.load("nope").unwrap().is_none());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = TempDir::new().unwrap();
        let s = JsonStorage::new(dir.path().join("reviews"));
        let r = sample();
        s.save(&r).unwrap();
        let loaded = s.load("0123456789abcdef").unwrap().unwrap();
        assert_eq!(loaded.id, "0123456789abcdef");
        assert_eq!(loaded.target.worktree.as_deref(), Some("main"));
    }

    #[test]
    fn save_leaves_no_tmp_file() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("reviews");
        let s = JsonStorage::new(root.clone());
        s.save(&sample()).unwrap();
        let entries: Vec<String> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(entries.len(), 1, "expected exactly one file, got {entries:?}");
        assert!(!entries.iter().any(|n| n.ends_with(".tmp")), "no temp file should remain, got {entries:?}");
        assert!(entries.iter().any(|n| n == "0123456789abcdef.json"), "expected 0123456789abcdef.json, got {entries:?}");
    }

    #[test]
    fn save_rejects_invalid_id() {
        let dir = TempDir::new().unwrap();
        let s = JsonStorage::new(dir.path().join("reviews"));
        let mut r = sample();
        r.id = "../escape".into();
        let result = s.save(&r);
        assert!(result.is_err(), "save should reject path-traversal id");
        assert!(result.unwrap_err().contains("invalid review id"));
    }
}
