use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffMode {
    AllChanges,
    Uncommitted,
    LastCommit,
    BranchVsBase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub repo_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub mode: DiffMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

impl DiffMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            DiffMode::AllChanges => "all-changes",
            DiffMode::Uncommitted => "uncommitted",
            DiffMode::LastCommit => "last-commit",
            DiffMode::BranchVsBase => "branch-vs-base",
        }
    }
}

#[cfg(test)]
mod model_tests {
    use super::*;

    #[test]
    fn diffmode_as_str_is_kebab() {
        assert_eq!(DiffMode::AllChanges.as_str(), "all-changes");
        assert_eq!(DiffMode::BranchVsBase.as_str(), "branch-vs-base");
    }

    #[test]
    fn target_worktree_defaults_to_none_when_absent() {
        let t: Target = serde_json::from_str(r#"{"repoPath":"/r","mode":"uncommitted"}"#).unwrap();
        assert_eq!(t.worktree, None);
    }
}
