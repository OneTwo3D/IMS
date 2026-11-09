import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { before, mock } from 'node:test'

import { createRecordingDb } from './recording-db'

/**
 * The five purchasing-analytics pages (open POs, PPV, spend, supplier performance, lead times) used to
 * sit behind the dashboard layout's authentication only, so a SUPPLIER, WAREHOUSE or READONLY user who
 * typed the URL read every supplier's spend and landed cost. The CSV export route was already gated.
 *
 * Driven through the real pages with only the session source mocked: the refusal is asserted by the
 * redirect AND by the report loaders never touching the database.
 */

type Role = 'ADMIN' | 'MANAGER' | 'FINANCE' | 'WAREHOUSE' | 'READONLY' | 'SUPPLIER'
let currentRole: Role = 'ADMIN'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole },
    }),
  },
})

const recorder = createRecordingDb([])
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

const PAGES = ['open-pos', 'ppv', 'spend', 'supplier-performance', 'lead-times'] as const
const props = { searchParams: Promise.resolve({}) }

async function loadPage(name: string): Promise<(p: typeof props) => Promise<unknown>> {
  const mod = await import(`@/app/(dashboard)/analytics/${name}/page`)
  return mod.default
}

before(async () => {
  // Positive control: an authorised role reaches the database through the same module graph.
  currentRole = 'ADMIN'
  const page = await loadPage('spend')
  await recorder.prove(async () => { try { await page(props) } catch { /* rendering is not the point */ } })
})

for (const name of PAGES) {
  for (const role of ['WAREHOUSE', 'READONLY', 'SUPPLIER'] as const) {
    test(`/analytics/${name} redirects a ${role} session without reading any report data`, async () => {
      currentRole = role
      recorder.reset()
      const page = await loadPage(name)
      await assert.rejects(
        () => page(props),
        (error: unknown) => error instanceof Error && /NEXT_REDIRECT/.test(`${error.message} ${(error as { digest?: string }).digest ?? ''}`),
      )
      recorder.assertNoReads(`${role} opening /analytics/${name}`)
    })
  }
}

test('every purchasing-analytics page calls the access gate before it reads', () => {
  const root = join(process.cwd(), 'app/(dashboard)/analytics')
  for (const name of PAGES) {
    const source = readFileSync(join(root, name, 'page.tsx'), 'utf8')
    const gate = source.indexOf('await requirePurchasingAnalyticsAccess()')
    const load = source.search(/await load\w+ReportForPage|await searchParams/)
    assert.ok(gate !== -1, `${name} has no purchasing analytics gate`)
    assert.ok(gate < load, `${name} reads before the gate`)
  }
})

test('census: every page that renders PurchasingAnalyticsReportPage is gated', () => {
  const root = join(process.cwd(), 'app/(dashboard)/analytics')
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    let source: string
    try { source = readFileSync(join(root, entry.name, 'page.tsx'), 'utf8') } catch { continue }
    if (!source.includes('PurchasingAnalyticsReportPage')) continue
    assert.match(source, /requirePurchasingAnalyticsAccess\(\)/, `${entry.name} renders purchasing analytics without the gate`)
  }
})
