import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * CENSUS: A LOOKUP OF A SYNC ROW BY ITS TOKEN OR IDEMPOTENCY KEY MUST ASK THE ROW'S STANDING.
 *
 * "A row carrying this token exists" is not "a journal will move these pounds". The producer-side hold writes a CANCELLED /
 * HELD_SHADOW row carrying the very same token and idempotency key; a terminal or operator-asserted row carries it too.
 * `assertAllocationReversalQueued` read existence as "queued" and recorded relief for a credit nobody will send.
 *
 * This fails if any production lookup of `accounting_sync_logs` by a payload token (`_reversalToken`, `_idempotencyKey`) or by
 * an `idempotencyKey` column does not have a standing marker within the same statement: the ledger-standing columns selected
 * (LEDGER_STANDING_SELECT / PRIOR_ATTEMPT_SELECT), the shared standing predicates (PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR /
 * WORK_SLOT_OCCUPIED_WHERE) or the classifiers (workSlotStanding / classifyPriorAttempts). The sites found when this was written,
 * and why each is correct, are listed in EXPECTED so a new one is a deliberate decision and not an accident.
 */
const MARKERS = ['LEDGER_STANDING_SELECT', 'PRIOR_ATTEMPT_SELECT', 'PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR', 'WORK_SLOT_OCCUPIED_WHERE', 'workSlotStanding', 'classifyPriorAttempts', 'releasedSalesInvoiceQueueWhere']
const WINDOW = 22

const EXPECTED = [
  'lib/accounting.ts', // the in-transaction enqueue's prior-attempt read: classifyPriorAttempts over PRIOR_ATTEMPT_SELECT
  'lib/connectors/xero/queue.ts', // the facade queue's prior-attempt read: the same classifier
  'lib/connectors/woocommerce/sync/order-import.ts', // confirms the held-invoice release through releasedSalesInvoiceQueueWhere (standing-aware; a shadow is answered earlier)
  'lib/connectors/woocommerce/sync/held-sales-invoice.ts', // releasedSalesInvoiceQueueWhere: live statuses or a document id
  'lib/domain/accounting/prior-posting-evidence.ts', // priorAttemptsWhere + PRIOR_ATTEMPT_SELECT, classified by classifyPriorAttempts
  'lib/domain/sales/allocation-service.ts', // assertAllocationReversalQueued: live, unasserted work slot only
  'lib/domain/sales/return-expectation-receipt.ts', // resolveClearingMode: reads the refund's COGS_REVERSAL row by key and judges it via ledgerStanding
]

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'generated' && entry.name !== 'node_modules') files(path, out); continue }
    if (/\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

test('every token / idempotency-key lookup of a sync row asks the row\'s standing, and the set of such sites is the audited one', () => {
  const found = new Map<string, number[]>()
  const unguarded: string[] = []
  for (const root of ['lib', 'app']) {
    for (const path of files(join(process.cwd(), root))) {
      const lines = readFileSync(path, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        const tokenLookup = /path:\s*\[\s*'(_reversalToken|_idempotencyKey)'\s*\]/.test(line)
        const keyLookup = /accountingSyncLog\.(findFirst|findMany|findUnique)\(/.test(line)
          && lines.slice(i, i + 8).some((l) => /\bidempotencyKey\b/.test(l) && !/^\s*(\/\/|\*)/.test(l))
        if (!tokenLookup && !keyLookup) return
        const rel = path.slice(process.cwd().length + 1)
        found.set(rel, [...(found.get(rel) ?? []), i + 1])
        const window = lines.slice(Math.max(0, i - WINDOW), i + WINDOW).join('\n')
        if (!MARKERS.some((marker) => window.includes(marker))) unguarded.push(`${rel}:${i + 1}`)
      })
    }
  }
  assert.deepEqual(unguarded, [], 'a lookup by token/key with no standing marker nearby treats a shadow as "queued"')
  assert.deepEqual([...found.keys()].sort(), [...EXPECTED].sort(), 'a new token/key lookup must be audited and added here, with the reason it is correct')
})
