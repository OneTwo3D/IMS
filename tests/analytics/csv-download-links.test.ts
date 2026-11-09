import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { reportCsvHref } from '@/app/(dashboard)/analytics/_components/report-utils'

// The dashboard's CSV links must request the metadata rows: the period totals and disclosures that exist only as
// export metadata are in the file only on request, and a bare API call stays data-only.

test('the shared download href asks for metadata=1 and keeps the report filters', () => {
  const href = reportCsvHref('/api/export/sales-analytics', new URLSearchParams({ dateFrom: '2026-01-01', page: '3' }), { report: 'sales' })
  const url = new URL(href, 'https://ims.test')
  assert.equal(url.pathname, '/api/export/sales-analytics')
  assert.equal(url.searchParams.get('metadata'), '1')
  assert.equal(url.searchParams.get('report'), 'sales')
  assert.equal(url.searchParams.get('dateFrom'), '2026-01-01')
})

test('every in-app download of a report whose totals or disclosures live in metadata requests metadata=1', () => {
  const root = process.cwd()
  for (const [file, path] of [
    ['sales-analytics-report.tsx', '/api/export/sales-analytics'],
    ['inventory-costing-report.tsx', '/api/export/inventory-costing'],
    ['inventory-ledger-report.tsx', '/api/export/inventory-ledger'],
    ['stock-position-report.tsx', 'exportBasePath'],
  ] as const) {
    const source = readFileSync(join(root, 'app/(dashboard)/analytics/_components', file), 'utf8')
    assert.match(source, new RegExp(`csvHref = reportCsvHref\\(.*${path.replace(/[/]/g, '\\/')}`), `${file} builds its CSV link with reportCsvHref`)
  }
  const purchase = readFileSync(join(root, 'app/(dashboard)/analytics/purchase-stats/purchase-stats-client.tsx'), 'utf8')
  assert.match(purchase, /api\/export\/analytics\?type=po_\$\{tab\}&metadata=1/, 'the supplier-aging download requests metadata')
})
