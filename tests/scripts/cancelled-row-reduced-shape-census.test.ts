import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import ts from 'typescript'

import { scanProgram } from '../../scripts/check-accounting-cancelled-row-predicates.mjs'

/**
 * o3d-f709 round 3 (Codex MEDIUM 1) — THE CENSUS FOLLOWS A SYNC-LOG ROW INTO A HELPER THAT TOOK IT
 * REDUCED.
 *
 * THE READER IT MISSED. `unregisteredLocalReceipts` received accounting-sync registrations as
 * `{ status: string; paymentId: string | null }` and treated every CANCELLED row as never sent —
 * the sixteenth copy of the claim this whole branch exists to end, and the one that decides whether
 * a reversal pass clears `paidAt` and raises a chargeback credit note. All three detectors declined
 * it: the status is a bare `string`, the shape carries no marker column, and its file never names
 * `accountingSyncLog`. The census reported fifteen readers and called the variable-mediated hole
 * "measured"; the measurement had been taken with the same three detectors that could not see this.
 *
 * THE FIX IS STRUCTURAL, WHICH IS WHY IT IS TESTED ON SYNTHETIC SOURCES. An object literal that puts
 * a recognised sync-log status into a `status` property mints a REDUCED ROW SHAPE, keyed by its
 * property-name signature; every later `.status` read on that shape is a read of a sync-log row.
 * Nothing about it depends on a name — not the helper's, not the parameter's, not the file's — so
 * asserting it against whichever real file happens to have the shape today would prove much less
 * than asserting it against the shape itself.
 */

const ROOT = process.cwd()

/** `AccountingSyncLog`'s columns, for the third detector. Only its own scan reads these. */
const COLUMNS = new Set([
  'id', 'connector', 'type', 'status', 'referenceType', 'referenceId', 'externalTransactionId',
  'payload', 'errorMessage', 'retryCount', 'settlementBasis', 'abandonedBeforeRemoteCall',
])

/** The loader: a real `accountingSyncLog` query, reduced to two fields at the call site. */
const LOADER = `
type SyncLogRow = {
  id: string
  status: string
  externalTransactionId: string | null
  settlementBasis: string | null
  abandonedBeforeRemoteCall: boolean | null
}
declare const db: { accountingSyncLog: { findMany(args: unknown): Promise<SyncLogRow[]> } }
export async function loadNamedReceipts(): Promise<Array<{ status: string; paymentId: string | null }>> {
  const rows = await db.accountingSyncLog.findMany({ where: { type: 'INVOICE_PAYMENT' } })
  return rows.map((row) => ({ status: row.status, paymentId: null as string | null }))
}
`

/**
 * The reader, spelt exactly as the real one was — including the fact that it never mentions the
 * table. Nothing local to this file identifies the rows as sync-log rows.
 */
const READER = `
export function unregisteredLocalReceipts(
  receiptIds: readonly string[],
  registrations: readonly { status: string; paymentId: string | null }[],
): string[] {
  const named = new Set(
    registrations.filter((row) => row.status !== 'CANCELLED').map((row) => row.paymentId),
  )
  return receiptIds.filter((id) => !named.has(id))
}
`

function scan(sources: Record<string, string>) {
  const files = new Map(Object.entries(sources).map(([name, text]) => [path.join(ROOT, name), text]))
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
  }
  const host = ts.createCompilerHost(options, true)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.readFile = (name) => (files.has(name) ? files.get(name) : readFile(name))
  host.fileExists = (name) => files.has(name) || fileExists(name)
  host.getSourceFile = (name, languageVersion, ...rest) => (files.has(name)
    ? ts.createSourceFile(name, files.get(name) as string, languageVersion, true)
    : getSourceFile(name, languageVersion, ...rest))
  const program = ts.createProgram([...files.keys()], options, host)
  return scanProgram({
    program,
    checker: program.getTypeChecker(),
    inScope: new Set(Object.keys(sources)),
    columns: COLUMNS,
  })
}

test('[o3d-f709 r3] a `{ status, paymentId }` reader IS a reader of a sync-log row', () => {
  const result = scan({
    'lib/census-fixture-loader.ts': LOADER,
    'lib/census-fixture-reader.ts': READER,
  })
  const flagged = result.failures.filter((f: string) => f.startsWith('lib/census-fixture-reader.ts'))
  assert.equal(flagged.length, 1, `the exact shape Codex found must be caught: ${result.failures.join('\n')}`)
  assert.match(flagged[0], /decides what a CANCELLED sync row means/)
  assert.match(
    flagged[0],
    /REDUCED sync-log row \{paymentId,status\}, built at lib\/census-fixture-loader\.ts:\d+/,
    'and it says WHERE the evidence columns were dropped, which is the fact a reader has to act on',
  )
  assert.equal(
    result.reducedRowShapes.get('paymentId,status')?.startsWith('lib/census-fixture-loader.ts:'),
    true,
  )
})

test('[o3d-f709 r3] and it is the REDUCTION that makes it one, not the shape of the parameter', () => {
  // THE PRECONDITION THAT STOPS THIS PASSING VACUOUSLY. Without the loader, `{ status: string;
  // paymentId: string | null }` is just an object with a status: nothing in the program ties it to
  // this table, and flagging it would make the census a blanket ban on the word CANCELLED. The
  // detector must be silent here and loud above, or it is measuring nothing.
  const result = scan({ 'lib/census-fixture-reader.ts': READER })
  assert.deepEqual(result.failures, [])
  assert.equal(result.reducedRowShapes.has('paymentId,status'), false)
})

test('[o3d-f709 r3] the reduction is followed through a SECOND reduction as well', () => {
  // Pass 1 iterates to a fixed point, so a helper that reduces the reduced row again is not a way
  // back out. Asserted because "it terminates" and "it reaches everything" are different claims.
  const result = scan({
    'lib/census-fixture-loader.ts': LOADER,
    'lib/census-fixture-narrow.ts': `
      import { loadNamedReceipts } from './census-fixture-loader'
      export async function narrower(): Promise<Array<{ status: string }>> {
        const rows = await loadNamedReceipts()
        return rows.map((row) => ({ status: row.status }))
      }
    `,
    'lib/census-fixture-reader2.ts': `
      export function retired(rows: readonly { status: string }[]): number {
        return rows.filter((row) => row.status === 'CANCELLED').length
      }
    `,
  })
  const flagged = result.failures.filter((f: string) => f.startsWith('lib/census-fixture-reader2.ts'))
  assert.equal(flagged.length, 1, result.failures.join('\n'))
})
