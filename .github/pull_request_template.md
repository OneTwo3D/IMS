## Summary

- What changed:
- Why it changed:
- How it was validated:

## Checklist

- [ ] If `prisma/migrations/` changed, `prisma/schema.prisma` was updated in the same PR to match the real database shape.
- [ ] I ran the schema drift workflow locally or in CI against a migrated database.
- [ ] Any hand-written migration SQL was reviewed explicitly, and I documented what changed in `prisma/schema.prisma` to match it.
- [ ] Any intentionally unsupported database feature was isolated in a dedicated manual migration and recorded in `prisma/unsupported-schema-drift-allowlist.json`.
- [ ] I did not bypass schema validation in deployment scripts to make drift invisible.

### Documentation (mandatory; the `docs-required` check enforces it)

- [ ] I updated every doc this change makes stale in this PR: `docs/**` (developer, operator, architecture, runbooks, `.env.example`) and `help-docs/**` for user-facing screens, labels and actions. Flagged-off features are documented as built and switched off.
- [ ] Where a doc disagreed with the code, I fixed the doc (code is the source of truth), or filed a bead where the code looks wrong.
- [ ] OR this PR needs no docs, and its `changelog.d` fragment has a line `Docs: none — <reason>` (20+ characters; the check prints it).
