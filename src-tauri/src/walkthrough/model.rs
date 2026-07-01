// AI-guidance ("Guide") walkthrough — the structured reading guide produced from a
// diff by the local `claude` CLI. Mirrors `src/types.ts` (camelCase over the wire).
// Orientation + lightweight risk flags, not a critique. (#guide)
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WalkImportance {
    Core,
    Supporting,
    Skim,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskSeverity {
    Watch,
    Caution,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkRisk {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub severity: RiskSeverity,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkGroup {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub order: u32,
    pub importance: WalkImportance,
    #[serde(default)]
    pub files: Vec<WalkFile>,
    #[serde(default)]
    pub risks: Vec<WalkRisk>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredFile {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Walkthrough {
    pub version: u32,
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub groups: Vec<WalkGroup>,
    #[serde(default)]
    pub ignored: Vec<IgnoredFile>,
    #[serde(default)]
    pub degraded: bool,
}

/// A walkthrough cached on the review, tagged with the diff signature it was
/// generated against so staleness is a cheap comparison. (#guide)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedWalkthrough {
    pub walkthrough: Walkthrough,
    pub diff_sig: String,
    pub generated_at: String,
}

/// Presence of the local `claude` CLI — pre-flight gate for the walkthrough button.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub installed: bool,
    pub path: Option<String>,
}

/// Typed failure surface for generation; `Display` is what the UI shows.
/// `Unparseable`/`QualityViolation` collapse to one user message — both mean the
/// model failed to produce a usable walkthrough after the repair retry.
#[derive(Debug)]
pub enum WalkthroughError {
    NotInstalled,
    Git(String),
    Spawn(String),
    Timeout,
    Exit { code: Option<i32>, stderr: String },
    Unparseable(String),
    QualityViolation(String),
    Cancelled,
    TooSmall,
}

impl std::fmt::Display for WalkthroughError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WalkthroughError::NotInstalled => write!(f, "Claude Code CLI not found."),
            WalkthroughError::Git(e) => write!(f, "{e}"),
            WalkthroughError::Spawn(e) => write!(f, "Couldn't start Claude: {e}"),
            WalkthroughError::Timeout => write!(f, "Walkthrough timed out."),
            WalkthroughError::Exit { stderr, .. } => {
                let msg = stderr.trim();
                if msg.is_empty() {
                    write!(f, "Claude exited with an error.")
                } else {
                    write!(f, "{msg}")
                }
            }
            WalkthroughError::Unparseable(_) | WalkthroughError::QualityViolation(_) => {
                write!(f, "Couldn't build a good walkthrough — try again.")
            }
            WalkthroughError::Cancelled => write!(f, "Cancelled."),
            WalkthroughError::TooSmall => write!(f, "This change is too small for a walkthrough."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walkthrough_round_trips_camel_case() {
        let w = Walkthrough {
            version: 1,
            title: "T".into(),
            summary: "S".into(),
            groups: vec![WalkGroup {
                id: "g".into(),
                title: "G".into(),
                summary: "s".into(),
                order: 1,
                importance: WalkImportance::Core,
                files: vec![WalkFile { path: "a.ts".into(), note: Some("n".into()), collapsed: false }],
                risks: vec![WalkRisk { path: "a.ts".into(), line: Some(5), severity: RiskSeverity::Caution, note: "look".into() }],
            }],
            ignored: vec![IgnoredFile { path: "lock".into(), reason: "lockfile".into() }],
            degraded: false,
        };
        let json = serde_json::to_string(&w).unwrap();
        assert!(json.contains("\"importance\":\"core\""));
        assert!(json.contains("\"severity\":\"caution\""));
        let back: Walkthrough = serde_json::from_str(&json).unwrap();
        assert_eq!(back.groups[0].files[0].path, "a.ts");
        assert_eq!(back.groups[0].risks[0].line, Some(5));
    }

    #[test]
    fn degraded_and_collapsed_default_when_absent() {
        let json = r#"{"version":1,"title":"t","summary":"s","groups":[{"id":"g","title":"G","summary":"s","order":1,"importance":"skim","files":[{"path":"a.ts"}]}],"ignored":[]}"#;
        let w: Walkthrough = serde_json::from_str(json).unwrap();
        assert!(!w.degraded);
        assert!(!w.groups[0].files[0].collapsed);
        assert!(w.groups[0].risks.is_empty());
    }

    #[test]
    fn cached_walkthrough_serializes_camel_case() {
        let c = CachedWalkthrough {
            walkthrough: Walkthrough { version: 1, title: "t".into(), summary: "s".into(), groups: vec![], ignored: vec![], degraded: true },
            diff_sig: "abc".into(),
            generated_at: "2026-07-01T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"diffSig\":\"abc\""));
        assert!(json.contains("\"generatedAt\""));
    }
}
