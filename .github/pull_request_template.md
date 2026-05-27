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
- [ ] I updated all affected docs/help pages/runbooks/config examples, or stated why this PR has no documentation impact.
