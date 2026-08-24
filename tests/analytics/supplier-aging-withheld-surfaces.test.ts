import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent, type Control } from '@/tests/fixtures/render-client-component'

/**
 * o3d-8u4h ROUND 2, Codex finding 2: A WITHHELD FIGURE THAT LOOKS EXACTLY LIKE A MEASURED ZERO.
 *
 * Round 1 stopped the supplier-aging report publishing `paidAmount: 0`, `dueAmount: billedAmount`
 * and `discounts: 0`, and then rendered the withheld figures as an EM DASH with the reason in a
 * `title` attribute. The em dash is already what this very table prints for a measured zero — every
 * `v > 0 ? fmtBase(v) : '—'` cell on the same row — so the two opposite claims became one glyph,
 * and the only thing separating them was a native tooltip that does not exist for a keyboard user,
 * in a screenshot, in a printout, or for anybody reading at speed.
 *
 * That defeats the whole fix. Withholding a figure only helps if THE READER CAN TELL IT WAS
 * WITHHELD; a withheld figure that reads as zero is the original defect with extra steps.
 *
 * SO EVERY ASSERTION HERE IS ON WHAT A READER SEES — the rendered table, parsed as a reader parses
 * it (this heading, that cell underneath) — and never on a prop being passed. Two of them read the
 * markup with EVERY `title` attribute stripped out first, which is what "a reader who cannot hover"
 * means concretely.
 *
 * Reverting `WithheldCell` to the old `{v == null ? '—' : …}` span fails
 * "reads the word Withheld, and a measured zero still reads as a dash".
 * Reverting the `AGING_NOTICES` block to tooltips alone fails "the reason is on the page".
 * Renaming the columns back to Settled/Unsettled fails "the headings name the marker".
 */

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})

const DAY = 86400000

/**
 * One supplier, worked so that the SAME table carries both kinds of blank:
 *   * £1,000 billed with no VAT, no freight, no returns  -> Tax and Landed Costs are MEASURED ZEROES
 *   * one bill marked paid 150 days ago, one not, aged 10 days
 *     -> three of the four age bands are MEASURED ZEROES and one carries £300
 *   * Discounts and Due are WITHHELD on every row, always
 */
const SUPPLIERS = [{
  id: 'sup-1',
  name: 'Acme',
  purchaseOrders: [{
    totalBase: 1500, taxBase: 0, directFreightBase: 0, subtotalBase: 1500,
    lines: [{ totalBase: 1500 }], poSentAt: null, receivedAt: null, returns: [],
    invoices: [
      { totalBase: 1200, invoiceDate: new Date(Date.now() - 200 * DAY), paidAt: new Date(Date.now() - 150 * DAY) },
      { totalBase: 300, invoiceDate: new Date(Date.now() - 10 * DAY), paidAt: null },
    ],
  }],
}]

mock.module('@/lib/db', { namedExports: { db: { supplier: { findMany: async () => SUPPLIERS } } } })
mock.module('@/components/providers/base-currency-provider', {
  namedExports: { useBaseCurrency: () => ({ code: 'GBP', symbol: '£', symbolPosition: 'PREFIX' }) },
})
mock.module('@/components/providers/timezone-provider', {
  namedExports: { useFormatDateTime: () => () => '1 Jan 2026' },
})
mock.module('next/navigation', { namedExports: { useRouter: () => ({ refresh: () => {} }) } })

// ---------------------------------------------------------------------------
// Reading the page the way a reader does: a heading, and the cell under it
// ---------------------------------------------------------------------------

function decode(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
}

function cellTexts(html: string, tag: 'th' | 'td'): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) out.push(decode(match[1].replace(/<[^>]*>/g, '')).trim())
  return out
}

function firstBodyRow(html: string): string {
  const body = html.slice(html.indexOf('<tbody'))
  return body.slice(0, body.indexOf('</tr>'))
}

/** The visible text of the cell sitting under a given column heading, in the first data row. */
function underHeading(html: string, heading: string): string {
  const headings = cellTexts(html, 'th')
  const index = headings.indexOf(heading)
  assert.notEqual(index, -1, `no column headed “${heading}” — headings were: ${headings.join(' | ')}`)
  const row = cellTexts(firstBodyRow(html), 'td')
  assert.equal(row.length, headings.length, 'header and body disagree about how many columns there are')
  return row[index]
}

/** What survives when nothing can be hovered: every `title` attribute removed. */
function withoutTooltips(html: string): string {
  return html.replace(/ title="[^"]*"/g, '')
}

async function renderAgingTab(): Promise<{ html: string; controls: Control[] }> {
  const { getSupplierAging } = await import('@/app/actions/purchase-stats')
  const aging = await getSupplierAging()

  const { PurchaseStatsClient } = await import('@/app/(dashboard)/analytics/purchase-stats/purchase-stats-client')
  const mounted = mountClientComponent(PurchaseStatsClient as unknown as (props: unknown) => unknown, {
    products: [], received: [], bills: [], aging, details: [], savedViews: [],
  })
  await mounted.click(mounted.render().controls.find((c) => c.label === 'Supplier Aging'))
  const { html, controls } = mounted.render()
  return { html, controls }
}

// ---------------------------------------------------------------------------

test('supplier aging: a withheld figure reads the WORD, and a measured zero still reads as a dash (o3d-8u4h round 2)', async () => {
  const { html } = await renderAgingTab()

  // The two blanks, side by side in one row, and NOT the same thing on the page.
  const due = underHeading(html, 'Due (withheld)')
  const discounts = underHeading(html, 'Discounts (withheld)')
  const tax = underHeading(html, 'Tax')
  const landed = underHeading(html, 'Landed Costs')

  assert.equal(due, 'Withheld')
  assert.equal(discounts, 'Withheld')
  // Genuine zeroes — this supplier really was charged no VAT and no freight — keep the dash they
  // have always had. They are measurements, and the table must go on saying so.
  assert.equal(tax, '—')
  assert.equal(landed, '—')
  assert.notEqual(due, tax, 'a withheld figure that renders identically to a measured zero IS the defect')
  assert.notEqual(discounts, landed)

  // And the distinction survives losing every tooltip on the page, which is the point.
  const blind = withoutTooltips(html)
  assert.equal(underHeading(blind, 'Due (withheld)'), 'Withheld')
  assert.equal(underHeading(blind, 'Tax'), '—')
})

test('supplier aging: an EMPTY age band and a WITHHELD figure are still told apart (o3d-8u4h round 2)', async () => {
  const { html } = await renderAgingTab()

  // £300 billed 10 days ago and never marked; the other three bands are measured zeroes, because
  // the only older bill carries a payment marker and has stopped ageing.
  assert.equal(underHeading(html, 'No marker 0-30d'), '£300.00')
  assert.equal(underHeading(html, 'No marker 31-60d'), '—')
  assert.equal(underHeading(html, 'No marker 61-90d'), '—')
  assert.equal(underHeading(html, 'No marker 91d+'), '—')
  assert.equal(underHeading(html, 'Due (withheld)'), 'Withheld')
})

test('supplier aging: the REASON is on the page, not under a hover (o3d-8u4h round 2)', async () => {
  const { html } = await renderAgingTab()
  const blind = withoutTooltips(html)

  // Round 1 put these sentences in `title` attributes only. Stripping the tooltips is exactly what
  // a keyboard user, a screenshot and a printout do to this page.
  assert.match(blind, /IMS records no amount paid to a supplier/)
  assert.match(blind, /a discount total cannot be assembled/)
  assert.match(blind, /markBillPaid stamps it even when only part of the bill was paid/)
  assert.match(blind, /aged from the INVOICE date/)

  // The headings carry the withholding too, so a reader scanning the column — not the notice — is
  // told before they read a single cell.
  const headings = cellTexts(html, 'th')
  assert.ok(headings.includes('Due (withheld)'), headings.join(' | '))
  assert.ok(headings.includes('Discounts (withheld)'))
})

test('supplier aging: the headings name the MARKER, and never a settlement (o3d-8u4h round 2)', async () => {
  const { html } = await renderAgingTab()
  const headings = cellTexts(html, 'th')

  assert.ok(headings.includes('Billed w/ payment marker'), headings.join(' | '))
  assert.ok(headings.includes('Billed w/o payment marker'))
  // The words that claimed more than the evidence carries. "Settled" asserts a discharged debt on a
  // bill that may have been part-paid; "overdue" asserts a relation to a due date this report never
  // reads. Neither may appear above a figure.
  assert.ok(!headings.some((h) => /settled/i.test(h)), headings.join(' | '))
  assert.ok(!headings.some((h) => /overdue/i.test(h)))

  // And the two halves are still checkable against Billed by a reader, in the rendered row.
  assert.equal(underHeading(html, 'Billed'), '£1500.00')
  assert.equal(underHeading(html, 'Billed w/ payment marker'), '£1200.00')
  assert.equal(underHeading(html, 'Billed w/o payment marker'), '£300.00')
})
