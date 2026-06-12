# Reorder Planning — Per-Row Selection Plan

Date: 2026-06-12
Branch baseline: `development` (post v2.0.0)

## Goal

PR #190 shipped the **"Generate POs + draft MOs for visible rows"** toolbar on the Reorder Planning page. It operates on every row currently visible, scoped by the filter form (supplier, category, warehouse, product type). The honest trade-off called out in the PR was that **per-row checkboxes were deferred** because layering selection state on top of the shared `StockPositionReportPage` server component was getting messy.

This plan adds per-row checkboxes properly so the operator can:

- Generate a PO for **some** of a supplier's products instead of all of them.
- Generate a draft MO for one BOM while leaving others alone.
- Exclude a row that has open POs the operator knows about but the report doesn't yet.

## Scope

1. Extend `StockPositionReportPage` (or its underlying table primitive) to accept an optional `selectionColumn` slot. The slot renders a checkbox `<th>` and per-row `<td>` provided by the page; no opinion about WHAT selection state holds.
2. New `ReorderSelectionProvider` context exposing `{ selected, toggle, toggleAll, clear }` keyed by `productId`.
3. `ReorderActionsToolbar` (from PR #190) reads from the context:
   - Shows `n selected (p purchased, m manufactured)` instead of "n rows in current view".
   - Button label changes to "Generate from selection" with the same auto-split routing.
   - When zero are selected, behaviour falls back to the current "act on all visible" semantics with an extra confirmation modal naming the row count.
4. Checkbox column renders before the SKU column with a header-level "select all visible" tri-state.
5. Selection state survives a single pagination step (forward/back across pages stays selected) — store the set in the URL as a comma-separated `selected` param to keep state on refresh and shareability. Cap at e.g. 250 ids to avoid pathological URLs.

## Open design questions

- Should multi-page selection persist? The current page is paginated; tying selection to the URL handles 1 page cleanly but multi-page needs either localStorage or a server-side selection store. Default: **single page only**, with a clear notice that switching pages clears the selection.
- For BOM rows whose component rows are also visible, should ticking the BOM auto-tick the components? Probably not — the operator may want to manufacture but defer the components if stock exists. Independent selection is the cleaner model.

## Acceptance

- Page loads with no checkboxes selected; button is disabled with text "Select rows to generate POs / MOs (or use **All visible** below)".
- Ticking a checkbox enables the button and updates the counts.
- Tri-state "select all visible" works correctly (none → all, partial → all, all → none).
- Generating runs the same auto-split (BOM → `createReorderMOs`, others → `createReorderPOs`) over the selected subset.
- Switching filters or pagination clears selection with a one-time toast: "Selection cleared on filter change."

## Implementation phases

### Phase 1 — Selection context + checkbox column (1 PR)

- Add the optional `selectionColumn` slot to the shared report component.
- New `lib/analytics/reorder-selection-context.tsx` provider + hook.
- Wire the column on the Reorder Planning page only (don't change other reports).
- Tests for the context state transitions (toggle, toggleAll, clear).

### Phase 2 — Toolbar integration + URL persistence (1 PR)

- Refactor `ReorderActionsToolbar` to read from the context.
- Add the URL-param round-trip for selection persistence within a page.
- Confirmation modal for the "act on all visible" fallback.

### Phase 3 — UX polish (1 PR if needed)

- Toast on filter/pagination change.
- Keyboard shortcuts (`a` to toggle all, `Enter` to generate).
- Footer summary of selected totals (sum of `suggestedReorderQty`) for cost forecasting.

## Risks

- URL-persisted selection grows with the set; cap at 250 and toast if the operator hits the cap.
- The shared `StockPositionReportPage` is used by other reports; the `selectionColumn` slot must default to `null` so they keep rendering unchanged.
