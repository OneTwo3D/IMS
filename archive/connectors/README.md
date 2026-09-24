# Archived connector implementations

This directory holds connector implementations that IMS **no longer ships**. Nothing in here is
built, type-checked, linted, tested or reachable from any active code path. It exists so that the
code the owner asked to be *archived rather than deleted* is findable in the working tree by someone
who has never heard of these connectors and does not know what to `git log` for.

## What is here

| Directory | Connector | Archived | Branch | Tag pinning the last ACTIVE commit |
| --- | --- | --- | --- | --- |
| `shopify/` | Shopify (shopping) | 2026-09-24 | `o3d-remove-parked-connectors` | `archive/shopify-connector` |
| `quickbooks/` | QuickBooks Online (accounting) | 2026-09-24 | `o3d-remove-parked-connectors` | `archive/quickbooks-connector` |

A third connector, **ShipHero** (WMS), was removed earlier under a different convention — by tag and
note only, with no in-tree copy. See [`docs/archive/shiphero-connector-removal.md`](../../docs/archive/shiphero-connector-removal.md).

The per-connector notes are the ones to read first:

- [`docs/archive/shopify-connector-removal.md`](../../docs/archive/shopify-connector-removal.md)
- [`docs/archive/quickbooks-connector-removal.md`](../../docs/archive/quickbooks-connector-removal.md)

## Why: the owner's instruction, and why it is not just a git tag

> "also remove the QuickBooks, Shopify and Shiphero connectors from the active codebase (archive the
> code but remove it from active installs). but keep the generic design of the ims so it is possible
> to add later on different connectors."

ShipHero's removal established a tag-plus-note convention and argued, correctly, that git already
has everything and "archive" is only about discoverability. That argument is kept — the annotated
tags above still pin the last commit in which each connector was part of the active tree, and they
are still the way to recover the *surrounding* code (registrations, UI, tests, docs) that is not
copied here. What is added is the connector's own source, in the tree, because a tag only helps
somebody who already suspects the connector existed.

The hazard the ShipHero note warns about — "dead code behind a feature flag is not archived, it is
unmaintained: it compiles, so it survives refactors by being mechanically updated by people who
never run it" — is answered by making this directory **invisible to every tool**:

| Tool | How `archive/` is excluded | Where |
| --- | --- | --- |
| `tsc --noEmit` / `next build`'s type check | `"exclude": ["node_modules", "archive"]` | `tsconfig.json` |
| `eslint` | `globalIgnores([... "archive/**"])` | `eslint.config.mjs` |
| `next build` | Nothing under `app/`, `pages/`, `components/` or `lib/` imports it, so it is not in the module graph | — |
| `npm run test:unit` | Its glob is `tests/**/*.test.ts`; archived tests live at `archive/connectors/<name>/tests/**` | `package.json` |
| `npm run check:*` | Every guard scans an explicit root list (`app`, `lib`, `components`, `scripts`, `prisma`, `types`); `archive` is in none of them | `scripts/check-*.mjs` |

So a refactor cannot mechanically update this code, and this code cannot fail a build. If it stops
compiling against the rest of the repository, that is expected and is not a defect — it is a cost of
reviving it, stated below.

## Layout

Each connector's files sit at **their original repository paths**, under
`archive/connectors/<name>/`. For example:

```
archive/connectors/shopify/lib/connectors/shopify/index.ts   was   lib/connectors/shopify/index.ts
archive/connectors/shopify/app/(dashboard)/sync/shopify-sync-client.tsx
```

That is deliberately verbose: it makes reviving a file a mechanical `git mv` back, with no mapping
table to consult and no judgement about where anything used to live.

## Reviving one

Reviving a connector is **not** "move the directory back". These files were removed from the active
tree along with everything that *referred* to them, and that surrounding code is not here. The steps:

1. `git mv archive/connectors/<name>/<path> <path>` for each file — the paths are already correct.
2. Restore the registrations. Each per-connector note has the exact list, and
   `git show archive/<name>-connector:<file>` gives the version of each surrounding file from the
   last commit in which the connector was active.
3. Re-add the connector's id to the registries it belonged to (`SHOPPING_CONNECTORS`,
   `ACCOUNTING_CONNECTORS`, `NON_WMS_INTEGRATION_PLUGIN_IDS`, and the exclusivity group if it has a
   partner). The dispatch switches in the generic layer are exhaustive over the id union, so `tsc`
   will list every port the connector has to answer once its id is back in the union — that list is
   the work, and producing it is why the switches were kept with one arm each.
4. Re-add its env vars to `.env.example` **and** remove the matching waiver from
   `scripts/documented-env-var-allowlist.json` if one is reinstated, or the documented-env-var check
   fails on a stale entry.
5. Expect the archived code to need updating: it was frozen against the repository as it stood on
   the archive date and has not been type-checked since.

## Expected drift

No process keeps this code in step with the rest of the repository, and none should. Treat anything
in here as a snapshot of a working implementation at its archive date, not as code that works today.
