### docs-required check: stricter markers, reverts, push fallback and local runs (tooling)
- In CI a head that is an ancestor of the base (a backwards force push) fails as an empty range; a push whose before SHA is not in the clone compares `HEAD^` with a warning.
- `Docs: none` is a marker only when a separator or the end of the line follows it; a reason needs three words and no run of one repeated character; only a fragment the change adds counts. `Docs: none — revert of #N`, and a range of git reverts only, are accepted.
- A local run includes uncommitted and untracked files, and skips with a warning on a missing base or a shallow clone; a `*.md` file under a behaviour path counts as behaviour unless it is a `README.md` or under a `docs/` directory.
