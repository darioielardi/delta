use crate::git::model::{DiffMode, Target};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentScope {
    Line,
    Range,
    File,
    General,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    New,
    Old,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub file: String,
    pub side: Side,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub scope: CommentScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Anchor>,
    pub body: String,
    #[serde(default)]
    pub stale: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub base_oid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_oid: Option<String>,
    pub captured_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewedEntry {
    pub file: String,
    pub diff_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub version: u32,
    pub id: String,
    pub target: Target,
    pub snapshot: Snapshot,
    #[serde(default)]
    pub comments: Vec<Comment>,
    #[serde(default)]
    pub viewed: Vec<ViewedEntry>,
    pub created_at: String,
    pub last_opened_at: String,
}

impl Review {
    pub fn new(id: String, target: Target, snapshot: Snapshot, now: String) -> Self {
        Review {
            version: 1,
            id,
            target,
            snapshot,
            comments: Vec::new(),
            viewed: Vec::new(),
            created_at: now.clone(),
            last_opened_at: now,
        }
    }
}

/// Stable review id: first 16 hex chars of SHA-256(repoPath \0 worktree \0 mode).
pub fn review_id(repo_path: &str, worktree: &str, mode: DiffMode) -> String {
    let mut h = Sha256::new();
    h.update(repo_path.as_bytes());
    h.update([0]);
    h.update(worktree.as_bytes());
    h.update([0]);
    h.update(mode.as_str().as_bytes());
    let digest = h.finalize();
    digest[..8].iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::DiffMode;

    #[test]
    fn review_id_is_stable_16_hex() {
        let a = review_id("/Users/me/p", "main", DiffMode::AllChanges);
        let b = review_id("/Users/me/p", "main", DiffMode::AllChanges);
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // mode participates in the key
        assert_ne!(a, review_id("/Users/me/p", "main", DiffMode::Uncommitted));
    }

    #[test]
    fn scope_and_side_serialize_lowercase() {
        assert_eq!(serde_json::to_string(&CommentScope::Range).unwrap(), "\"range\"");
        assert_eq!(serde_json::to_string(&Side::New).unwrap(), "\"new\"");
    }
}
