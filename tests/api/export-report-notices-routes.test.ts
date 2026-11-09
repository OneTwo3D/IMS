import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'
import { NextRequest } from 'next/server'

import { CSV_EXPORT_NOTICES_HEADER } from '@/lib/csv'
import { reportCsvHref } from '../../app/(dashboard)/analytics/_components/report-utils.ts'

const NOTICE = 'No claimed recipe: component demand not planned for 1 BOM product(s) that need building: BOM-1.'
const emptyReport = { generatedAt: 'x', rows: [], pageInfo: { totalRows: 0 }, totals: {}, notices: [NOTICE] }

mock.module('@/lib/auth/server', { namedExports: { requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) } })
mock.module('@/lib/db', { namedExports: { db: { product: { findMany: async () => [] } } } })
mock.module('@/lib/security/replenishment-report-access', { namedExports: { canAccessReplenishmentReports: () => true } })
mock.module('@/lib/security/manufacturing-analytics-access', { namedExports: { canAccessManufacturingAnalytics: () => true } })
mock.module('@/lib/domain/inventory/replenishment-reports', {
  namedExports: {
    getReorderReport: async () => emptyReport,
    getBackorderDemandReport: async () => emptyReport,
    getComponentShortageReport: async () => emptyReport,
  },
})
mock.module('@/lib/domain/manufacturing/manufacturing-analytics', {
  namedExports: {
    getProductionVarianceReport: async () => emptyReport,
    getWipReport: async () => emptyReport,
    ManufacturingAnalyticsSourceLimitError: class extends Error {},
  },
})

const noticesIn = (response: Response): string[] =>
  JSON.parse(Buffer.from(response.headers.get(CSV_EXPORT_NOTICES_HEADER) ?? '', 'base64url').toString('utf8')) as string[]

test('replenishment export: notices in the header by default, appended as # rows only with ?notices=1', async () => {
  const { GET } = await import('../../app/api/export/replenishment/route.ts')
  for (const type of ['reorder', 'backorder', 'component-shortage']) {
    const plain = await GET(new NextRequest(`http://localhost/api/export/replenishment?type=${type}`))
    const plainBody = await plain.text()
    assert.deepEqual(noticesIn(plain), [NOTICE], type)
    assert.ok(!plainBody.includes('BOM-1') && !plainBody.includes('#'), `${type}: body is data rows only`)
    const withRows = await GET(new NextRequest(`http://localhost/api/export/replenishment?type=${type}&notices=1`))
    const body = await withRows.text()
    assert.match(body, /\r\n# IMS export notices\r\n/, type)
    assert.ok(body.includes('BOM-1'), type)
  }
})

test('manufacturing export: the same for production variance and WIP', async () => {
  const { GET } = await import('../../app/api/export/manufacturing-analytics/route.ts')
  for (const report of ['production-variance', 'wip']) {
    const plain = await GET(new NextRequest(`http://localhost/api/export/manufacturing-analytics?report=${report}`))
    assert.deepEqual(noticesIn(plain), [NOTICE], report)
    assert.ok(!(await plain.text()).includes('BOM-1'), report)
    const withRows = await GET(new NextRequest(`http://localhost/api/export/manufacturing-analytics?report=${report}&notices=1`))
    assert.ok((await withRows.text()).includes('BOM-1'), report)
  }
})

test('?metadata=1 (what the in-app links send) opts in as well as ?notices=1', async () => {
  const { GET } = await import('../../app/api/export/replenishment/route.ts')
  const response = await GET(new NextRequest('http://localhost/api/export/replenishment?type=reorder&metadata=1'))
  assert.ok((await response.text()).includes('BOM-1'))
})

test('the in-app download links carry the opt-in', () => {
  const href = reportCsvHref('/api/export/replenishment', new URLSearchParams('a=1'), { type: 'reorder' })
  assert.equal(new URL(href, 'http://h').searchParams.get('metadata'), '1')
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  assert.match(read('app/(dashboard)/analytics/_components/stock-position-report.tsx'), /reportCsvHref\(exportBasePath, params, \{ type: reportKey \}\)/)
  for (const page of ['reorder', 'backorder', 'component-shortage']) {
    assert.match(read(`app/(dashboard)/analytics/${page}/page.tsx`), /exportBasePath="\/api\/export\/replenishment"/, page)
  }
  assert.match(read('app/(dashboard)/analytics/_components/manufacturing-analytics-report.tsx'), /reportCsvHref\('\/api\/export\/manufacturing-analytics', params/)
})
