use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffMode {
    AllChanges,
    Uncommitted,
    LastCommit,
    BranchVsBase,
    Commit,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

impl DiffMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            DiffMode::AllChanges => "all-changes",
            DiffMode::Uncommitted => "uncommitted",
            DiffMode::LastCommit => "last-commit",
            DiffMode::BranchVsBase => "branch-vs-base",
            DiffMode::Commit => "commit",
        }
    }

    /// The CLI flag that selects this mode (inverse of `parse_launch`).
    pub fn flag(&self) -> &'static str {
        match self {
            DiffMode::AllChanges => "--all",
            DiffMode::Uncommitted => "--uncommitted",
            DiffMode::LastCommit => "--last-commit",
            DiffMode::BranchVsBase => "--branch",
            // Commit is a display overlay with no launch flag; fall back to its
            // canonical branch-vs-base mode. (The CLI never emits Commit.)
            DiffMode::Commit => "--branch",
        }
    }

    /// Parse a launch mode flag (inverse of `flag`). `None` for anything that
    /// isn't a recognized mode flag — the single source of truth shared by
    /// `parse_launch` and the CLI's unknown-option check. (No `--commit`: commit
    /// is a display overlay, never a launch mode.)
    pub fn from_flag(flag: &str) -> Option<DiffMode> {
        match flag {
            "--all" => Some(DiffMode::AllChanges),
            "--uncommitted" => Some(DiffMode::Uncommitted),
            "--last-commit" => Some(DiffMode::LastCommit),
            "--branch" => Some(DiffMode::BranchVsBase),
            _ => None,
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
    fn diffmode_flag_is_the_cli_flag() {
        assert_eq!(DiffMode::AllChanges.flag(), "--all");
        assert_eq!(DiffMode::Uncommitted.flag(), "--uncommitted");
        assert_eq!(DiffMode::LastCommit.flag(), "--last-commit");
        assert_eq!(DiffMode::BranchVsBase.flag(), "--branch");
    }

    #[test]
    fn diffmode_from_flag_round_trips_and_rejects_unknown() {
        for m in [DiffMode::AllChanges, DiffMode::Uncommitted, DiffMode::LastCommit, DiffMode::BranchVsBase] {
            assert_eq!(DiffMode::from_flag(m.flag()), Some(m));
        }
        assert_eq!(DiffMode::from_flag("--help"), None);
        assert_eq!(DiffMode::from_flag("--bogus"), None);
        // `--commit` is intentionally not a launch flag (display overlay only).
        assert_eq!(DiffMode::from_flag("--commit"), None);
    }

    #[test]
    fn target_worktree_defaults_to_none_when_absent() {
        let t: Target = serde_json::from_str(r#"{"repoPath":"/r","mode":"uncommitted"}"#).unwrap();
        assert_eq!(t.worktree, None);
    }
}
