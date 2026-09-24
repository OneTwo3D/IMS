import assert from 'node:assert/strict'
import test from 'node:test'

import { blankNonCode, productionSources } from './paid-provenance-scan'

/**
 * o3d-j625 r6 (review H3) — EVERY ACCOUNTING SYNC ROW IS CREATED THROUGH ONE FUNCTION.
 *
 * That function (lib/domain/accounting/sync-log-row.ts) clears the outstanding refusal the new row
 * discharges. A row written any other way is a posting whose refusal row can never clear — which is how
 * r5's supplier-credit-note allocation refusal was unclearable by construction: its only enqueue,
 * `enqueueFollowUpSyncLog`, created rows directly.
 *
 * The census reads every WRITE that can create a row on `accountingSyncLog` — create, createMany,
 * createManyAndReturn, upsert — including through a bracket access, and a raw INSERT into its table.
 */
const PRIMITIVE = 'lib/domain/accounting/sync-log-row.ts'
const WRITE = /accountingSyncLog\s*\.\s*(create|createMany|createManyAndReturn|upsert)\b/g
// A bracket access's method name is a string, and blanked — so ANY bracket access on the delegate is
// reported: the census cannot tell which method it names, and must not assume it is a read.
const BRACKET = /accountingSyncLog\s*\[/g
// o3d-j625 r7 (review LOW 4): schema-qualified too — `public.accounting_sync_logs`, quoted or not.
const RAW_INSERT = /insert\s+into\s+(?:"?\w+"?\s*\.\s*)?"?accounting_sync_logs"?/gi
// o3d-j625 r7 (review LOW 4): the delegate BOUND to a name, whose `.create` the patterns above cannot see —
// `const logs = tx.accountingSyncLog`, or `{ accountingSyncLog } = tx`. Any such binding is reported.
const ALIASED_DELEGATE = /=\s*[\w$.]*\.accountingSyncLog\b(?!\s*[.[])|\{[^}]*\baccountingSyncLog\b[^}]*\}\s*=\s*[\w$]/g

function offenders(files: Array<[string, string]>): string[] {
  const out: string[] = []
  for (const [file, source] of files) {
    if (file === PRIMITIVE) continue
    const code = blankNonCode(source)
    for (const m of code.matchAll(WRITE)) out.push(`${file}:${source.slice(0, m.index).split('\n').length} ${m[1]}`)
    for (const m of code.matchAll(BRACKET)) out.push(`${file}:${source.slice(0, m.index).split('\n').length} bracket access`)
    for (const m of code.matchAll(ALIASED_DELEGATE)) out.push(`${file}:${source.slice(0, m.index).split('\n').length} aliased delegate`)
    // A raw INSERT lives inside a string (blanked above), so it is looked for in the source itself.
    for (const m of source.matchAll(RAW_INSERT)) out.push(`${file}:${source.slice(0, m.index).split('\n').length} raw INSERT`)
  }
  return out
}

test('[o3d-j625 r6 H3] no code outside the primitive creates an accounting sync row', () => {
  const files = productionSources()
  const primitive = files.find(([file]) => file === PRIMITIVE)
  assert.ok(primitive, 'PRECONDITION: the primitive is among the sources walked')
  assert.equal([...blankNonCode(primitive[1]).matchAll(WRITE)].length, 1,
    'PRECONDITION: the primitive holds exactly the one create the census defers to')
  const callers = files.filter(([, source]) => /createAccountingSyncLogRow\(/.test(blankNonCode(source)))
  console.log(`[o3d-j625 r6] files calling the sync-row primitive: ${callers.length}`)
  assert.ok(callers.length >= 7, `PRECONDITION: the seven row writers route through it (found ${callers.length})`)
  assert.deepEqual(offenders(files), [],
    'these create accounting sync rows directly, so a refusal their posting discharges is never cleared. '
    + 'Create the row with createAccountingSyncLogRow (lib/domain/accounting/sync-log-row.ts).')
})

test('[o3d-j625 r6 H3] the census FIRES on each way of writing a row, and not on a read', () => {
  const fixture: Array<[string, string]> = [['lib/x.ts', `
    await tx.accountingSyncLog.create({ data })
    await db.accountingSyncLog.createMany({ data: [] })
    await tx.accountingSyncLog['upsert']({ where, create, update })
    await tx.$executeRaw\`INSERT INTO accounting_sync_logs (id) VALUES (1)\`
    await tx.accountingSyncLog.findMany({ where })
    // tx.accountingSyncLog.create({}) in a comment is not a write
  `]]
  assert.deepEqual(offenders(fixture).map((line) => line.split(' ').slice(1).join(' ')), ['create', 'createMany', 'bracket access', 'raw INSERT'])
})

test('[o3d-j625 r7 LOW 4] the census FIRES on a schema-qualified INSERT and on an aliased delegate', () => {
  const fixture: Array<[string, string]> = [['lib/y.ts', `
    await tx.$executeRaw\`INSERT INTO public.accounting_sync_logs (id) VALUES (1)\`
    await tx.$executeRaw\`insert into "public"."accounting_sync_logs" (id) values (1)\`
    const logs = tx.accountingSyncLog
    await logs.create({ data })
    const { accountingSyncLog } = tx
  `]]
  assert.deepEqual(offenders(fixture).map((line) => line.split(' ').slice(1).join(' ')).sort(),
    ['aliased delegate', 'aliased delegate', 'raw INSERT', 'raw INSERT'])
})
