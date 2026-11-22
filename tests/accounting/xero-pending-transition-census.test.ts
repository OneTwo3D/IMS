import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

// THE PENDING-TRANSITION CENSUS: EVERY PLACE THAT WRITES A SYNC ROW'S STATUS TO PENDING IS DECLARED, WITH WHAT THE HOLD DOES THERE.
//
// A queued Xero posting is an AccountingSyncLog row that is PENDING (claimable) with an outbox job. The producer-side hold
// (lib/security/producer-seam.ts) must be asked at every place that MAKES such a row: a create, a revival of a FAILED row, a
// manual or daily retry. The producer census (scripts/producer-census.ts) finds the CREATE and the outbox-schedule sites; it does
// not look at a status that is merely WRITTEN to PENDING on an existing row. This test does: by TypeScript syntax tree it finds
// every `status: 'PENDING'` written as data (not read in a `where`) in a file that touches the sync-log table, plus every raw SQL
// statement that sets a sync row PENDING, and the table below must say for each one whether it consults the seam and why not.
//
// Reconciliation is universal in both directions: a site found and not declared is red; a declaration no site matches is red.
// A site declared `consults: true` must have `xeroProducerSeamVerdict` (or the primitive that asks it) in its own function body.
// Named mutations: (a) a new unlisted PENDING write is red; (b) a declaration for a site that is gone is red; (c) the follow-up
// revival's seam call removed is red (the `consults: true` arm); (d) the manual-retry 'no candidates' seam call removed is red.

const ROOT = join(__dirname, '..', '..')
const SOURCE_ROOTS = ['app', 'lib', 'scripts'] as const
const SKIP_DIRS = new Set(['node_modules', '.next', 'archive', 'generated'])

type Declaration = {
  /** `file::enclosing function` (the write sites of one function are one declaration; `xN` is how many). */
  site: string
  count: number
  /** Does the code at this site ask the producer seam (directly, or through the sync-log primitive that does) before the write? */
  consults: boolean
  /** Calls of xeroProducerSeamVerdict the function body must contain itself (the primitive's own ask does not count for these). */
  verdictCalls?: number
  /**
   * THE WRITER-SIDE CUT-OFF: the number of calls of `xeroBeforeCutoffRefusal` / `xeroNotBeforeCutoffWhere` the function body must contain
   * itself. A site that makes a row claimable again must refuse a row created before the destination's live-from instant. A site that
   * does not (a held claim given back, a post-send finish) says why in `why`: the claim statement refuses such a row anyway.
   */
  cutoffCalls?: number
  /** Why it is correct that it does, or does not. */
  why: string
}

export const DECLARED: readonly Declaration[] = [
  { site: 'lib/accounting.ts::queueAccountingSyncTx', count: 1, consults: true, why: 'create through createAccountingSyncLogRow, which asks the seam; a shadow gets no outbox job and no event' },
  { site: 'lib/connectors/xero/queue.ts::queueXeroSync', count: 1, consults: true, why: 'create through createAccountingSyncLogRow (seam); shadowed is reported as queued:true/shadowed' },
  { site: 'lib/connectors/xero/daily-sync.ts::createPendingSyncLog', count: 1, consults: true, why: 'create through createAccountingSyncLogRow (seam); the shadow row id is stamped on the batch rows' },
  { site: 'lib/connectors/xero/daily-sync.ts::resetFailedDailyBatchLogs', count: 2, consults: true, verdictCalls: 1, cutoffCalls: 2, why: 'switch off: the original status-wide reset, byte-identical; enforced: only rows decided not-SHADOW and not created before the live-from instant are reset (checked per row, and again as a clause of the write)' },
  { site: 'lib/connectors/xero/sync-processor.ts::enqueueFollowUpSyncLog', count: 2, consults: true, verdictCalls: 1, cutoffCalls: 1, why: 'revival asks xeroProducerSeamVerdict and the cut-off before the update and schedule (a held or pre-cut-off revival falls to the create path, which decides the new row on its own business-event time and leaves the FAILED row as it was); the create goes through the primitive' },
  { site: 'app/actions/xero-sync.ts::retryFailedXeroSync', count: 3, consults: true, verdictCalls: 2, cutoffCalls: 2, why: 'per-candidate verdict and cut-off check before planManualRetry; the no-candidates fenced branch reads the row and asks the seam and the cut-off before the fenced reset' },
  { site: 'lib/domain/accounting/sync-claim-fence.ts::releaseClaimForRetry', count: 1, consults: false, why: 'PROCESSING to PENDING with a future processingStartedAt: the worker already holds a claim it passed the claim-boundary gate and the cut-off floor for; the row was claimable already and its next claim asks both again (the claim statement carries the floor)' },
  { site: 'lib/connectors/xero/sync-processor.ts::reportUnrecordedXeroWrite', count: 1, consults: false, why: 'sets PENDING only AFTER Xero accepted the document and returned its id (externalTransactionId set), so that the row finishes without posting again; the send had already passed the gate' },
  { site: 'scripts/repro-scjz68.ts::seedScenario', count: 1, consults: true, why: 'raw seed of a queued row; refuses unless the hold is not enforced or the decision is LIVE' },
]

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) walk(full, out)
    else if (['.ts', '.tsx', '.mts'].includes(extname(name)) && !name.endsWith('.d.ts')) out.push(full)
  }
}

const NON_DATA_KEYS = new Set(['where', 'OR', 'AND', 'NOT', 'select', 'orderBy', 'include', 'having'])
const WRITE_METHODS = new Set(['create', 'createMany', 'update', 'updateMany', 'updateManyAndReturn', 'upsert'])
const WRITE_HELPERS = new Set(['createAccountingSyncLogRow', 'applyFencedAttemptDecision', 'stampingCustodyOnClaim'])

function isSyncLogWriteCall(call: ts.CallExpression): boolean {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return WRITE_HELPERS.has(callee.text)
  if (ts.isPropertyAccessExpression(callee)) {
    if (WRITE_HELPERS.has(callee.name.text)) return true
    return WRITE_METHODS.has(callee.name.text) && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === 'accountingSyncLog'
  }
  return false
}

function enclosingName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) && cur.name) return cur.name.getText()
    if (ts.isVariableDeclaration(cur) && cur.initializer && (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))) return cur.name.getText()
  }
  return '<module>'
}

function isPendingLiteral(expr: ts.Expression): boolean {
  let e = expr
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression
  return ts.isStringLiteral(e) && e.text === 'PENDING'
}

export type Found = { site: string; file: string; fn: string }

export function scanPendingWrites(files: Array<{ rel: string; text: string }>): Found[] {
  const found: Found[] = []
  for (const { rel, text } of files) {
    if (!/accountingSyncLog|accounting_sync_logs|AccountingSyncLog|applyFencedAttemptDecision|stampingCustodyOnClaim/.test(text)) continue
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText() === 'status' && isPendingLiteral(node.initializer)) {
        // Data only: the nearest enclosing call must be a WRITE of the sync-log table (or one of the helpers that write it), and no
        // `where` / `OR` / `AND` / `select` ... property may sit between the literal and that call.
        let data = false
        for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
          if (ts.isPropertyAssignment(cur) && NON_DATA_KEYS.has(cur.name.getText())) break
          if (ts.isCallExpression(cur)) {
            if (isSyncLogWriteCall(cur)) data = true
            break
          }
        }
        if (data) found.push({ site: `${rel}::${enclosingName(node)}`, file: rel, fn: enclosingName(node) })
      }
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const raw = node.getText()
        if (/UPDATE\s+"?accounting_sync_logs"?/i.test(raw) && /SET[\s\S]*status[\s\S]*PENDING/i.test(raw)) found.push({ site: `${rel}::${enclosingName(node)}`, file: rel, fn: enclosingName(node) })
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return found
}

function loadFiles(): Array<{ rel: string; text: string }> {
  const all: string[] = []
  for (const root of SOURCE_ROOTS) walk(join(ROOT, root), all)
  return all.map((full) => ({ rel: relative(ROOT, full), text: readFileSync(full, 'utf8') }))
}

export function reconcilePendingWrites(found: Found[], declared: readonly Declaration[]): string[] {
  const problems: string[] = []
  const counts = new Map<string, number>()
  for (const f of found) counts.set(f.site, (counts.get(f.site) ?? 0) + 1)
  for (const [site, n] of counts) {
    const d = declared.find((x) => x.site === site)
    if (!d) problems.push(`UNLISTED PENDING write x${n} at ${site}: declare it in tests/accounting/xero-pending-transition-census.test.ts and say whether it consults the producer seam (xeroProducerSeamVerdict), and why`)
    else if (d.count !== n) problems.push(`${site}: ${n} PENDING write(s) found, ${d.count} declared`)
  }
  for (const d of declared) if (!counts.has(d.site)) problems.push(`STALE declaration ${d.site}: no PENDING write found there`)
  return problems
}

/** Does the function named by a declaration ask the seam (directly or through the sync-log primitive) in its own body? */
export function functionConsultsSeam(text: string, fnName: string, verdictCalls = 0): boolean {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  let body: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) body = node
    if (ts.isVariableDeclaration(node) && node.name.getText() === fnName && node.initializer) body = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!body) return false
  const source = body.getText()
  if (verdictCalls > 0) return (source.match(/xeroProducerSeamVerdict\(/g) ?? []).length >= verdictCalls
  return /xeroProducerSeamVerdict|createAccountingSyncLogRow|producerSeamVerdict|readProducerEnforcement/.test(source)
}

/** Does the function named by a declaration apply the writer-side cut-off (xeroBeforeCutoffRefusal / xeroNotBeforeCutoffWhere) at least `calls` times in its own body? */
export function functionAppliesCutoff(text: string, fnName: string, calls: number): boolean {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  let body: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) body = node
    if (ts.isVariableDeclaration(node) && node.name.getText() === fnName && node.initializer) body = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!body) return false
  return (body.getText().match(/xeroBeforeCutoffRefusal\(|xeroNotBeforeCutoffWhere\(/g) ?? []).length >= calls
}

test('the PENDING-transition census: every sync-row PENDING write is declared, and every declared consulting site asks the seam', () => {
  const files = loadFiles()
  const found = scanPendingWrites(files)
  console.log(`# pending-transition census: ${files.length} files read, ${found.length} PENDING data writes found at ${new Set(found.map((f) => f.site)).size} sites, ${DECLARED.length} declared`)
  assert.ok(found.length >= 10, `PRECONDITION: the scan found the known writes (found ${found.length}); an empty scan would prove nothing`)
  assert.deepEqual(reconcilePendingWrites(found, DECLARED), [])
  let consulting = 0
  for (const d of DECLARED.filter((x) => x.consults)) {
    const [file, fn] = d.site.split('::') as [string, string]
    const text = files.find((f) => f.rel === file)?.text ?? ''
    // The seed script and the e2e fixture are raw SQL/INSERT sites whose enclosing function is the seam-asking one by name.
    assert.ok(functionConsultsSeam(text, fn, d.verdictCalls), `${d.site} is declared as consulting the seam but its body does not call it`)
    if (d.cutoffCalls !== undefined) assert.ok(functionAppliesCutoff(text, fn, d.cutoffCalls), `${d.site} is declared as applying the writer-side cut-off ${d.cutoffCalls} time(s) but its body does not`)
    consulting += 1
  }
  console.log(`# ${consulting} consulting sites verified to call the seam in their own body`)
  assert.ok(consulting >= 6)
})

test('the cut-off census can fail: a re-queue site that does not apply the cut-off is reported, and one that does is not', () => {
  const without = "export async function revive() { await db.accountingSyncLog.updateMany({ where: { status: 'FAILED' }, data: { status: 'PENDING' } }) }"
  const withIt = "export async function revive() { const r = xeroBeforeCutoffRefusal({ createdAt: row.createdAt }); if (r) return; await db.accountingSyncLog.updateMany({ where: { status: 'FAILED', ...xeroNotBeforeCutoffWhere(f) }, data: { status: 'PENDING' } }) }"
  assert.equal(functionAppliesCutoff(without, 'revive', 1), false)
  assert.equal(functionAppliesCutoff(withIt, 'revive', 2), true)
  assert.equal(functionAppliesCutoff(withIt, 'revive', 3), false, 'the count is a floor, not decoration')
  assert.equal(functionAppliesCutoff(withIt, 'nonexistent', 1), false)
})

test('the census can fail: an unlisted PENDING write, a stale declaration and a count mismatch are each reported', () => {
  const planted = { rel: 'lib/planted.ts', text: "import { db } from '@/lib/db'\nexport async function revive(id: string) {\n  await db.accountingSyncLog.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'PENDING' } })\n}\n" }
  const found = scanPendingWrites([planted])
  assert.equal(found.length, 1, 'PRECONDITION: the planted write is found (the where-clause FAILED is not, a data PENDING is)')
  const problems = reconcilePendingWrites(found, [])
  assert.match(problems.join('\n'), /UNLISTED PENDING write x1 at lib\/planted\.ts::revive/)
  assert.match(reconcilePendingWrites([], [{ site: 'lib/gone.ts::f', count: 1, consults: false, why: 'x' }]).join('\n'), /STALE declaration/)
  assert.match(reconcilePendingWrites(found, [{ site: 'lib/planted.ts::revive', count: 2, consults: false, why: 'x' }]).join('\n'), /1 PENDING write\(s\) found, 2 declared/)
  const readOnly = scanPendingWrites([{ rel: 'lib/ro.ts', text: "export async function f() { return db.accountingSyncLog.findMany({ where: { status: 'PENDING' } }) }" }])
  assert.equal(readOnly.length, 0, 'a PENDING in a where clause is a read, not a transition')
})
