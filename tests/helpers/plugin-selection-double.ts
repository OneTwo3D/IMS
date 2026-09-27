import { INTEGRATION_PLUGIN_SETTING_KEYS } from '@/lib/integration-plugin-keys'

/**
 * o3d-j625 r13 — ANSWERING THE SELECTION FENCE FROM A TEST DOUBLE, ONCE.
 *
 * The locked connector check (`pinnedLedgerIsServicedUnderLock`) used to run only for a PINNED enqueue;
 * since r13 it runs on EVERY accounting enqueue, because an unpinned one whose connector is deactivated
 * between the unlocked chart read and the insert would otherwise write a row nothing can process and clear
 * the outstanding refusal with it. That means every `tx` double an enqueue test hands over now has to answer
 * the two statements the fence issues:
 *
 *   1. `SELECT pg_advisory_xact_lock(<selection key>)` and an `INSERT INTO settings … ON CONFLICT DO NOTHING`
 *      — through `$executeRaw`, which for a double is "return a number";
 *   2. `SELECT key, value FROM settings WHERE key = ANY(…) FOR UPDATE` — through `$queryRaw`, and THIS one
 *      decides the verdict. A double that answers `[]` (the shape most of them had) reports every plugin as
 *      disabled, so the fence correctly refuses and the test fails for a reason it is not about.
 *
 * THE POINT OF PUTTING IT HERE rather than inline in each file: the answer must come from the SAME place the
 * file's `isIntegrationPluginEnabled` mock answers from, or the fixture holds two disagreeing notions of
 * which connector is active and a test can pass while contradicting itself. Each caller passes its own
 * enabled-plugin list, so there is one source per file and one implementation of the row shape.
 *
 * ONLY ENABLED PLUGINS GET A ROW, and that is a correction rather than a preference. The first version of
 * this helper emitted every plugin explicitly, `'false'` included, on the grounds that "no row" and "a row
 * saying false" are the same fact to `lockIntegrationPluginSelection` — which is true of the VERDICT and
 * false of the read: tests/accounting/document-id-provenance-routing.test.ts has a case whose precondition
 * is that the locked read finds NO ROWS, and the explicit form broke it. A real database can be in either
 * state, the production parser treats them identically, and matching the sparser one keeps the fixture able
 * to express both.
 */
export function lockedPluginSelectionRows(enabled: readonly string[]): Array<{ key: string; value: string }> {
  return Object.entries(INTEGRATION_PLUGIN_SETTING_KEYS)
    .filter(([id]) => enabled.includes(id))
    .map(([, key]) => ({ key, value: 'true' }))
}

/** Whether a raw statement is the fence's locked plugin read (the one whose answer is the verdict). */
export function isLockedPluginSelectionRead(query: unknown): boolean {
  const sql = Array.isArray(query) ? (query as string[]).join(' ') : String(query)
  return /from\s+settings/i.test(sql) && /for\s+update/i.test(sql)
}
