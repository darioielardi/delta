// Claude invocation + output handling: pull the JSON out of the CLI envelope, parse
// it, and enforce the quality invariants (spec §5b) that the prompt can only request.
// A violation feeds the one-shot repair loop; a second miss is a hard failure.
// (#guide)
use crate::walkthrough::model::{Walkthrough, WalkImportance, WalkthroughError};
use std::collections::HashSet;

/// Hard ceiling on reading groups — kills the over-fragmented case (the floor of 2
/// kills the one-step case).
pub const MAX_GROUPS: usize = 7;

// Length bounds in chars. The prompt asks for tighter word counts; these machine
// checks catch the egregious (empty / runaway) and route to the repair retry.
const TITLE_MIN: usize = 3;
const TITLE_MAX: usize = 80;
const SUMMARY_MIN: usize = 5;
const SUMMARY_MAX: usize = 400;
const GTITLE_MIN: usize = 2;
const GTITLE_MAX: usize = 60;
const GSUMMARY_MIN: usize = 3;
const GSUMMARY_MAX: usize = 300;
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

fn check_len(what: &str, n: usize, min: usize, max: usize) -> Result<(), WalkthroughError> {
    if n < min {
        return Err(qv(format!("{what} is too short ({n} chars)")));
    }
    if n > max {
        return Err(qv(format!("{what} is too long ({n} chars)")));
    }
    Ok(())
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

/// Auto-fix what's safe (trim, drop hallucinated paths, renumber order) and hard-fail
/// on structural breaches (group count, coverage, empty group, all-skim, length).
pub fn enforce_invariants(
    w: &mut Walkthrough,
    diff_paths: &HashSet<String>,
) -> Result<(), WalkthroughError> {
    w.version = 1;

    // Trim everything; drop references to paths that aren't in the diff (hallucinations).
    trim_in_place(&mut w.title);
    trim_in_place(&mut w.summary);
    for i in &mut w.ignored {
        trim_in_place(&mut i.path);
        trim_in_place(&mut i.reason);
    }
    w.ignored.retain(|i| diff_paths.contains(&i.path));
    for g in &mut w.groups {
        trim_in_place(&mut g.id);
        trim_in_place(&mut g.title);
        trim_in_place(&mut g.summary);
        for f in &mut g.files {
            trim_in_place(&mut f.path);
            if let Some(n) = &mut f.note {
                trim_in_place(n);
            }
        }
        g.files.retain(|f| diff_paths.contains(&f.path));
        for r in &mut g.risks {
            trim_in_place(&mut r.path);
            trim_in_place(&mut r.note);
        }
        g.risks.retain(|r| diff_paths.contains(&r.path));
    }

    // Reading order: honor the model's intent, then normalize to a 1..N permutation.
    w.groups.sort_by_key(|g| g.order);
    for (i, g) in w.groups.iter_mut().enumerate() {
        g.order = (i as u32) + 1;
    }

    // Group count.
    let n = w.groups.len();
    if n < 2 {
        return Err(qv(format!("need at least 2 reading groups, got {n}")));
    }
    if n > MAX_GROUPS {
        return Err(qv(format!("too many groups ({n} > {MAX_GROUPS}); merge related ones")));
    }

    // No empty groups (e.g. all files were hallucinated).
    for g in &w.groups {
        if g.files.is_empty() {
            return Err(qv(format!("group '{}' lists no files that are in the diff", g.id)));
        }
    }

    // Balance: not every group may be skim.
    if w.groups.iter().all(|g| matches!(g.importance, WalkImportance::Skim)) {
        return Err(qv("every group is 'skim'; mark the substantive work core/supporting"));
    }

    // Coverage: each diff file in exactly one group OR ignored, never both, none missing.
    let grouped: Vec<String> = w
        .groups
        .iter()
        .flat_map(|g| g.files.iter().map(|f| f.path.clone()))
        .collect();
    let grouped_count = grouped.len();
    let grouped_set: HashSet<String> = grouped.into_iter().collect();
    if grouped_set.len() != grouped_count {
        return Err(qv("a file appears in more than one group"));
    }
    let ignored_set: HashSet<String> = w.ignored.iter().map(|i| i.path.clone()).collect();
    if grouped_set.intersection(&ignored_set).next().is_some() {
        return Err(qv("a file is both grouped and ignored"));
    }
    for p in diff_paths {
        if !grouped_set.contains(p) && !ignored_set.contains(p) {
            return Err(qv(format!("file not covered by any group or ignored: {p}")));
        }
    }

    // Length calibration.
    check_len("title", w.title.chars().count(), TITLE_MIN, TITLE_MAX)?;
    check_len("summary", w.summary.chars().count(), SUMMARY_MIN, SUMMARY_MAX)?;
    for g in &w.groups {
        check_len("group title", g.title.chars().count(), GTITLE_MIN, GTITLE_MAX)?;
        check_len("group summary", g.summary.chars().count(), GSUMMARY_MIN, GSUMMARY_MAX)?;
        for f in &g.files {
            if let Some(note) = &f.note {
                if note.chars().count() > NOTE_MAX {
                    return Err(qv(format!("file note too long ({} chars)", note.chars().count())));
                }
            }
        }
        for r in &g.risks {
            check_len("risk note", r.note.chars().count(), RISK_MIN, RISK_MAX)?;
        }
    }

    Ok(())
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
    let envelope = runner.run(system, payload)?;
    let detail = match extract_result_json(&envelope).and_then(|j| parse_and_validate(&j, diff_paths)) {
        Ok(w) => return Ok(w),
        Err(WalkthroughError::Unparseable(s)) | Err(WalkthroughError::QualityViolation(s)) => s,
        Err(other) => return Err(other),
    };
    // Repair retry: tell the model exactly what was wrong.
    let repaired = format!("{payload}{}", crate::walkthrough::prompt::repair_note(&detail));
    let envelope = runner.run(system, &repaired)?;
    let json = extract_result_json(&envelope)?;
    parse_and_validate(&json, diff_paths)
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
    fn rejects_uncovered_file() {
        let mut w = wt(vec![grp("g1", &["a.ts"], WalkImportance::Core), grp("g2", &["b.ts"], WalkImportance::Skim)]);
        assert!(matches!(enforce_invariants(&mut w, &paths(&["a.ts", "b.ts", "c.ts"])), Err(WalkthroughError::QualityViolation(_))));
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
}
