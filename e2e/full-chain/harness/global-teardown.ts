/**
 * Playwright globalTeardown for the full-chain tier (o3d-lgo.4).
 *
 * Separate module because Playwright resolves globalSetup/globalTeardown as distinct
 * default-export entry points.
 *
 * This runs AFTER failures too — which is the whole reason the lock lives here rather
 * than in a fixture. A held lock leaves stage disabled and silently not importing.
 */
import { release } from './quiesce.ts'
import { voidTrackedDocuments, findStragglers } from './xero.ts'

export default async function globalTeardown(): Promise<void> {
  // Xero first: the documents are the thing that pollutes the SHARED Demo ledger and
  // skews the next run's reconciliation assertions (X-02).
  try {
    const { voided, failed } = await voidTrackedDocuments()
    if (voided) console.log(`[full-chain] voided ${voided} Xero document(s)`)
    if (failed.length) {
      console.warn(`[full-chain] ${failed.length} Xero document(s) could NOT be voided — they remain in the Demo ledger.`)
    }
  } catch (e) {
    console.warn(`[full-chain] Xero teardown failed: ${e instanceof Error ? e.message : e}`)
  }

  // Report anything an earlier run abandoned. Read-only on purpose: voiding a document
  // nobody expects to disappear is worse than naming it.
  try {
    const strays = await findStragglers()
    if (strays.length) {
      console.warn(`[full-chain] stragglers from earlier runs still in the ledger:\n  ${strays.join('\n  ')}`)
    }
  } catch { /* diagnostics only */ }

  // The lock LAST, and loudly on failure: stage stays disabled until it is released.
  try {
    await release()
  } catch (e) {
    console.error(
      `\n[full-chain] *** FAILED TO RELEASE THE QUIESCE LOCK ***\n` +
        `${e instanceof Error ? e.message : e}\n` +
        `STAGE IS STILL DISABLED — not importing Woo orders, not posting to Xero.\n` +
        `Run: NODE_OPTIONS='--import tsx' node --env-file=.env scripts/restore-stage-connectors.ts\n`,
    )
    throw e
  }
}
