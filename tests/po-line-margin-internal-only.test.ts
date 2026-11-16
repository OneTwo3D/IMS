import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { hasPermission } from '@/lib/permissions'

// o3d-ywzag: the PO line margin is INTERNAL. It must not reach a supplier through the supplier portal, a
// quote (RFQ) view, the PO/RFQ PDF, a document preview or a supplier email. These are source-level
// invariants in the repo's usual style: the margin modules may only be imported by the PO form and the
// action that serves it, and every supplier-facing path is scanned for any mention.

const MARGIN_NEEDLES = ['line-margin', 'purchase-order-margin', 'previewPoLineMargins', 'computeLineMargin', 'computePoMarginTotal', 'Margin (internal)']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(full)
  }
  return out
}
const rel = (f: string) => f.split(path.sep).join('/')
const read = (f: string) => readFileSync(f, 'utf8')

const supplierFacing = [
  ...walk('app/(dashboard)/supplier'),
  ...walk('app/api/rfq'),
  ...walk('app/api/preview'),
  'app/actions/supplier-portal.ts',
  'lib/pdf.ts',
  'lib/order-email.ts',
  'lib/email.ts',
  ...walk('lib/domain/purchasing').filter((f) => /quote|rfq|pdf|email/i.test(f)),
].filter((f) => { try { statSync(f); return true } catch { return false } })

test('no supplier-facing render path mentions the margin modules or its label', () => {
  assert.ok(supplierFacing.length >= 8, 'the supplier-facing file set must not silently shrink')
  for (const f of supplierFacing) {
    const text = read(f)
    for (const needle of MARGIN_NEEDLES) {
      assert.ok(!text.includes(needle), `${rel(f)} must not reference ${needle}`)
    }
  }
})

test('the PO PDF and any PO email source are scanned too', () => {
  const everywhere = [...walk('app'), ...walk('lib'), ...walk('components')]
  const documentFiles = everywhere.filter((f) => /createPdfDocument|sendMail|nodemailer|prepareQueuedEmail/.test(read(f)))
  assert.ok(documentFiles.length > 0)
  for (const f of documentFiles) {
    const text = read(f)
    for (const needle of MARGIN_NEEDLES) {
      assert.ok(!text.includes(needle), `${rel(f)} renders documents/emails and must not reference ${needle}`)
    }
  }
})

test('only the PO form and its gated action import the margin modules', () => {
  const importers = [...walk('app'), ...walk('lib'), ...walk('components')]
    .filter((f) => !/line-margin\.ts$|purchase-order-margin\.ts$/.test(f))
    .filter((f) => /from '@\/(lib\/domain\/purchasing\/line-margin|app\/actions\/purchase-order-margin)'/.test(read(f)))
    .map(rel)
    .sort()
  assert.deepEqual(importers, ['app/(dashboard)/purchase-orders/po-form.tsx'])
  const actionImports = read('app/actions/purchase-order-margin.ts')
  assert.match(actionImports, /from '@\/lib\/domain\/purchasing\/line-margin'/)
})

test('the margin action is gated on inventory.prices before it reads anything', () => {
  const text = read('app/actions/purchase-order-margin.ts')
  const gate = text.indexOf("requirePermission('inventory.prices')")
  const firstRead = text.indexOf('db.')
  assert.ok(gate > 0 && firstRead > gate)
})

test('SUPPLIER (and roles without price access) do not hold the permission', () => {
  assert.equal(hasPermission('SUPPLIER', 'inventory.prices'), false)
  assert.equal(hasPermission('WAREHOUSE', 'inventory.prices'), false)
  assert.equal(hasPermission('READONLY', 'inventory.prices'), false)
  assert.equal(hasPermission('ADMIN', 'inventory.prices'), true)
})

test('the PO screens pass showMargin from inventory.prices and the form defaults it off', () => {
  for (const page of ['app/(dashboard)/purchase-orders/page.tsx', 'app/(dashboard)/purchase-orders/[id]/page.tsx']) {
    assert.match(read(page), /hasPermission\(session\.user\.role, 'inventory\.prices'\)/, page)
  }
  assert.match(read('app/(dashboard)/purchase-orders/po-form.tsx'), /showMargin = false/)
})
