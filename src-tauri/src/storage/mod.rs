use crate::registry::model::{repo_name_from_path, Registry, ReviewEntry};
use crate::review::model::Review;
use std::fs;
use std::path::PathBuf;

pub trait Storage {
    fn load(&self, id: &str) -> Result<Option<Review>, String>;
    fn save(&self, review: &Review) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
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

    fn delete(&self, id: &str) -> Result<(), String> {
        if !is_valid_id(id) {
            return Err(format!("invalid review id: {id:?}"));
        }
        match fs::remove_file(self.path_for(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("delete review {id}: {e}")),
        }
    }
}

pub trait RegistryStore {
    fn load(&self) -> Result<Registry, String>;
    fn save(&self, reg: &Registry) -> Result<(), String>;
}

pub struct JsonRegistryStore {
    registry_path: PathBuf,
    reviews_dir: PathBuf,
}

impl JsonRegistryStore {
    pub fn new(registry_path: PathBuf, reviews_dir: PathBuf) -> Self {
        JsonRegistryStore { registry_path, reviews_dir }
    }

    /// Best-effort rebuild from the reviews dir. file_count is unknown here (0).
    fn rebuild(&self) -> Registry {
        let mut reg = Registry::empty();
        let entries = match fs::read_dir(&self.reviews_dir) {
            Ok(e) => e,
            Err(_) => return reg, // no reviews yet
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(review) = serde_json::from_str::<Review>(&text) {
                    let name = repo_name_from_path(&review.target.repo_path);
                    reg.upsert_review(ReviewEntry::from_review(&review, 0, name));
                }
            }
        }
        reg
    }
}

impl RegistryStore for JsonRegistryStore {
    fn load(&self) -> Result<Registry, String> {
        match fs::read_to_string(&self.registry_path) {
            Ok(text) => match serde_json::from_str::<Registry>(&text) {
                Ok(reg) => Ok(reg),
                Err(_) => Ok(self.rebuild()), // corrupt → rebuild
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(self.rebuild()),
            Err(e) => Err(format!("read registry: {e}")),
        }
    }

    fn save(&self, reg: &Registry) -> Result<(), String> {
        if let Some(parent) = self.registry_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create app data dir: {e}"))?;
        }
        let text = serde_json::to_string_pretty(reg).map_err(|e| format!("serialize registry: {e}"))?;
        let tmp = self.registry_path.with_extension("json.tmp");
        fs::write(&tmp, text.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
        fs::rename(&tmp, &self.registry_path).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::registry::model::RepoEntry;
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

    #[test]
    fn registry_save_then_load_roundtrips() {
        let dir = TempDir::new().unwrap();
        let store = JsonRegistryStore::new(dir.path().join("registry.json"), dir.path().join("reviews"));
        let mut reg = Registry::empty();
        reg.upsert_repo(RepoEntry { id: "r1".into(), root: "/p".into(), name: "p".into(), default_branch: Some("main".into()), worktrees: vec![] });
        store.save(&reg).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.repos.len(), 1);
        assert_eq!(loaded.repos[0].name, "p");
    }

    #[test]
    fn registry_save_leaves_no_tmp_file() {
        let dir = TempDir::new().unwrap();
        let store = JsonRegistryStore::new(dir.path().join("registry.json"), dir.path().join("reviews"));
        store.save(&Registry::empty()).unwrap();
        let names: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert!(names.iter().any(|n| n == "registry.json"));
        assert!(!names.iter().any(|n| n.ends_with(".tmp")), "no tmp left, got {names:?}");
    }

    #[test]
    fn registry_load_missing_rebuilds_from_reviews_dir() {
        let dir = TempDir::new().unwrap();
        let reviews = dir.path().join("reviews");
        let s = JsonStorage::new(reviews.clone());
        s.save(&sample()).unwrap(); // sample() has id 0123456789abcdef, worktree "main"
        let store = JsonRegistryStore::new(dir.path().join("registry.json"), reviews);
        let reg = store.load().unwrap(); // registry.json does not exist → rebuild
        assert_eq!(reg.reviews.len(), 1);
        assert_eq!(reg.reviews[0].id, "0123456789abcdef");
        assert_eq!(reg.reviews[0].file_count, 0, "file_count unknown until reopened");
    }

    #[test]
    fn registry_load_corrupt_rebuilds() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(dir.path().join("registry.json"), b"{ not json").unwrap();
        let store = JsonRegistryStore::new(dir.path().join("registry.json"), dir.path().join("reviews"));
        let reg = store.load().unwrap(); // corrupt → rebuild → empty (no reviews dir)
        assert!(reg.reviews.is_empty());
    }
}
