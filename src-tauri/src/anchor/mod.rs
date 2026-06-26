use sha2::{Digest, Sha256};
use similar::TextDiff;

pub const WINDOW: u32 = 50;
pub const THRESHOLD: f32 = 0.6;

pub fn diff_hash(old: &str, new: &str) -> String {
    let mut h = Sha256::new();
    h.update(old.as_bytes());
    h.update([0]);
    h.update(new.as_bytes());
    let digest = h.finalize();
    digest[..8].iter().map(|b| format!("{:02x}", b)).collect()
}

/// Character-level similarity ratio in [0,1].
/// Using `from_chars` so single-line snippets with small edits score correctly.
fn ratio(a: &str, b: &str) -> f32 {
    TextDiff::from_chars(a, b).ratio()
}

/// Re-anchor a `snippet` (1+ lines) that was last at 1-based `start_line` within `content`.
/// Returns the new (start_line, end_line) — end_line is Some only for multi-line snippets —
/// or None if nothing within ±WINDOW matches above THRESHOLD.
pub fn reanchor(start_line: u32, snippet: &str, content: &str) -> Option<(u32, Option<u32>)> {
    let lines: Vec<&str> = content.lines().collect();
    let snippet_norm: String = snippet.lines().collect::<Vec<_>>().join("\n");
    let span = snippet.lines().count().max(1);

    if lines.is_empty() {
        return None;
    }

    // Extract a block of `span` lines starting at `start_idx` (0-based), joined by "\n".
    let block_at = |start_idx: usize| -> Option<String> {
        if start_idx + span <= lines.len() {
            Some(lines[start_idx..start_idx + span].join("\n"))
        } else {
            None
        }
    };

    // Convert 0-based index back to 1-based result tuple.
    let to_result = |start_idx: usize| -> (u32, Option<u32>) {
        let start = (start_idx as u32).saturating_add(1);
        let end = if span > 1 { Some(start.saturating_add(span as u32).saturating_sub(1)) } else { None };
        (start, end)
    };

    // 1) Exact match at the recorded position.
    let orig_idx = start_line.saturating_sub(1) as usize;
    if let Some(block) = block_at(orig_idx) {
        if block == snippet_norm {
            return Some(to_result(orig_idx));
        }
    }

    // 2) Best fuzzy match within ±WINDOW, clamped to valid indices.
    let lo = (start_line.saturating_sub(WINDOW) as usize).saturating_sub(1);
    let hi = (start_line.saturating_add(WINDOW) as usize).min(lines.len());

    let mut best: Option<(f32, usize)> = None;
    for idx in lo..hi {
        if let Some(block) = block_at(idx) {
            let r = ratio(&block, &snippet_norm);
            if best.map(|(br, _)| r > br).unwrap_or(true) {
                best = Some((r, idx));
            }
        }
    }

    match best {
        Some((r, idx)) if r >= THRESHOLD => Some(to_result(idx)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTENT: &str = "fn a() {}\nlet x = 1;\nlet y = 2;\nfn b() {}\n";

    #[test]
    fn exact_match_keeps_position() {
        // "let x = 1;" is line 2 (1-based)
        assert_eq!(reanchor(2, "let x = 1;", CONTENT), Some((2, None)));
    }

    #[test]
    fn fuzzy_finds_shifted_line() {
        // snippet moved down: insert two lines before it
        let shifted = "// added\n// added2\nfn a() {}\nlet x = 1;\nlet y = 2;\n";
        // originally line 2, now line 4
        assert_eq!(reanchor(2, "let x = 1;", shifted), Some((4, None)));
    }

    #[test]
    fn fuzzy_tolerates_small_edit() {
        let edited = "fn a() {}\nlet x = 10;\nlet y = 2;\n"; // "let x = 1;" -> "let x = 10;"
        assert_eq!(reanchor(2, "let x = 1;", edited), Some((2, None)));
    }

    #[test]
    fn no_match_returns_none() {
        let gone = "totally\ndifferent\ncontent\nhere\n";
        assert_eq!(reanchor(2, "let x = 1;", gone), None);
    }

    #[test]
    fn multiline_snippet_returns_end_line() {
        // two-line snippet at lines 2-3
        assert_eq!(reanchor(2, "let x = 1;\nlet y = 2;", CONTENT), Some((2, Some(3))));
    }

    #[test]
    fn diff_hash_changes_with_content() {
        assert_ne!(diff_hash("a", "b"), diff_hash("a", "c"));
        assert_eq!(diff_hash("a", "b"), diff_hash("a", "b"));
    }
}
