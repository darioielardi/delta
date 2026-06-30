// AI-guidance walkthrough backend: compute the diff, assemble a controlled stdin
// payload (bounded patch + self-read repo CLAUDE.md/docs), shell out to the local
// `claude` CLI under `--safe-mode`, then validate the JSON against the quality
// invariants. Results are cached on the review by diff signature. (#guide)
pub mod context;
pub mod model;
