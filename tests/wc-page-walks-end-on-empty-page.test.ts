import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_WC_PAGE_WALK_PAGES,
  WC_PAGINATION_UNKNOWN,
  describeUnendedWcPageWalk,
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
 * REVERT EVIDENCE (each verified by putting that one thing back and re-running this file):
 *   * restoring `while (page <= totalPages)` in product-sync.ts fails "each cursor walk is bounded
 *     by the page ceiling, not by the header".
 *   * deleting the `products.length === 0` break fails "each bulk walk ends on an empty page".
 *   * deleting the `describeUnendedWcPageWalk` push in product-sync/order-import fails "an unended
 *     walk is recorded as an error, which is what holds the cursor".
 *   * dropping `truncatedRead` from decideInitialImportOutcome fails "a truncated initial import
 *     cannot report complete".
 */

const WALKS = [
  {
    label: 'bulk product sync',
    file: 'lib/connectors/woocommerce/sync/product-sync.ts',
    /** The batch variable the walk breaks on. */
    batch: 'products',
    /** The walk records its incompleteness here, and this is the array the cursor gate reads. */
    holdsCursor: true,
  },
  {
    label: 'bulk order import sweep',
    file: 'lib/connectors/woocommerce/sync/order-import.ts',
    batch: 'orders',
    holdsCursor: true,
  },
  {
    label: 'historical order import',
    file: 'lib/connectors/woocommerce/orders.ts',
    batch: 'orders',
    holdsCursor: false,
  },
  {
    label: 'initial import',
    file: 'lib/connectors/woocommerce/sync/initial-import.ts',
    batch: 'orders',
    holdsCursor: false,
  },
] as const

async function source(rel: string): Promise<string> {
  return await readFile(path.join(process.cwd(), rel), 'utf8')
}

test('[o3d-xnwu] the header alone still cannot tell "one page" from "the store said nothing"', () => {
  // The premise. This is unchanged behaviour, restated here because it is WHY the loop condition had
  // to change: no amount of care at the parse site can rescue a walk that ends on the parsed value.
  assert.equal(readWcCountHeader('', 1), WC_PAGINATION_UNKNOWN, 'an empty header is unreadable')
  assert.equal(readWcCountHeader(null, 1), 1, 'and an absent one is indistinguishable from "one page"')
})

test('[o3d-xnwu] each bulk walk ends on an empty page', async () => {
  for (const walk of WALKS) {
    const text = await source(walk.file).then((t) => t.replace(/\s+/g, ' '))
    assert.ok(
      text.includes(`if (${walk.batch}.length === 0) { endedOnEmptyPage = true break }`),
      `${walk.label} must break on an empty page, which is the only proof of an ending`,
    )
  }
})

test('[o3d-xnwu] each cursor walk is bounded by the page ceiling, not by the header', async () => {
  for (const walk of WALKS) {
    const text = await source(walk.file)
    assert.match(
      text,
      /while \(page <= MAX_WC_PAGE_WALK_PAGES\)/,
      `${walk.label} still ends on totalPages, so an unreadable header truncates it silently`,
    )
    // Anchored to the start of a line so the historical mention inside fetchAllWcVariations' own
    // doc comment (" * looped `while (page <= totalPages)` ...") is not mistaken for live code.
    assert.doesNotMatch(
      text,
      /^\s*while \(page <= totalPages\)/m,
      `${walk.label} must not be bounded by a header value`,
    )
  }
  // The ceiling has to be large enough that it is never the thing that ends a real walk: 1000 pages
  // at the per_page: 100 all four use is 100,000 rows, and every one of them is scoped by a cursor,
  // a date range or a status set.
  assert.ok(MAX_WC_PAGE_WALK_PAGES >= 1000)
})

test('[o3d-xnwu] an unended walk is recorded as an error, which is what holds the cursor', async () => {
  for (const walk of WALKS) {
    const text = await source(walk.file)
    assert.match(
      text,
      /describeUnendedWcPageWalk\(/,
      `${walk.label} must report a walk that never reached an empty page`,
    )
  }

  // The two cursor walks specifically: the incompleteness lands in the SAME array their cursor gate
  // reads, so "did not finish reading" and "do not move the cursor" are one fact rather than two.
  for (const walk of WALKS.filter((w) => w.holdsCursor)) {
    const text = await source(walk.file)
    assert.match(
      text,
      /result\.errors\.push\(describeUnendedWcPageWalk\(/,
      `${walk.label} must push it into result.errors — the array "advance the cursor" is gated on`,
    )
  }

  // And the message says what it is, so an operator reading a sync error is not left guessing.
  const message = describeUnendedWcPageWalk('product', 1000)
  assert.match(message, /INCOMPLETE READ/)
  assert.match(message, /the sync cursor is not\s+advanced past it|cursor is not advanced/)
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
