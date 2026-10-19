import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import type { CsvImportActionResult } from '../../lib/csv-import'
import type { ResidualFile } from '../../lib/first-load/apply/residual'
import { NO_LOCK } from './apply-helpers'
import { precondition } from './helpers'

/**
 * The executor's own refusals, with the importer module replaced by a recorder (no database): a result that does not carry the system outcome
 * means the call took the web path and is NOT accepted; a preview is not an execution; a row-level message is shifted to the residual file's rows.
 * (The real importers, run as the system actor against a real database, are in apply-db.test.ts and system-import-importers.test.ts.)
 */

const calls: Array<{ file: string; rows: number; systemPresent: boolean }> = []
let respond: (call: number) => CsvImportActionResult = () => ({ created: 0, updated: 0, skipped: 0, errors: [] })

mock.module('@/app/actions/suppliers', {
  namedExports: {
    importSuppliersCsv: async (form: FormData, system?: unknown): Promise<CsvImportActionResult> => {
      const file = form.get('file') as File
      calls.push({ file: file.name, rows: (await file.text()).split('\r\n').filter(Boolean).length - 1, systemPresent: system !== undefined })
      return respond(calls.length)
    },
  },
})

let orderErrors: string[] = []
mock.module('@/app/actions/import', {
  namedExports: {
    importPurchaseOrdersCsv: async (): Promise<CsvImportActionResult> => ({ created: 0, updated: 0, skipped: 1, errors: orderErrors, system: outcome }),
  },
})

const outcome = { actor: { runId: 'r', operator: 'o' }, touchedIds: { created: [], updated: [] }, deferredEffects: { shoppingMetadataPush: [], stockSync: [] } }
const residual = (rows: number): ResidualFile => {
  const text = 'name\r\n' + Array.from({ length: rows }, (_, i) => `S${i}`).join('\r\n') + '\r\n'
  const bytes = new TextEncoder().encode(text)
  return { name: 'residual-suppliers-001.csv', chunk: 1, rows, bytes, sha256: 'x' }
}

describe('the executor', () => {
  it('CONTROL: an importer that returns the system outcome is accepted; its counters are summed over the calls and its calls carry the context', async (t) => {
    calls.length = 0
    respond = () => ({ created: 2, updated: 0, skipped: 1, errors: [], system: outcome })
    const { createExecutor } = await import('../../lib/first-load/apply/db/execute')
    const result = await createExecutor({ runId: 'run-1', operator: 'Op', maxRowsPerCall: 2 })('suppliers', residual(5), NO_LOCK)
    assert.deepEqual({ c: result.created, s: result.skipped }, { c: 6, s: 3 })
    assert.deepEqual(calls.map((c) => c.rows), [2, 2, 1])
    assert.ok(calls.every((c) => c.systemPresent))
    precondition(t, 'calls', calls.length)
  })

  it('a result WITHOUT the system outcome (the web path) is refused, not counted as a success', async () => {
    // Mutation named: remove the outcome check -> this arm resolves instead of rejecting.
    calls.length = 0
    respond = () => ({ created: 1, updated: 0, skipped: 0, errors: [] })
    const { createExecutor, IMPORTER_RETURNED_NO_SYSTEM_OUTCOME } = await import('../../lib/first-load/apply/db/execute')
    await assert.rejects(createExecutor({ runId: 'run-1', operator: 'Op' })('suppliers', residual(1), NO_LOCK), new Error(IMPORTER_RETURNED_NO_SYSTEM_OUTCOME))
  })

  it('an importer that refuses the file itself (an error, no outcome) is an error to account for, not a thrown web-path call', async () => {
    calls.length = 0
    respond = () => ({ created: 0, updated: 0, skipped: 0, errors: [], error: 'File exceeds maximum size', success: false })
    const { createExecutor } = await import('../../lib/first-load/apply/db/execute')
    const result = await createExecutor({ runId: 'run-1', operator: 'Op' })('suppliers', residual(1), NO_LOCK)
    assert.deepEqual(result.errors, ['File exceeds maximum size'])
    assert.equal(result.created, 0)
  })

  it('a result with an error but NO system outcome (a catch path after partial work) stops the file: no later call is made', async () => {
    // Mutation named: keep going after such a result -> the later calls run against a state nobody accounted for: red.
    calls.length = 0
    respond = (call) => (call === 2 ? { created: 1, updated: 0, skipped: 0, errors: ['Error: boom'], error: 'Error: boom', success: false } : { created: 1, updated: 0, skipped: 0, errors: [], system: outcome })
    const { createExecutor } = await import('../../lib/first-load/apply/db/execute')
    const result = await createExecutor({ runId: 'run-1', operator: 'Op', maxRowsPerCall: 2 })('suppliers', residual(6), NO_LOCK)
    assert.deepEqual(calls.map((c) => c.rows), [2, 2], 'the third call was never made')
    assert.deepEqual(result.errors, ['Error: boom'])
    assert.equal(result.created, 2, 'what the first two calls reported is kept')
  })

  it('a preview result is refused', async () => {
    calls.length = 0
    respond = () => ({ preview: true, dryRun: true, validRows: 1, invalidRows: 0, warnings: [], errors: [], proposedChanges: { created: 1, updated: 0, skipped: 0 } })
    const { createExecutor, IMPORTER_RETURNED_A_PREVIEW } = await import('../../lib/first-load/apply/db/execute')
    await assert.rejects(createExecutor({ runId: 'run-1', operator: 'Op' })('suppliers', residual(1), NO_LOCK), new Error(IMPORTER_RETURNED_A_PREVIEW))
  })

  it('a row number in a later call\'s message is shifted by the rows sent before it', async () => {
    calls.length = 0
    respond = () => ({ created: 0, updated: 0, skipped: 1, errors: [`Row 2: supplier name matches multiple suppliers`], system: outcome })
    const { createExecutor } = await import('../../lib/first-load/apply/db/execute')
    const result = await createExecutor({ runId: 'run-1', operator: 'Op', maxRowsPerCall: 3 })('suppliers', residual(6), NO_LOCK)
    assert.deepEqual(result.errors, ['Row 2: supplier name matches multiple suppliers', 'Row 5: supplier name matches multiple suppliers'])
  })

  it('an unusable run id or operator cannot even build the executor (the capability refuses to mint)', async () => {
    const { createExecutor } = await import('../../lib/first-load/apply/db/execute')
    assert.throws(() => createExecutor({ runId: 'has space', operator: 'Op' }))
    assert.throws(() => createExecutor({ runId: 'ok', operator: '   ' }))
  })

  it('a purchase order\'s lines are sent grouped, in another order than the file: a message row number is mapped through the call\'s own row list, not shifted', async () => {
    // Mutation named: shift by the rows sent before (the old rule) -> B1 (line 3 of the residual file) is reported as line 4.
    const { createExecutor } = await import('../../lib/first-load/apply/db/execute')
    const text = 'orderKey,sku\r\nA,1\r\nB,1\r\nA,2\r\n'
    const file: ResidualFile = { name: 'residual-purchase-orders-001.csv', chunk: 1, rows: 3, bytes: new TextEncoder().encode(text), sha256: 'x' }
    // The call file is A1, A2, B1: B1 is line 4 of it, and line 3 of the residual file.
    orderErrors = ['Row 4: supplier not found', 'Row 2: bad line']
    const result = await createExecutor({ runId: 'run-1', operator: 'Op' })('purchase-orders', file, NO_LOCK)
    assert.deepEqual(result.errors, ['Row 3: supplier not found', 'Row 2: bad line'])
  })

  it('the planner itself refuses an order with more lines than a call may hold (the bound is not silently exceeded), with a closed code', async () => {
    const { planImportCalls, ImportCallError } = await import('../../lib/first-load/apply/import-calls')
    const text = 'orderKey,sku\r\nBIG,1\r\nBIG,2\r\nBIG,3\r\nSMALL,1\r\n'
    assert.throws(() => planImportCalls('purchase-orders', new TextEncoder().encode(text), 2), (e: unknown) => e instanceof ImportCallError && e.code === 'ORDER_TOO_LARGE' && !/BIG/.test(e.message))
    assert.equal(planImportCalls('purchase-orders', new TextEncoder().encode(text), 3).length, 2, 'control: at the bound it is two calls')
  })
})
