import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_WC_PAGE_WALK_PAGES,
  WC_PAGINATION_UNKNOWN,
  describeUnendedWcPageWalk,
  describeUnreadWcPage,
  describeWcPageWalkCeilingStall,
  readWcCountHeader,
} from '@/lib/connectors/woocommerce/api'
import { decideInitialImportOutcome } from '@/lib/connectors/woocommerce/sync/initial-import'

/**
 * o3d-xnwu (Codex MEDIUM) — THE EMPTY-PAGE RULE WAS SKIPPED IN THE WALKS THAT FEED A CURSOR.
 *
 * The rule — "only an empty page proves an ending; `x-wp-totalpages` cannot" — was applied to
 * `fetchAllWcRefundsForOrder`, `fetchAllWcVariations` and the category mirror, all of which return a
 * list and throw on a truncated read. It was NOT applied to the four bulk walks, three of which
 * ADVANCE A CURSOR — and the same commit that introduced the header-parsing sentinel also owned the
 * cursor-advance rule, so the two halves shipped apart.
 *
 * The consequence, spelled out: a store whose `x-wp-totalpages` is empty gives the bulk product sync
 * `WC_PAGINATION_UNKNOWN`, and one that omits it entirely gives the caller's default of 1. Either
 * way `page <= totalPages` is false after page one, the walk returns 100 products with NO error, and
 * `result.errors.length === 0` advances the cursor to now — permanently skipping every product
 * beyond page 1 whose `date_modified` predates the new watermark. Nothing re-reads behind a cursor.
 *
 * ROUND 3 (Codex HIGH): THIS FILE NO LONGER ASSERTS ANY OF THAT AGAINST SOURCE TEXT. The three
 * greps that did have been replaced by tests that drive each walk — see the block below for where
 * each one now lives. What remains here is the part with no behaviour to drive.
 *
 * REVERT EVIDENCE:
 *   * dropping `truncatedRead` from decideInitialImportOutcome fails "a truncated initial import
 *     cannot report complete".
 *   * dropping `unreadPages` fails "a page that was never read is also an incomplete read".
 */


async function source(rel: string): Promise<string> {
  return await readFile(path.join(process.cwd(), rel), 'utf8')
}

test('[o3d-xnwu] the header alone still cannot tell "one page" from "the store said nothing"', () => {
  // The premise. This is unchanged behaviour, restated here because it is WHY the loop condition had
  // to change: no amount of care at the parse site can rescue a walk that ends on the parsed value.
  assert.equal(readWcCountHeader('', 1), WC_PAGINATION_UNKNOWN, 'an empty header is unreadable')
  assert.equal(readWcCountHeader(null, 1), 1, 'and an absent one is indistinguishable from "one page"')
})

// ---------------------------------------------------------------------------
// WHERE THE WALKS THEMSELVES ARE TESTED (round 3, Codex HIGH).
//
// Three tests used to live here, and all three were WHITESPACE-NORMALISED SOURCE GREPS:
//
//   * `text.includes('if (' + batch + '.length === 0) { endedOnEmptyPage = true break }')`
//   * `assert.match(text, /while \(page <= MAX_WC_PAGE_WALK_PAGES\)/)`
//   * `assert.match(text, /result\.errors\.push\(describeUnendedWcPageWalk\(/)`
//
// None of them could see whether the branch is REACHED, whether its value is USED, or whether the
// cursor moves — which is the entire claim. Wrapping the very push the third one asserts in
// `if (false && …)` left the source text intact and all 366 tests green, and so did flipping the
// truncation flag to a constant `false`. They also broke on reformatting that changed nothing, so
// they were both blind and brittle.
//
// They are replaced by tests that DRIVE each walk and assert on what it wrote:
//
//   bulk product sync         tests/wc-product-sync-type-preservation.test.ts  ("--- the page walk itself")
//   bulk order import sweep   tests/wc-order-sweep-page-walk.test.ts
//   initial import            tests/wc-initial-import-page-hole.test.ts
//   historical order import   tests/wc-historical-import-page-hole.test.ts
//
// What is left in this file is what genuinely has no behaviour to drive: the header parser, the pure
// outcome rule, the shared ceiling constant, and the documentation.
// ---------------------------------------------------------------------------

test('[o3d-xnwu] the ceiling is large enough never to be what ends a real walk', () => {
  // 1000 pages at the `per_page: 100` all four walks use is 100,000 rows, and every one of them is
  // scoped by a cursor, a date range or a status set. That the walks are actually BOUNDED by it —
  // rather than by a header — is asserted in wc-order-sweep-page-walk.test.ts, which counts the
  // pages a never-ending store is asked for.
  assert.ok(MAX_WC_PAGE_WALK_PAGES >= 1000)
})

test('[o3d-xnwu] the incomplete-read message says what it is', () => {
  // The wording, which several walks share. Whether it is ever PUSHED is asserted per walk, in the
  // files listed above.
  const message = describeUnendedWcPageWalk('product', 1000)
  assert.match(message, /INCOMPLETE READ/)
  assert.match(message, /the sync cursor is not\s+advanced past it|cursor is not advanced/)
})

test('[round 3] an unread page and an unended walk are DIFFERENT sentences', () => {
  // They send an operator to different places: one to the store's page-count header, the other to
  // whatever made page N fail. Collapsing them is how the tail check came to stand for both.
  const unread = describeUnreadWcPage('initial order import', 7, 'HTTP 500')
  assert.match(unread, /page 7/)
  assert.match(unread, /HTTP 500/)
  assert.match(unread, /NEVER READ/)
  assert.match(unread, /MIDDLE/, 'the distinguishing fact: this is a hole, not a short tail')
  assert.doesNotMatch(unread, /x-wp-totalpages/, 'the header is not the cause here')

  const unended = describeUnendedWcPageWalk('initial order import', 1000)
  assert.match(unended, /x-wp-totalpages/)
  assert.doesNotMatch(unended, /NEVER READ/)
})

test('[round 3] a cursor walk that runs out of ceiling is NOT promised a retry', () => {
  // `describeUnendedWcPageWalk` ends "It will be retried", which is true of the walks with no cursor
  // and false of the two that hold one: their retry rebuilds the identical window. The cursor walks
  // use their own wording, and it names the cursor so the operator knows which one is stuck.
  const stall = describeWcPageWalkCeilingStall('product', 'last_wc_product_sync_at')
  assert.match(stall, /RETRYING CANNOT CLEAR IT/)
  assert.match(stall, /last_wc_product_sync_at/)
  assert.match(stall, /Narrow the window|raise\s+MAX_WC_PAGE_WALK_PAGES/, 'and both remedies are human ones')
  assert.doesNotMatch(stall, /It will be retried/)
})

test('[o3d-xnwu] a truncated initial import cannot report complete', () => {
  // The one walk where recording an error was NOT enough. decideInitialImportOutcome lets ANY
  // progress outvote ANY error count — and a backfill truncated to its first page has imported
  // orders — so a truncated read would have unlocked live order sync over a store IMS had mostly
  // never read. It is passed in separately for exactly that reason.
  assert.equal(
    decideInitialImportOutcome({ imported: 100, skipped: 0, errorCount: 1, truncatedRead: true }),
    'failed',
    'a truncated read must fail the pass however many orders it managed to import',
  )
  assert.equal(
    decideInitialImportOutcome({ imported: 100, skipped: 0, errorCount: 1 }),
    'complete',
    'while ordinary per-order errors still do not block — that rule is unchanged',
  )
  assert.equal(
    decideInitialImportOutcome({ imported: 0, skipped: 0, errorCount: 0, truncatedRead: true }),
    'failed',
    'and an empty truncated read is not "no orders to import"',
  )
  // The pre-existing contract, re-asserted so the new input cannot be seen to have loosened it.
  assert.equal(decideInitialImportOutcome({ imported: 0, skipped: 0, errorCount: 1 }), 'failed')
  assert.equal(decideInitialImportOutcome({ imported: 0, skipped: 0, errorCount: 0 }), 'complete')
})

test('[round 3] a page that was never read is also an incomplete read', () => {
  // The other cause, and the one round 2 missed. `truncatedRead` answers a question about the TAIL;
  // a page whose fetch failed is a hole in the MIDDLE, which reaching an empty page later cannot
  // reveal. Its own input, because it fails the pass for a different reason and gets a different
  // sentence. That the WALK feeds it is asserted in wc-initial-import-page-hole.test.ts.
  assert.equal(
    decideInitialImportOutcome({ imported: 100, skipped: 0, errorCount: 1, unreadPages: 1 }),
    'failed',
    'a page of up to 100 orders was never read; nothing else in the system reads history',
  )
  assert.equal(
    decideInitialImportOutcome({ imported: 500, skipped: 500, errorCount: 0, unreadPages: 1 }),
    'failed',
    'and no amount of progress outvotes it, which is the whole difference from a per-ORDER error',
  )
  // Both causes can be absent, present, or both present.
  assert.equal(decideInitialImportOutcome({ imported: 1, skipped: 0, errorCount: 0, unreadPages: 0 }), 'complete')
  assert.equal(
    decideInitialImportOutcome({ imported: 1, skipped: 0, errorCount: 2, truncatedRead: true, unreadPages: 1 }),
    'failed',
  )
})

test('[o3d-xnwu] the connector docs describe the shipped coverage, not the old half of it', async () => {
  const docs = await source('help-docs/woocommerce.md')
  // Whitespace-normalised: the source is hard-wrapped, so a named walk can straddle two lines.
  const section = docs
    .slice(docs.indexOf('How the connector decides it has read a whole list'))
    .replace(/\s+/g, ' ')
  for (const named of ['product sync', 'order import sweep', 'historical order import', 'initial import']) {
    assert.ok(section.includes(named), `the docs must name the ${named} as covered`)
  }
  assert.match(section, /fails the pass outright/, 'and record what a truncated initial import now does')
})
