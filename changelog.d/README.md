# Changelog fragments

Each PR records its changelog entry here, as its own file. It does **not** edit `CHANGELOG.md`. One file per PR means two open PRs never conflict on the changelog.

- **Name:** after the branch, e.g. `fix-p1-woo-sync-batch.md`. Any unique name works.
- **Content:** exactly what would have gone under `## Unreleased` in `CHANGELOG.md`. Start with a `### Title (area)` heading, then the bullets. Do not add a `## Unreleased` line.
- **Docs opt-out:** a PR that changes behaviour-bearing code without changing `docs/` or `help-docs/` fails the `docs-required` check unless its fragment adds a line `Docs: none — <reason>` (at least 20 characters). Keep the line when the release cut moves the fragment: it records why that change had no docs. See "Documentation Updates" in `docs/development.md`.
- **Release cut:** the release PR moves every fragment into `CHANGELOG.md` under the new `## x.y.z - YYYY-MM-DD` heading, in merge order, and deletes the fragments. See "Cut a release" in `docs/development.md`.

Entries already under `## Unreleased` in `CHANGELOG.md` stay valid; the release cut takes both.
