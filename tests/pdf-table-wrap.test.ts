import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfDocument, drawTable, type PdfTableColumn } from '../lib/pdf.ts'

// drawTable only reads branding.accentColor; a minimal stub is enough.
const BRANDING = { accentColor: '#336699' } as unknown as Parameters<typeof drawTable>[3]

function tableHeight(columns: PdfTableColumn[], rows: string[][]): number {
  const { doc } = createPdfDocument({ title: 'T' })
  const startY = doc.y
  drawTable(doc, columns, rows, BRANDING)
  return doc.y - startY
}

const LONG =
  'Voron 2.4/Trident DIN Rails - Cerakote coated - Natural, 350mm length, full hardware set (VORON-DINRAIL-350-NAT-HW)'
const SHORT = 'Widget'

test('a wrap column grows the row to fit a long value (full title shown over multiple lines)', () => {
  const cols: PdfTableColumn[] = [
    { label: 'Description', width: 230, wrap: true },
    { label: 'Qty', width: 40, align: 'right' },
  ]
  const short = tableHeight(cols, [[SHORT, '1']])
  const long = tableHeight(cols, [[LONG, '1']])
  assert.ok(long > short + 8, `wrapped long row (${long}) must be taller than the short row (${short})`)
})

test('a non-wrap column stays single-line for a long value (ellipsised, height unchanged)', () => {
  const cols: PdfTableColumn[] = [
    { label: 'Description', width: 230 }, // no wrap
    { label: 'Qty', width: 40, align: 'right' },
  ]
  const short = tableHeight(cols, [[SHORT, '1']])
  const long = tableHeight(cols, [[LONG, '1']])
  assert.equal(long, short, 'non-wrap row height must not change with a long value')
})
