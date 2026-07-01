// Claude invocation + output handling: pull the JSON out of the CLI envelope, parse
// it, and enforce the quality invariants (spec §5b) that the prompt can only request.
// A violation feeds the one-shot repair loop; a second miss is a hard failure.
// (#guide)
use crate::walkthrough::model::{Walkthrough, WalkImportance, WalkthroughError};
use crate::walkthrough::ChildRegistry;
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Default model alias — a fast, capable tier for orientation. Tracks "latest" via
/// the alias rather than a pinned id; configurable here.
pub const WALKTHROUGH_MODEL: &str = "sonnet";

/// Default reasoning effort. `high` is ample for bounded orientation; the CLI's own
/// default (`xhigh`) is overkill and the main driver of slow runs. Override per-run
/// with `DELTA_WALKTHROUGH_EFFORT`.
pub const WALKTHROUGH_EFFORT: &str = "high";

/// Built-in tools to deny: the task is pure text → JSON, no tool use, fully
/// deterministic. (Belt-and-suspenders alongside `--safe-mode`.)
const DISALLOWED_TOOLS: &str = "Bash Edit Write Read Glob Grep WebFetch WebSearch NotebookEdit Task";

/// Default wall-clock budget before the child is killed.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(90);

/// Effort levels the `claude` CLI accepts; an env override is validated against this.
const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Verbose invocation logging gate (`DELTA_WALKTHROUGH_DEBUG=1`). Logs the exact
/// argv, dumps stdin + system prompt to temp files, and prints a repro command.
fn debug_enabled() -> bool {
    std::env::var_os("DELTA_WALKTHROUGH_DEBUG").is_some_and(|v| !v.is_empty())
}

/// Per-run timeout, overridable via `DELTA_WALKTHROUGH_TIMEOUT_SECS` so you can tell
/// "wedged" from "just slow" without recompiling.
fn resolve_timeout() -> Duration {
    std::env::var("DELTA_WALKTHROUGH_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|&n| n > 0)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_TIMEOUT)
}

/// Optional effort override (`DELTA_WALKTHROUGH_EFFORT=low|medium|high|xhigh|max`).
/// Unset → the CLI default (`xhigh` in Claude Code). A live lever for tuning latency
/// while debugging timeouts.
fn effort_override() -> Option<String> {
    std::env::var("DELTA_WALKTHROUGH_EFFORT")
        .ok()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| EFFORT_LEVELS.contains(&s.as_str()))
}

/// Hard ceiling on reading groups — kills the over-fragmented case (the floor of 2
/// kills the one-step case).
pub const MAX_GROUPS: usize = 7;

// Length bounds in chars. The prompt asks for tighter word counts; these machine
// checks catch the egregious (empty / runaway) and route to the repair retry.
const TITLE_MIN: usize = 3;
const TITLE_MAX: usize = 80;
const SUMMARY_MIN: usize = 5;
const SUMMARY_MAX: usize = 500;
const GTITLE_MIN: usize = 2;
const GTITLE_MAX: usize = 60;
const GSUMMARY_MIN: usize = 3;
const GSUMMARY_MAX: usize = 350;
const NOTE_MAX: usize = 120;
const RISK_MIN: usize = 1;
const RISK_MAX: usize = 240;

fn qv(msg: impl Into<String>) -> WalkthroughError {
    WalkthroughError::QualityViolation(msg.into())
}

fn trim_in_place(s: &mut String) {
    let t = s.trim();
    if t.len() != s.len() {
        *s = t.to_string();
    }
}

fn len_problem(what: &str, n: usize, min: usize, max: usize) -> Option<String> {
    if n < min {
        Some(format!("{what} is too short ({n} chars)"))
    } else if n > max {
        Some(format!("{what} is too long ({n} chars)"))
    } else {
        None
    }
}

/// Debug-only: persist a model output for inspection when it's rejected.
fn dump_output(tag: &str, json: &str) {
    let path = std::env::temp_dir().join(format!("delta-walkthrough-{tag}.json"));
    let _ = std::fs::write(&path, json);
    eprintln!("[delta/walkthrough] {tag} model output ({} bytes) -> {}", json.len(), path.display());
}

/// Strip a `--output-format json` envelope down to the model's JSON object. Tolerates
/// the raw result already being the JSON, code fences, and surrounding prose.
pub fn extract_result_json(envelope: &str) -> Result<String, WalkthroughError> {
    let result_text = match serde_json::from_str::<serde_json::Value>(envelope) {
        Ok(serde_json::Value::Object(map)) => match map.get("result").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => envelope.to_string(),
        },
        _ => envelope.to_string(),
    };
    let cleaned = clean_json(&result_text);
    if cleaned.is_empty() {
        return Err(WalkthroughError::Unparseable("empty result from claude".into()));
    }
    Ok(cleaned)
}

/// Remove markdown fences and any prose around the JSON object.
fn clean_json(s: &str) -> String {
    let mut t = s.trim();
    if let Some(rest) = t.strip_prefix("```json") {
        t = rest.trim_start();
    } else if let Some(rest) = t.strip_prefix("```") {
        t = rest.trim_start();
    }
    if let Some(rest) = t.strip_suffix("```") {
        t = rest.trim_end();
    }
    let t = t.trim();
    if !t.starts_with('{') {
        if let (Some(i), Some(j)) = (t.find('{'), t.rfind('}')) {
            if j > i {
                return t[i..=j].to_string();
            }
        }
    }
    t.to_string()
}

/// Parse the (cleaned) JSON into a `Walkthrough` and enforce the quality invariants.
pub fn parse_and_validate(
    json: &str,
    diff_paths: &HashSet<String>,
) -> Result<Walkthrough, WalkthroughError> {
    let mut w: Walkthrough =
        serde_json::from_str(json).map_err(|e| WalkthroughError::Unparseable(e.to_string()))?;
    enforce_invariants(&mut w, diff_paths)?;
    Ok(w)
}

/// Auto-fix what's safe (trim, drop hallucinated paths, dedup files across groups,
/// resolve grouped-vs-ignored conflicts, renumber order) and collect the remaining
/// structural breaches (group count, empty group, all-skim, length).
///
/// Coverage is intentionally NOT required: on a large diff the model won't enumerate
/// every path, and the frontend renders any unplaced file after the grouped ones
/// (never hidden). We report ALL problems at once so the single repair retry can fix
/// them together instead of one-at-a-time. (#guide)
pub fn enforce_invariants(
    w: &mut Walkthrough,
    diff_paths: &HashSet<String>,
) -> Result<(), WalkthroughError> {
    w.version = 1;

    // Trim; drop references to paths that aren't in the diff (hallucinations).
    trim_in_place(&mut w.title);
    trim_in_place(&mut w.summary);
    for i in &mut w.ignored {
        trim_in_place(&mut i.path);
        trim_in_place(&mut i.reason);
    }
    w.ignored.retain(|i| diff_paths.contains(&i.path));

    // Keep only in-diff files, and only the first time a path appears — this both
    // prunes hallucinations and dedups a file the model placed in two groups.
    let mut grouped: HashSet<String> = HashSet::new();
    for g in &mut w.groups {
        trim_in_place(&mut g.id);
        trim_in_place(&mut g.title);
        trim_in_place(&mut g.summary);
        for f in &mut g.files {
            trim_in_place(&mut f.path);
            if let Some(note) = &mut f.note {
                trim_in_place(note);
            }
        }
        g.files.retain(|f| diff_paths.contains(&f.path) && grouped.insert(f.path.clone()));
        for r in &mut g.risks {
            trim_in_place(&mut r.path);
            trim_in_place(&mut r.note);
        }
        g.risks.retain(|r| diff_paths.contains(&r.path));
    }
    // A file can't be both grouped and ignored — grouping wins.
    w.ignored.retain(|i| !grouped.contains(&i.path));

    // Reading order: honor the model's intent, then normalize to a 1..N permutation.
    w.groups.sort_by_key(|g| g.order);
    for (i, g) in w.groups.iter_mut().enumerate() {
        g.order = (i as u32) + 1;
    }

    let mut problems: Vec<String> = Vec::new();

    let n = w.groups.len();
    if n < 2 {
        problems.push(format!("need at least 2 reading groups, got {n}"));
    } else if n > MAX_GROUPS {
        problems.push(format!("too many groups ({n} > {MAX_GROUPS}); merge related ones"));
    }
    for g in &w.groups {
        if g.files.is_empty() {
            problems.push(format!("group '{}' lists no files that are in the diff", g.id));
        }
    }
    if !w.groups.is_empty() && w.groups.iter().all(|g| matches!(g.importance, WalkImportance::Skim)) {
        problems.push("every group is 'skim'; mark the substantive work core/supporting".into());
    }

    // Length calibration.
    if let Some(p) = len_problem("title", w.title.chars().count(), TITLE_MIN, TITLE_MAX) {
        problems.push(p);
    }
    if let Some(p) = len_problem("summary", w.summary.chars().count(), SUMMARY_MIN, SUMMARY_MAX) {
        problems.push(p);
    }
    for g in &w.groups {
        if let Some(p) = len_problem(&format!("group '{}' title", g.id), g.title.chars().count(), GTITLE_MIN, GTITLE_MAX) {
            problems.push(p);
        }
        if let Some(p) = len_problem(&format!("group '{}' summary", g.id), g.summary.chars().count(), GSUMMARY_MIN, GSUMMARY_MAX) {
            problems.push(p);
        }
        for f in &g.files {
            if let Some(note) = &f.note {
                if note.chars().count() > NOTE_MAX {
                    problems.push(format!("file note for {} too long ({} chars)", f.path, note.chars().count()));
                }
            }
        }
        for r in &g.risks {
            if let Some(p) = len_problem(&format!("risk note for {}", r.path), r.note.chars().count(), RISK_MIN, RISK_MAX) {
                problems.push(p);
            }
        }
    }

    if problems.is_empty() {
        return Ok(());
    }
    // Cap the note so a pathological output doesn't produce a giant repair prompt.
    let shown = problems.len().min(12);
    let mut msg = problems[..shown].join("; ");
    if problems.len() > shown {
        msg.push_str(&format!("; (+{} more)", problems.len() - shown));
    }
    Err(qv(msg))
}

/// Runs `claude` and returns the raw `--output-format json` envelope. Abstracted so
/// the parse/validate/repair pipeline is testable without shelling out.
pub trait ClaudeRunner {
    fn run(&self, system: &str, stdin: &str) -> Result<String, WalkthroughError>;
}

/// One generation attempt plus one repair retry. On `Unparseable`/`QualityViolation`,
/// re-run once with the specific failure appended to the payload; anything else
/// (spawn/exit/timeout) is not repairable and propagates immediately.
pub fn generate_with_runner(
    runner: &dyn ClaudeRunner,
    system: &str,
    payload: &str,
    diff_paths: &HashSet<String>,
) -> Result<Walkthrough, WalkthroughError> {
    let debug = debug_enabled();

    let envelope = runner.run(system, payload)?;
    let json = extract_result_json(&envelope);
    if debug {
        if let Ok(j) = &json {
            dump_output("attempt1", j);
        }
    }
    let detail = match json.and_then(|j| parse_and_validate(&j, diff_paths)) {
        Ok(w) => return Ok(w),
        Err(WalkthroughError::Unparseable(s)) | Err(WalkthroughError::QualityViolation(s)) => {
            if debug {
                eprintln!("[delta/walkthrough] attempt 1 rejected: {s}");
            }
            s
        }
        Err(other) => return Err(other),
    };
    // Repair retry: tell the model exactly what was wrong.
    let repaired = format!("{payload}{}", crate::walkthrough::prompt::repair_note(&detail));
    let envelope = runner.run(system, &repaired)?;
    let json = extract_result_json(&envelope)?;
    if debug {
        dump_output("attempt2", &json);
    }
    let result = parse_and_validate(&json, diff_paths);
    if debug {
        if let Err(e) = &result {
            eprintln!("[delta/walkthrough] repair rejected: {e:?}");
        }
    }
    result
}

/// The isolated, headless `claude` invocation. `--safe-mode` firewalls all
/// customizations (hooks/MCP/skills/plugins/global+project CLAUDE.md); we inject the
/// repo's CLAUDE.md/docs ourselves via stdin. Auth stays on keychain/OAuth, so the
/// run bills the user's Claude plan. (#guide)
pub fn claude_argv(system: &str) -> Vec<String> {
    let mut argv = vec![
        "-p".into(),
        "--safe-mode".into(),
        "--output-format".into(),
        "json".into(),
        "--model".into(),
        WALKTHROUGH_MODEL.into(),
        "--disallowedTools".into(),
        DISALLOWED_TOOLS.into(),
        "--append-system-prompt".into(),
        system.into(),
    ];
    // Pin effort to `high` (the CLI default `xhigh` is overkill here and the main cause
    // of slow runs); a valid `DELTA_WALKTHROUGH_EFFORT` override wins.
    argv.push("--effort".into());
    argv.push(effort_override().unwrap_or_else(|| WALKTHROUGH_EFFORT.to_string()));
    argv
}

/// Real runner: spawns `claude`, feeds the payload on stdin, waits with a timeout,
/// and registers its PID so a cancel can kill it. Distinguishes timeout, external
/// cancel (signal-terminated), and a non-zero exit.
pub struct RealClaude {
    pub path: PathBuf,
    pub timeout: Duration,
    pub registry: ChildRegistry,
    pub review_id: String,
}

impl RealClaude {
    pub fn new(path: PathBuf, registry: ChildRegistry, review_id: String) -> Self {
        RealClaude { path, timeout: resolve_timeout(), registry, review_id }
    }

    /// Dump the exact argv + stdin + system prompt to temp files and print a
    /// ready-to-run reproduction command. Gated on `DELTA_WALKTHROUGH_DEBUG`. (#guide)
    fn log_invocation(&self, argv: &[String], system: &str, stdin: &str) {
        let dir = std::env::temp_dir();
        let base = format!("delta-walkthrough-{}", self.review_id);
        let stdin_path = dir.join(format!("{base}.stdin.txt"));
        let sys_path = dir.join(format!("{base}.system.txt"));
        let _ = std::fs::write(&stdin_path, stdin);
        let _ = std::fs::write(&sys_path, system);
        // Elide the giant system-prompt arg so the argv line stays readable.
        let pretty: Vec<String> = argv
            .iter()
            .map(|a| {
                if a == system {
                    "<system-prompt>".into()
                } else if a.contains(' ') {
                    format!("'{a}'")
                } else {
                    a.clone()
                }
            })
            .collect();
        eprintln!("[delta/walkthrough] claude  = {}", self.path.display());
        eprintln!("[delta/walkthrough] cwd     = {:?}", std::env::current_dir().ok());
        eprintln!("[delta/walkthrough] timeout = {}s", self.timeout.as_secs());
        eprintln!("[delta/walkthrough] argv    = {}", pretty.join(" "));
        eprintln!("[delta/walkthrough] stdin   = {} bytes -> {}", stdin.len(), stdin_path.display());
        eprintln!("[delta/walkthrough] system  = {} bytes -> {}", system.len(), sys_path.display());
        eprintln!(
            "[delta/walkthrough] reproduce (streams progress + debug):\n  cat '{}' | '{}' -p --safe-mode --output-format stream-json --include-partial-messages --verbose --model {} --disallowedTools '{}' --append-system-prompt \"$(cat '{}')\" --debug",
            stdin_path.display(),
            self.path.display(),
            WALKTHROUGH_MODEL,
            DISALLOWED_TOOLS,
            sys_path.display(),
        );
    }
}

impl ClaudeRunner for RealClaude {
    fn run(&self, system: &str, stdin: &str) -> Result<String, WalkthroughError> {
        let debug = debug_enabled();
        let start = debug.then(Instant::now);
        let argv = claude_argv(system);
        if debug {
            self.log_invocation(&argv, system, stdin);
        }

        let mut child = Command::new(&self.path)
            .args(&argv)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| WalkthroughError::Spawn(e.to_string()))?;

        let pid = child.id();
        self.registry.register(&self.review_id, pid);

        // Feed stdin off-thread so a large payload can't deadlock against a full pipe.
        if let Some(mut si) = child.stdin.take() {
            let payload = stdin.to_string();
            std::thread::spawn(move || {
                let _ = si.write_all(payload.as_bytes());
            });
        }

        // Wait off-thread; the main thread enforces the timeout via recv_timeout.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });

        let result = match rx.recv_timeout(self.timeout) {
            Ok(Ok(output)) => {
                if debug && !output.stderr.is_empty() {
                    eprintln!("[delta/walkthrough] claude stderr:\n{}", String::from_utf8_lossy(&output.stderr));
                }
                if output.status.success() {
                    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
                } else if output.status.code().is_none() {
                    // terminated by signal before our timeout → an external cancel
                    Err(WalkthroughError::Cancelled)
                } else {
                    Err(WalkthroughError::Exit {
                        code: output.status.code(),
                        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                    })
                }
            }
            Ok(Err(e)) => Err(WalkthroughError::Spawn(e.to_string())),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                crate::walkthrough::kill_pid(pid);
                Err(WalkthroughError::Timeout)
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err(WalkthroughError::Spawn("claude worker disconnected".into()))
            }
        };
        self.registry.remove(&self.review_id, pid);

        if let Some(start) = start {
            let secs = start.elapsed().as_secs_f32();
            match &result {
                Ok(out) => eprintln!("[delta/walkthrough] completed in {secs:.1}s ({} bytes stdout)", out.len()),
                Err(e) => eprintln!("[delta/walkthrough] failed in {secs:.1}s: {e:?}"),
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::walkthrough::model::*;

    fn paths(ps: &[&str]) -> HashSet<String> {
        ps.iter().map(|s| s.to_string()).collect()
    }
    fn grp(id: &str, files: &[&str], imp: WalkImportance) -> WalkGroup {
        WalkGroup {
            id: id.into(),
            title: "Two words".into(),
            summary: "A short summary.".into(),
            order: 1,
            importance: imp,
            files: files
                .iter()
                .map(|p| WalkFile { path: p.to_string(), note: None, collapsed: false })
                .collect(),
            risks: vec![],
        }
    }
    fn wt(groups: Vec<WalkGroup>) -> Walkthrough {
        Walkthrough {
            version: 1,
            title: "A fine title here".into(),
            summary: "What and why.".into(),
            groups,
            ignored: vec![],
            degraded: false,
        }
    }

    #[test]
    fn rejects_single_group() {
        let mut w = wt(vec![grp("g1", &["a.ts"], WalkImportance::Core)]);
        assert!(matches!(enforce_invariants(&mut w, &paths(&["a.ts"])), Err(WalkthroughError::QualityViolation(_))));
    }

    #[test]
    fn rejects_over_max_groups() {
        let groups = (0..MAX_GROUPS + 1).map(|i| grp(&format!("g{i}"), &["a.ts"], WalkImportance::Skim)).collect();
        let mut w = wt(groups);
        assert!(matches!(enforce_invariants(&mut w, &paths(&["a.ts"])), Err(WalkthroughError::QualityViolation(_))));
    }

    #[test]
    fn tolerates_uncovered_files() {
        // c.ts is placed in no group — the frontend renders it after the grouped files,
        // so an incomplete-but-valid walkthrough must NOT be rejected (large-diff case).
        let mut w = wt(vec![grp("g1", &["a.ts"], WalkImportance::Core), grp("g2", &["b.ts"], WalkImportance::Skim)]);
        assert!(enforce_invariants(&mut w, &paths(&["a.ts", "b.ts", "c.ts"])).is_ok());
    }

    #[test]
    fn dedups_files_across_groups_and_resolves_ignored_conflict() {
        // b.ts appears in two groups; a.ts is both grouped and ignored.
        let mut w = wt(vec![grp("g1", &["a.ts", "b.ts"], WalkImportance::Core), grp("g2", &["b.ts", "c.ts"], WalkImportance::Skim)]);
        w.ignored.push(IgnoredFile { path: "a.ts".into(), reason: "noise".into() });
        enforce_invariants(&mut w, &paths(&["a.ts", "b.ts", "c.ts"])).unwrap();
        // b.ts kept only in the first group; g2 keeps its unique c.ts.
        assert_eq!(w.groups.iter().flat_map(|g| &g.files).filter(|f| f.path == "b.ts").count(), 1);
        assert!(w.groups[0].files.iter().any(|f| f.path == "b.ts"));
        assert!(w.groups[1].files.iter().all(|f| f.path != "b.ts"));
        // a.ts is grouped, so it's dropped from ignored.
        assert!(w.ignored.iter().all(|i| i.path != "a.ts"));
    }

    #[test]
    fn rejects_all_skim() {
        let mut w = wt(vec![grp("g1", &["a.ts"], WalkImportance::Skim), grp("g2", &["b.ts"], WalkImportance::Skim)]);
        assert!(matches!(enforce_invariants(&mut w, &paths(&["a.ts", "b.ts"])), Err(WalkthroughError::QualityViolation(_))));
    }

    #[test]
    fn rejects_empty_group_after_pruning_hallucinated_files() {
        let mut w = wt(vec![grp("g1", &["a.ts"], WalkImportance::Core), grp("g2", &["ghost.ts"], WalkImportance::Skim)]);
        // ghost.ts pruned → g2 empty → violation
        assert!(matches!(enforce_invariants(&mut w, &paths(&["a.ts"])), Err(WalkthroughError::QualityViolation(_))));
    }

    #[test]
    fn accepts_valid_and_prunes_hallucinated_risk() {
        let mut g1 = grp("g1", &["a.ts"], WalkImportance::Core);
        g1.risks.push(WalkRisk { path: "ghost.ts".into(), line: None, severity: RiskSeverity::Watch, note: "x risk".into() });
        let mut w = wt(vec![g1, grp("g2", &["b.ts"], WalkImportance::Skim)]);
        enforce_invariants(&mut w, &paths(&["a.ts", "b.ts"])).unwrap();
        assert!(w.groups[0].risks.is_empty(), "hallucinated risk pruned");
        assert_eq!(w.groups[0].order, 1);
        assert_eq!(w.groups[1].order, 2);
    }

    #[test]
    fn renumbers_order_from_model_intent() {
        let mut g1 = grp("g1", &["a.ts"], WalkImportance::Core);
        g1.order = 5;
        let mut g2 = grp("g2", &["b.ts"], WalkImportance::Skim);
        g2.order = 2;
        let mut w = wt(vec![g1, g2]);
        enforce_invariants(&mut w, &paths(&["a.ts", "b.ts"])).unwrap();
        // g2 (order 2) sorts before g1 (order 5) → g2 becomes order 1
        assert_eq!(w.groups[0].id, "g2");
        assert_eq!(w.groups[0].order, 1);
        assert_eq!(w.groups[1].order, 2);
    }

    #[test]
    fn extracts_result_from_envelope_and_fences() {
        let env = r#"{"type":"result","result":"```json\n{\"version\":1}\n```","is_error":false}"#;
        assert_eq!(extract_result_json(env).unwrap().trim(), "{\"version\":1}");
    }

    #[test]
    fn extracts_when_result_is_raw_object() {
        let env = r#"{"version":1,"title":"t"}"#;
        assert_eq!(extract_result_json(env).unwrap(), env);
    }

    struct Fake {
        outs: std::cell::RefCell<Vec<String>>,
    }
    impl ClaudeRunner for Fake {
        fn run(&self, _system: &str, _stdin: &str) -> Result<String, WalkthroughError> {
            Ok(self.outs.borrow_mut().remove(0))
        }
    }
    fn envelope(result_json: &str) -> String {
        serde_json::json!({"type":"result","result": result_json,"is_error":false}).to_string()
    }
    const GOOD: &str = r#"{"version":1,"title":"A good clear title","summary":"What changed and why.","groups":[
        {"id":"g1","title":"Group one","summary":"Short summary.","order":1,"importance":"core","files":[{"path":"a.ts"}],"risks":[]},
        {"id":"g2","title":"Group two","summary":"Short summary.","order":2,"importance":"skim","files":[{"path":"b.ts"}],"risks":[]}],"ignored":[]}"#;

    #[test]
    fn repairs_after_one_bad_then_good() {
        let f = Fake { outs: std::cell::RefCell::new(vec![envelope("not json at all"), envelope(GOOD)]) };
        let w = generate_with_runner(&f, "sys", "payload", &paths(&["a.ts", "b.ts"])).unwrap();
        assert_eq!(w.groups.len(), 2);
        assert!(f.outs.borrow().is_empty(), "both attempts consumed");
    }

    #[test]
    fn fails_after_second_bad() {
        let f = Fake { outs: std::cell::RefCell::new(vec![envelope("nope"), envelope("still nope")]) };
        assert!(generate_with_runner(&f, "s", "p", &paths(&[])).is_err());
    }

    #[test]
    fn quality_violation_triggers_repair_then_succeeds() {
        // First a single-group (quality violation), then the good two-group result.
        let one_group = r#"{"version":1,"title":"One group only","summary":"Just one.","groups":[
            {"id":"g1","title":"Only group","summary":"Short summary.","order":1,"importance":"core","files":[{"path":"a.ts"},{"path":"b.ts"}],"risks":[]}],"ignored":[]}"#;
        let f = Fake { outs: std::cell::RefCell::new(vec![envelope(one_group), envelope(GOOD)]) };
        let w = generate_with_runner(&f, "s", "p", &paths(&["a.ts", "b.ts"])).unwrap();
        assert_eq!(w.groups.len(), 2);
    }

    #[test]
    fn argv_is_isolated_and_json() {
        let a = claude_argv("SYS");
        assert!(a.contains(&"-p".to_string()));
        assert!(a.contains(&"--safe-mode".to_string()), "must isolate via safe-mode");
        assert!(a.contains(&"--disallowedTools".to_string()), "no tool use");
        let oi = a.iter().position(|x| x == "--output-format").unwrap();
        assert_eq!(a[oi + 1], "json");
        let si = a.iter().position(|x| x == "--append-system-prompt").unwrap();
        assert_eq!(a[si + 1], "SYS");
        let ei = a.iter().position(|x| x == "--effort").expect("effort is pinned");
        assert!(EFFORT_LEVELS.contains(&a[ei + 1].as_str()), "valid effort level, got {}", a[ei + 1]);
    }
}
