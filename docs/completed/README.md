# Completed implementation plans (`docs/completed/`)

Historical record of implementation plans whose work has shipped end-to-end. Kept here so future contributors can read the original rationale and design decisions without having to read git history.

For plans with outstanding work, see `docs/todo/`.

## Plans

- [`production-readiness-plan.md`](production-readiness-plan.md) — the cycle-spanning production-readiness plan that drove the 16-item `dhk` release-blocker tree. Fully drained by PRs #157 through #190 in the v2.0.0 release.
- [`IMS_Codex_Production_Readiness_Blockers.md`](IMS_Codex_Production_Readiness_Blockers.md) — the original codex implementation plan for the release blockers (the source the production-readiness plan was synthesised from).
- [`IMS_Codex_Implementation_Plan.md`](IMS_Codex_Implementation_Plan.md) — top-level codex implementation plan covering the wider IMS rollout. Marked historical; superseded by the post-2.0.0 plans in `docs/todo/`.
- [`IMS_Codex_Followup_Implementation_Plan.md`](IMS_Codex_Followup_Implementation_Plan.md) — codex follow-up implementation plan tracking the bd review-followup work. Closed when the bd backlog reached zero open issues at v2.0.0.
- [`workflow-audit-remediation-plan.md`](workflow-audit-remediation-plan.md) — sequenced fix plan for the 2026-06-12 six-domain business-workflow audit (5 critical, 9 high, ~12 medium findings). Epic `onetwo3d-ims-r3xh` closed 2026-06-13 after all children shipped across Waves 1–4.
- [`connector-groundwork-plan.md`](connector-groundwork-plan.md) — groundwork to run multiple shopping connectors in parallel. Delivered by epic `onetwo3d-ims-b8i6` (connector-agnostic shopping, PR #360): shopping registry, connector-scoped link tables, and Shopify/QuickBooks skeletons.
- [`unified-fx-rates-plan.md`](unified-fx-rates-plan.md) — make IMS the single source of truth for FX rates across WooCommerce and Xero. All 5 phases shipped (Xero rate stamping, WC `pushFxRatesToWc`, admin UI, Phase-5 health/probe tooling).
- [`unified-fx-rates-cutover.md`](unified-fx-rates-cutover.md) — Phase 5 production cutover runbook for the unified FX-rates rollout. Supporting code (`probeFxHelperPlugin`, `getFxHealth`) shipped; operational guide retained for reference.
