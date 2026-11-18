import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Internal notes on PO lines. A note is saved with the order, shown on the detail page, and is NEVER on the supplier PO (the PDF document model) or in
 * anything the supplier receives. The database, auth and router are doubles.
 */
const NOTE = 'INTERNAL: blue colourway, substitute accepted, chase this one'

type StoredLine = { id: string; poId: string; notes: string | null }
let stored: StoredLine[] = []
let allowed = true
const permissionsAsked: string[] = []
const lineSelects: unknown[] = []

const order = {
  reference: 'PO-NOTES', supplierId: 's1', currency: 'GBP', createdAt: new Date('2026-11-01T00:00:00.000Z'), expectedDelivery: null,
  notes: 'Please deliver to the loading bay', supplierRef: null, subtotalForeign: 10, taxRateName: null, taxRatePercent: null, taxForeign: 0, totalForeign: 10,
  directFreightForeign: 0, discountAmount: 0,
  supplier: { name: 'S', contactName: null, email: null, addressLine1: null, addressLine2: null, city: null, postcode: null, country: null, accountNumber: null, vatNumber: null, paymentTermsDays: null },
  destinationWarehouse: null,
  lines: [{
    productId: 'p1', description: null, qty: 5, purchaseUnitQty: null, unitCostForeign: 2, discountAmount: 0, totalForeign: 10, expectedDelivery: null, purchaseUnit: null,
    product: { sku: 'A', name: 'Widget', barcode: null, mpn: null },
    // What a careless select would hand back: the internal note rides along on the row.
    notes: NOTE,
  }],
}

const dbDouble = {
  purchaseOrder: { findUnique: async (args: { select: { lines: { select: unknown } } }) => { lineSelects.push(args.select.lines.select); return order } },
  currency: { findUnique: async () => null },
  supplierProduct: { findMany: async () => [] },
  purchaseOrderLine: {
    findUnique: async (args: { where: { id: string } }) => {
      const line = stored.find((l) => l.id === args.where.id)
      return line ? { id: line.id, poId: line.poId, po: { reference: 'PO-NOTES' } } : null
    },
    update: async (args: { where: { id: string }; data: { notes: string | null } }) => { stored.find((l) => l.id === args.where.id)!.notes = args.data.notes },
  },
}
mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      permissionsAsked.push(permission)
      if (!allowed) throw new Error('Forbidden')
      return { user: { id: 'u1' } }
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
mock.module('next/navigation', { namedExports: { useRouter: () => ({ refresh: () => undefined }), unstable_rethrow: () => undefined } })

test('the note is saved trimmed, a blank clears it, and the action needs purchasing.create', async () => {
  stored = [{ id: 'l1', poId: 'po1', notes: null }]
  permissionsAsked.length = 0
  const { updatePoLineNote } = await import('../../app/actions/purchase-orders.ts')
  assert.deepEqual(await updatePoLineNote('l1', `  ${NOTE}  `), { success: true, notes: NOTE })
  assert.equal(stored[0]!.notes, NOTE)
  assert.deepEqual(await updatePoLineNote('l1', '   '), { success: true, notes: null })
  assert.equal(stored[0]!.notes, null)
  assert.equal((await updatePoLineNote('missing', 'x')).success, false)
  assert.ok(permissionsAsked.length >= 3 && permissionsAsked.every((p) => p === 'purchasing.create'))

  allowed = false
  const denied = await updatePoLineNote('l1', 'changed')
  assert.equal(denied.success, false)
  assert.equal(stored[0]!.notes, null, 'a denied caller writes nothing')
  allowed = true
})

test('a note is capped at the length the form allows', async () => {
  stored = [{ id: 'l1', poId: 'po1', notes: null }]
  const { updatePoLineNote } = await import('../../app/actions/purchase-orders.ts')
  const result = await updatePoLineNote('l1', 'x'.repeat(5000))
  assert.equal(result.notes?.length, 2000)
})

test('the detail page line shows the saved note, and the editor when the user may write', async () => {
  const { PoLineNote } = await import('../../app/(dashboard)/purchase-orders/po-line-note.tsx')
  const readOnly = renderToStaticMarkup(React.createElement(PoLineNote, { lineId: 'l1', initial: NOTE, canEdit: false }))
  assert.ok(readOnly.includes(NOTE), 'the note text is on the page')
  assert.ok(!readOnly.includes('<button'), 'no editor for a user who cannot write')
  const editable = renderToStaticMarkup(React.createElement(PoLineNote, { lineId: 'l1', initial: NOTE, canEdit: true }))
  assert.ok(editable.includes(NOTE))
  assert.match(editable, /aria-label="Edit line note"/)
  const empty = renderToStaticMarkup(React.createElement(PoLineNote, { lineId: 'l1', initial: null, canEdit: true }))
  assert.match(empty, /aria-label="Add line note"/)
  assert.equal(renderToStaticMarkup(React.createElement(PoLineNote, { lineId: 'l1', initial: null, canEdit: false })), '', 'nothing for a line with no note and a read-only user')
})

test('the supplier PO document does not carry the line note, and its query never selects it', async () => {
  lineSelects.length = 0
  const { loadPurchaseOrderDocument } = await import('../../lib/purchase-order-pdf.ts')
  const doc = await loadPurchaseOrderDocument('po-1')
  assert.ok(doc)
  assert.equal(doc.lines.length, 1, 'PRECONDITION: the order line was loaded')
  assert.ok(JSON.stringify(doc).includes('Please deliver to the loading bay'), 'PRECONDITION: the ORDER note, which is supplier-facing, is on the document')
  assert.ok(!JSON.stringify(doc).includes('INTERNAL'), 'the line note is not on the document')
  assert.ok(!('notes' in doc.lines[0]!), 'the line has no notes field')
  assert.equal(lineSelects.length, 1)
  assert.ok(!('notes' in (lineSelects[0] as Record<string, unknown>)), 'the document query does not select the line note')
  const { poLayoutFlags, poDocumentColumns, poDocumentRows } = await import('../../lib/domain/purchasing/po-document.ts')
  const flags = poLayoutFlags(doc.lines)
  const cells = poDocumentRows(doc.lines, flags).flat().join('|')
  assert.ok(!cells.includes('INTERNAL'))
  assert.ok(!poDocumentColumns('£', flags).some((c) => /note/i.test(c.label)), 'no Notes column on the supplier PO')
})

test('no supplier-facing source selects or renders the line note', () => {
  const files = ['lib/purchase-order-pdf.ts', 'lib/purchase-order-email.ts', 'lib/domain/purchasing/po-document.ts', 'app/actions/supplier-portal.ts', 'app/api/purchase-order/[id]/route.ts']
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.ok(!/updatePoLineNote|PoLineNote|LineNotesField/.test(text), `${file} must not reference the line note`)
    // The one `notes` the supplier sees is the ORDER note (header). A line-level select would sit inside a `lines: { ... select: {` block.
    for (const block of text.matchAll(/lines:\s*\{[\s\S]*?\n\s{6,8}\},/g)) {
      assert.ok(!/\bnotes\b/.test(block[0]), `${file}: a lines select names notes`)
    }
  }
})
