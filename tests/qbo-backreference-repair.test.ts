import assert from 'node:assert/strict'
import test from 'node:test'

// o3d-0g2n. o3d-v7sy made the order delete guard check SalesOrder.accountingInvoiceId precisely
// because it lives on the order row and SURVIVES the retention purge that deletes AccountingSyncLog
// rows. That only holds if the marker is reliably written — and on QuickBooks it was not.
//
// updateBackReference runs AFTER the row is marked SYNCED and swallows its failure into a WARNING.
// A transient failure therefore left:
//
//   - a real invoice in QuickBooks
//   - a SYNCED row with an externalTransactionId (protective, but only until retention)
//   - NO accountingInvoiceId on the order — the retention-proof marker missing
//
// Once retention deleted the log, an otherwise-eligible order could be hard-deleted while its
// QuickBooks invoice stood: exactly the hole o3d-v7sy set out to close, reached through the
// connector that lacked the repair path. Xero has had that sweep since audit-H3.

test('QuickBooks has a back-reference repair sweep, like Xero (o3d-0g2n)', async () => {
  const qbo = await import('@/lib/connectors/quickbooks/sync-processor')
  const xero = await import('@/lib/connectors/xero/sync-processor')

  assert.equal(typeof qbo.repairQuickBooksBackReferences, 'function')
  assert.equal(
    typeof xero.repairXeroBackReferences,
    'function',
    'the Xero counterpart this mirrors still exists — if it is ever removed, revisit both',
  )
})

test('the sweep uses the CONNECTOR-AGNOSTIC helpers, not a third copy of the logic (o3d-0g2n)', async () => {
  // applyBackReference / backReferenceIsMissing already live in lib/domain/accounting, which is what
  // makes this a parity fix rather than a new mechanism. QuickBooks' WRITER still duplicates that
  // logic locally (tracked separately) — the sweep must not add a third divergent copy.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'lib/connectors/quickbooks/sync-processor.ts'), 'utf8')

  const sweep = src.slice(src.indexOf('export async function repairQuickBooksBackReferences'))
  assert.match(sweep, /backReferenceIsMissing\(db, params\)/, 'probes via the shared helper')
  assert.match(sweep, /applyBackReference\(db, params\)/, 'and writes via the shared helper')
})

test('it probes before writing, so it is safe to run every cycle (o3d-0g2n)', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'lib/connectors/quickbooks/sync-processor.ts'), 'utf8')
  const sweep = src.slice(src.indexOf('export async function repairQuickBooksBackReferences'))

  // The probe must gate the write, or a cron-frequency sweep would rewrite every linked document.
  const probeIndex = sweep.indexOf('backReferenceIsMissing')
  const skipIndex = sweep.indexOf('if (!missing) continue')
  const applyIndex = sweep.indexOf('applyBackReference')
  assert.ok(probeIndex < skipIndex && skipIndex < applyIndex, 'probe, then skip-if-linked, then write')
})

test('FAILED rows carrying an external id are candidates too (o3d-0g2n)', async () => {
  // o3d-ju8t: the remote call happens BEFORE the result is written, so a FAILED row with an external
  // id posted successfully and then lost its writeback. Excluding FAILED would leave exactly the
  // rows most likely to need repair.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'lib/connectors/quickbooks/sync-processor.ts'), 'utf8')
  const sweep = src.slice(src.indexOf('export async function repairQuickBooksBackReferences'))
  const findMany = sweep.slice(sweep.indexOf('db.accountingSyncLog.findMany('))
  const where = findMany.slice(0, findMany.indexOf('  })'))

  assert.match(where, /status: \{ in: \['SYNCED', 'FAILED'\] \}/, 'both statuses are swept')
  assert.match(where, /externalTransactionId: \{ not: null \}/, 'but only rows that actually posted')
  assert.match(where, /connector: 'quickbooks'/, 'scoped to this connector')
})

test('a multi-bill PO is skipped rather than guessed at (o3d-0g2n)', async () => {
  // A PURCHASE_INVOICE row references the PO, not a specific bill. With several unlinked bills the
  // "latest unlinked" heuristic could stamp one bill's id onto another — a wrong external id is
  // worse than a missing one, because it looks correct. Same rule as Xero's sweep.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'lib/connectors/quickbooks/sync-processor.ts'), 'utf8')
  const sweep = src.slice(src.indexOf('export async function repairQuickBooksBackReferences'))

  assert.match(sweep, /skippedAmbiguous\+\+/, 'ambiguous POs are counted, not repaired')
  assert.match(sweep, /quickbooks_backreference_repair_ambiguous/, 'and logged for manual attribution')
})

test('both the cron and the manual sync run it (o3d-0g2n)', async () => {
  // A sweep nothing calls is not a fix. Xero runs it from both; QuickBooks now does too.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const cron = readFileSync(join(process.cwd(), 'app/api/cron/accounting-sync/route.ts'), 'utf8')
  assert.match(cron, /repairQuickBooksBackReferences\(\)/, 'the cron runs it')

  const manual = readFileSync(join(process.cwd(), 'app/actions/quickbooks-sync.ts'), 'utf8')
  assert.match(manual, /repairQuickBooksBackReferences\(\)/, 'and so does the manual sync')
})

test('the sweep never writes a type QuickBooks\' own writer would not (o3d-0g2n)', async () => {
  // The divergence hazard of reusing the SHARED applyBackReference from a connector whose writer
  // duplicates that logic: the shared helper handles PURCHASE_CREDIT_NOTE / SupplierCreditNote, and
  // QuickBooks' updateBackReference does NOT. If the sweep swept that type it would write a
  // back-reference the normal path never writes — a silent behaviour difference between the repair
  // path and the live path, which is worse than either behaviour alone.
  //
  // It does not: the candidate filter is SALES_INVOICE / CREDIT_NOTE / PURCHASE_INVOICE, the same
  // three Xero's sweep uses, and every one of them IS handled by the QuickBooks writer.
  //
  // (QuickBooks has no PURCHASE_CREDIT_NOTE support at all — processEntry's default branch returns
  // "Unknown sync type", so such a row fails loudly rather than silently succeeding. Tracked
  // separately; not something this sweep should paper over.)
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'lib/connectors/quickbooks/sync-processor.ts'), 'utf8')

  const sweep = src.slice(src.indexOf('export async function repairQuickBooksBackReferences'))
  const candidateTypes = sweep.slice(0, sweep.indexOf('})'))
  assert.doesNotMatch(
    candidateTypes,
    /PURCHASE_CREDIT_NOTE/,
    'sweeping a type the writer cannot handle would make repair and live paths disagree',
  )

  // And the writer really does handle each type the sweep can act on.
  const writer = src.slice(src.indexOf('async function updateBackReference'))
  const writerBody = writer.slice(0, writer.indexOf('\n}'))
  for (const type of ['SALES_INVOICE', 'CREDIT_NOTE', 'PURCHASE_INVOICE']) {
    assert.match(writerBody, new RegExp(type), `the writer handles ${type}, so repairing it is consistent`)
  }
})

test('a FAILED row is only terminalised once its follow-ups are restored (o3d-0g2n, review)', async () => {
  // The defect in the first version of this sweep: I mirrored Xero's FAILED -> SYNCED
  // terminalisation but dropped the enqueueFollowUps call that JUSTIFIES it.
  //
  // A row can reach FAILED after the external post succeeded but the follow-up enqueue (payment,
  // PDF, email, attachment) threw. Clearing it to SYNCED on the strength of the back-reference alone
  // erases the retry signal while leaving that payment or PDF permanently absent — the row reads
  // reconciled and the work is simply gone. Worse than leaving it FAILED, because FAILED at least
  // says something is wrong.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'lib/connectors/quickbooks/sync-processor.ts'), 'utf8')
  const sweep = src.slice(src.indexOf('export async function repairQuickBooksBackReferences'))

  assert.match(sweep, /await enqueueFollowUps\(/, 'the follow-ups are re-enqueued, as Xero does')

  // And the terminalisation is GATED on that having worked.
  assert.match(
    sweep,
    /row\.status === 'FAILED' && followUpsRestored/,
    'FAILED is retained when the follow-ups could not be restored, so the next pass retries',
  )

  // Ordering matters: restore, then terminalise.
  assert.ok(
    sweep.indexOf('await enqueueFollowUps(') < sweep.indexOf("row.status === 'FAILED' && followUpsRestored"),
    'follow-ups are restored BEFORE the row is declared reconciled',
  )
})

test('only rows the CURRENT QuickBooks realm could have created are repaired (o3d-0g2n, review)', async () => {
  // AccountingSyncLog has no realm provenance, and disconnect permits reconnecting to a DIFFERENT
  // realm while historical rows survive. Repairing those would write a realm-A transaction id onto a
  // document now operated under realm B — and if that id happens to exist there, later payment and
  // polling paths act on an unrelated document.
  //
  // Without a provenance column, the connection's own age is the cheapest sound proxy: only rows
  // created since the current token was stored can belong to the current realm. Stamping properly is
  // o3d-s36z.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'lib/connectors/quickbooks/sync-processor.ts'), 'utf8')
  const sweep = src.slice(src.indexOf('export async function repairQuickBooksBackReferences'))

  assert.match(sweep, /accountingToken\.findUnique/, 'the current connection is consulted')
  assert.match(sweep, /createdAt: \{ gte: token\.createdAt \}/, 'and bounds which rows are eligible')
  assert.match(
    sweep,
    /if \(!token\) return \{ checked: 0/,
    'with no connection at all, nothing is repaired rather than everything',
  )
})
