import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * THE ATTACHMENTS CARD on the purchase-order and sales-order detail pages: rendered to markup (no browser), and the page wiring pinned against the page source.
 * The server decides what a user may do (tests/security/order-attachment-routes-auth.test.ts); the card only hides controls the user would be refused.
 */
mock.module('next/navigation', { namedExports: { useRouter: () => ({ refresh: () => undefined, push: () => undefined }) } })

const rows = [
  { id: 'a1', originalFilename: 'Supplier quote.pdf', mimeType: 'application/pdf', byteSize: 2048, uploadedAt: '2026-11-16T10:00:00.000Z', uploadedByName: 'Pat Buyer' },
  { id: 'a2', originalFilename: 'Packing list.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', byteSize: 3 * 1024 * 1024, uploadedAt: '2026-11-15T10:00:00.000Z', uploadedByName: null },
]

async function render(props: { kind: 'purchase' | 'sales'; orderId: string; attachments: typeof rows; canEdit: boolean }): Promise<string> {
  const { OrderAttachmentsCard } = await import('../../components/orders/order-attachments-card.tsx')
  return renderToStaticMarkup(createElement(OrderAttachmentsCard, props))
}

test('a PO card lists each attachment with size, date and uploader, and offers download, upload and delete to an editor', async () => {
  const html = await render({ kind: 'purchase', orderId: 'po 1', attachments: rows, canEdit: true })
  assert.match(html, /Attachments \(2\)/)
  assert.match(html, /Supplier quote\.pdf/)
  assert.match(html, /2\.0 KB/)
  assert.match(html, /3\.0 MB/)
  assert.match(html, /Pat Buyer/)
  assert.match(html, /href="\/api\/order-attachments\/purchase-orders\/po%201\/a1"/, 'the download link is the by-id route of this order')
  assert.match(html, /aria-label="Download Supplier quote\.pdf"/)
  assert.match(html, /aria-label="Delete Supplier quote\.pdf"/)
  assert.match(html, />Upload</)
  assert.match(html, /type="file"/)
  assert.match(html, /accept="[^"]*\.pdf[^"]*\.msg"/)
})

test('a SO card targets the sales-order route', async () => {
  const html = await render({ kind: 'sales', orderId: 'so-9', attachments: rows.slice(0, 1), canEdit: true })
  assert.match(html, /href="\/api\/order-attachments\/sales-orders\/so-9\/a1"/)
})

test('a viewer without the edit permission sees the list and Download, and neither Upload nor Delete', async () => {
  const html = await render({ kind: 'sales', orderId: 'so-9', attachments: rows, canEdit: false })
  assert.match(html, /Download/)
  assert.doesNotMatch(html, /Upload/)
  assert.doesNotMatch(html, /type="file"/)
  assert.doesNotMatch(html, /Delete/)
})

test('the empty state says so, and tells an editor what may be uploaded and the size limit', async () => {
  const editor = await render({ kind: 'purchase', orderId: 'p1', attachments: [], canEdit: true })
  assert.match(editor, /Attachments \(0\)/)
  assert.match(editor, /No attachments\./)
  assert.match(editor, /PDF, images/)
  assert.match(editor, /20MB/)
  const viewer = await render({ kind: 'purchase', orderId: 'p1', attachments: [], canEdit: false })
  assert.match(viewer, /No attachments\./)
  assert.doesNotMatch(viewer, /20MB/)
})

test('delete is reachable only through the confirmation dialog, and the card sends the file to the by-id route only', () => {
  const src = readFileSync('components/orders/order-attachments-card.tsx', 'utf8')
  assert.match(src, /<ConfirmDialog/)
  assert.match(src, /destructive/)
  assert.equal((src.match(/method: 'DELETE'/g) ?? []).length, 1)
  assert.equal((src.match(/confirmDelete\(/g) ?? []).length, 2, 'declared once, called once (from the dialog)')
  assert.doesNotMatch(src, /onClick=\{[^}]*confirmDelete/, 'a row button never deletes directly')
})

test('both detail pages mount the card for their own order type, gated by the module permissions', () => {
  const po = readFileSync('app/(dashboard)/purchase-orders/[id]/page.tsx', 'utf8')
  const so = readFileSync('app/(dashboard)/sales/[id]/page.tsx', 'utf8')
  assert.match(po, /<OrderAttachmentsCard kind="purchase" orderId=\{po\.id\} attachments=\{attachments\} canEdit=\{canEditAttachments\}/)
  assert.match(so, /<OrderAttachmentsCard kind="sales" orderId=\{so\.id\} attachments=\{attachments\} canEdit=\{canEditAttachments\}/)
  assert.match(po, /canViewOrderAttachments\(session\.user\.role, 'purchase'\)/)
  assert.match(so, /canViewOrderAttachments\(session\.user\.role, 'sales'\)/)
})
