use crate::git::model::Target;
use crate::walkthrough::model::CachedWalkthrough;
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
    #[serde(default)]
    pub resolved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
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
    /// Cached AI walkthrough for this review, tagged with the diff signature it was
    /// generated against. Absent on legacy files (serde default → None). (#guide)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walkthrough: Option<CachedWalkthrough>,
    pub created_at: String,
    pub last_opened_at: String,
}

impl Review {
    pub fn new(id: String, target: Target, snapshot: Snapshot, now: String) -> Self {
        Review {
            version: 2,
            id,
            target,
            snapshot,
            comments: Vec::new(),
            viewed: Vec::new(),
            walkthrough: None,
            created_at: now.clone(),
            last_opened_at: now,
        }
    }
}

/// Stable review id: first 16 hex chars of SHA-256(repoPath \0 worktree).
/// Mode is intentionally excluded — one review per (repo, worktree).
pub fn review_id(repo_path: &str, worktree: &str) -> String {
    let mut h = Sha256::new();
    h.update(repo_path.as_bytes());
    h.update([0]);
    h.update(worktree.as_bytes());
    let digest = h.finalize();
    digest[..8].iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_id_is_stable_and_mode_independent() {
        let a = review_id("/Users/me/p", "main");
        let b = review_id("/Users/me/p", "main");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // worktree participates; mode is no longer part of the id (no arg).
        assert_ne!(a, review_id("/Users/me/p", "feat"));
    }

    #[test]
    fn scope_and_side_serialize_lowercase() {
        assert_eq!(serde_json::to_string(&CommentScope::Range).unwrap(), "\"range\"");
        assert_eq!(serde_json::to_string(&Side::New).unwrap(), "\"new\"");
    }

    #[test]
    fn walkthrough_absent_defaults_none_and_round_trips() {
        use crate::walkthrough::model::{CachedWalkthrough, Walkthrough};
        // Legacy review JSON without `walkthrough` must load (→ None).
        let json = r#"{"version":2,"id":"0123456789abcdef","target":{"repoPath":"/r","worktree":"main","mode":"all-changes"},"snapshot":{"baseOid":"b","capturedAt":"t"},"comments":[],"viewed":[],"createdAt":"t","lastOpenedAt":"t"}"#;
        let r: Review = serde_json::from_str(json).unwrap();
        assert!(r.walkthrough.is_none());
        // When present it round-trips under camelCase.
        let mut r2 = r.clone();
        r2.walkthrough = Some(CachedWalkthrough {
            walkthrough: Walkthrough { version: 1, title: "t".into(), summary: "s".into(), groups: vec![], ignored: vec![], degraded: false },
            diff_sig: "sig".into(),
            generated_at: "t".into(),
        });
        let out = serde_json::to_string(&r2).unwrap();
        assert!(out.contains("\"diffSig\":\"sig\""));
        let back: Review = serde_json::from_str(&out).unwrap();
        assert!(back.walkthrough.is_some());
    }

    #[test]
    fn comment_resolved_defaults_false_and_serializes() {
        // Legacy JSON without `resolved` must deserialize (→ false).
        let json = r#"{"id":"c","scope":"line","body":"b","stale":false,"createdAt":"t","updatedAt":"t"}"#;
        let c: Comment = serde_json::from_str(json).unwrap();
        assert!(!c.resolved);
        // And it is always written back out.
        let out = serde_json::to_string(&c).unwrap();
        assert!(out.contains("\"resolved\":false"));
    }
}
