import assert from 'node:assert/strict'
import test from 'node:test'

import type { ConnectorOrphanSummary } from '@/lib/domain/accounting/connector-orphans'
import {
  resolveConnectorOrphanBannerState,
  shouldRedirectFromSyncPage,
} from '@/lib/domain/accounting/stranded-sync-visibility'

// o3d-osl8 item 1 — the VISIBILITY rules, tested as pure functions.
//
// These decisions used to live inside app/(dashboard)/sync/page.tsx and connector-orphan-banner
// .tsx, where each combination could only be reached by constructing a whole page state. Pulled
// out, the full matrix is enumerable here in a few lines: the permission/plugin/rows/unknown
// grid, the nullable-summary cases, visibility after a failed read, and the truncation message.
//
// The WIRING — that the page calls these with the real inputs and renders what they return — is
// covered as behaviour in tests/accounting/stranded-sync-page.test.ts, which awaits the server
// component and renders its output. These two files cover different things; neither implies the
// other.

// ---------------------------------------------------------------------------
// shouldRedirectFromSyncPage
// ---------------------------------------------------------------------------

const NO_STRANDED = { strandedRowsExist: false, strandedRowsUnknown: false }

test('with an integration enabled the page never redirects, whatever the stranded state', () => {
  for (const hasSyncPermission of [true, false]) {
    for (const strandedRowsExist of [true, false]) {
      for (const strandedRowsUnknown of [true, false]) {
        assert.equal(
          shouldRedirectFromSyncPage({
            anyIntegrationPluginEnabled: true,
            hasSyncPermission,
            strandedRowsExist,
            strandedRowsUnknown,
          }),
          false,
        )
      }
    }
  }
})

test('no plugins and nothing stranded still redirects — the redirect is not weakened generally', () => {
  assert.equal(
    shouldRedirectFromSyncPage({ anyIntegrationPluginEnabled: false, hasSyncPermission: true, ...NO_STRANDED }),
    true,
  )
})

test('no plugins but stranded rows exist: the page RENDERS — the retired connector case', () => {
  // The bug this closes: when the retired accounting connector was the last enabled plugin,
  // activeConnector is null and by this feature's own rule EVERY unresolved accounting row is
  // stranded — yet the only page that can show them redirected away first. The action-level
  // "with no accounting connector enabled, every unresolved row is stranded" test passed while
  // the operator could never reach the result.
  assert.equal(
    shouldRedirectFromSyncPage({
      anyIntegrationPluginEnabled: false,
      hasSyncPermission: true,
      strandedRowsExist: true,
      strandedRowsUnknown: false,
    }),
    false,
  )
})

test('a role without `sync` redirects exactly as before, even when rows exist', () => {
  // It never reads them, so strandedRowsExist is false for such a session by construction; the
  // permission is asserted directly too, so no future caller can pass rows in for a role that
  // must not see them and thereby keep the page open.
  assert.equal(
    shouldRedirectFromSyncPage({ anyIntegrationPluginEnabled: false, hasSyncPermission: false, ...NO_STRANDED }),
    true,
  )
  assert.equal(
    shouldRedirectFromSyncPage({
      anyIntegrationPluginEnabled: false,
      hasSyncPermission: false,
      strandedRowsExist: true,
      strandedRowsUnknown: true,
    }),
    true,
    'no `sync` permission redirects regardless of what is passed for the rows',
  )
})

test('a FAILED stranded read does not redirect — failure is not "there are none"', () => {
  // Redirecting here would make an unreadable database indistinguishable from an empty one, and
  // the operator would be bounced to the plugin settings with no indication anything went wrong.
  assert.equal(
    shouldRedirectFromSyncPage({
      anyIntegrationPluginEnabled: false,
      hasSyncPermission: true,
      strandedRowsExist: false,
      strandedRowsUnknown: true,
    }),
    false,
  )
})

// ---------------------------------------------------------------------------
// resolveConnectorOrphanBannerState
// ---------------------------------------------------------------------------

function summary(totalOrphans: number): ConnectorOrphanSummary {
  return {
    activeConnector: 'xero',
    orphanGroups: totalOrphans > 0 ? [{ connector: 'quickbooks', count: totalOrphans }] : [],
    totalOrphans,
  }
}

function bannerState(over: Partial<Parameters<typeof resolveConnectorOrphanBannerState>[0]> = {}) {
  return resolveConnectorOrphanBannerState({
    summary: null,
    rowCount: 0,
    totalStrandedRows: 0,
    hasMore: false,
    loadFailed: false,
    ...over,
  })
}

test('the banner renders when ANY of its three sources has something to say', () => {
  // Full combination matrix over (summary present/null/zero) x (rows empty/non-empty) x
  // (loadFailed) x (hasMore). Nothing to say from all three => nothing rendered.
  for (const summaryCase of [null, summary(0), summary(4)]) {
    for (const rowCount of [0, 2]) {
      for (const loadFailed of [false, true]) {
        for (const hasMore of [false, true]) {
          const state = bannerState({
            summary: summaryCase,
            rowCount,
            totalStrandedRows: hasMore ? rowCount + 9 : rowCount,
            hasMore,
            loadFailed,
          })
          const expectSummary = (summaryCase?.totalOrphans ?? 0) > 0
          assert.equal(state.showSummary, expectSummary)
          assert.equal(state.showRows, rowCount > 0)
          assert.equal(state.showLoadFailure, loadFailed)
          assert.equal(state.render, expectSummary || rowCount > 0 || loadFailed)
          assert.equal(state.truncated, rowCount > 0 && hasMore)
        }
      }
    }
  }
})

test('a null summary does not hide the rows — the aggregate failing is not the list failing', () => {
  // getCrossConnectorOrphanSummary is fetched with .catch(() => null). Those rows are the only
  // view of work stranded on a retired connector; dropping them because an unrelated aggregate
  // query failed removes the remedy the banner exists for.
  const state = bannerState({ summary: null, rowCount: 3, totalStrandedRows: 3 })
  assert.equal(state.render, true)
  assert.equal(state.showRows, true)
  assert.equal(state.showSummary, false, 'no trustworthy total, so no count paragraph and no cancel controls')
})

test('a FAILED row read renders the banner even with no summary at all', () => {
  // The state that previously vanished entirely: the summary counts PENDING/PROCESSING only, so
  // when the stranded rows are all FAILED on a retired connector, a swallowed loader error left
  // the operator looking at a page with no banner — reading as "nothing is wrong".
  const state = bannerState({ summary: null, loadFailed: true })
  assert.equal(state.render, true)
  assert.equal(state.showLoadFailure, true)
  assert.equal(state.showRows, false)
  assert.equal(state.rowsSummary, null)
})

test('a FAILED row read is still distinct from an empty one when the summary is fine', () => {
  // Without the distinction the operator silently falls back to the old count-only banner and
  // believes the detail simply does not apply.
  const failed = bannerState({ summary: summary(4), loadFailed: true })
  const empty = bannerState({ summary: summary(4), loadFailed: false })
  assert.equal(failed.showLoadFailure, true)
  assert.equal(empty.showLoadFailure, false)
  assert.equal(failed.render, true)
  assert.equal(empty.render, true)
})

test('a truncated list says how many of how many — never a bare count of what came back', () => {
  // "50 shown" reads as "50 exist". This list is READ-ONLY, so the oldest rows cannot be cleared
  // from here: without this sentence a newer stranded row is invisible forever with no clue.
  const state = bannerState({ rowCount: 50, totalStrandedRows: 137, hasMore: true })
  assert.equal(state.truncated, true)
  assert.equal(state.rowsSummary, 'Showing the oldest 50 of 137 stranded row(s) — 87 more are not listed here.')
})

test('a complete list says so, and is not reported as truncated', () => {
  const state = bannerState({ rowCount: 3, totalStrandedRows: 3, hasMore: false })
  assert.equal(state.truncated, false)
  assert.equal(state.rowsSummary, 'Showing all 3 stranded row(s), oldest first.')
})

test('a stale/short total cannot make a truncated list read as complete', () => {
  // `total` is a second query and can lag the page read. hasMore came from the page itself
  // (limit + 1 rows came back), so it wins: at least one more row is known to exist.
  const state = bannerState({ rowCount: 50, totalStrandedRows: 12, hasMore: true })
  assert.equal(state.truncated, true)
  assert.equal(state.rowsSummary, 'Showing the oldest 50 of 51 stranded row(s) — 1 more are not listed here.')
})
