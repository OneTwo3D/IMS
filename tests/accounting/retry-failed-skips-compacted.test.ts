import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-nepa (Codex NO-SHIP #2, second half) — "RETRY FAILED" MUST NOT REVIVE A COMPACTED ROW.
 *
 * The finding was that retention destroys a request body some path later re-drives without rebuilding
 * it. planFollowUpEnqueue is one such path, and the money-moving follow-up types are excluded from
 * compaction for it. The OTHER path is the blunt one: retryFailedXeroSync / retryFailedQuickBooksSync
 * flip EVERY FAILED row on the connector back to PENDING — no age bound, no type bound — and the
 * processor then posts whatever the payload holds. For a compacted row that is a stub with no lines,
 * no contact and no amounts: at best an instant re-failure that overwrites the real error with a
 * meaningless one, at worst a junk document in the ledger.
 *
 * That guard is what makes the compaction rule sound for every type OUTSIDE the money-moving set, so
 * it is pinned here rather than left to review.
 */

// Reset to EMPTY OBJECTS rather than undefined: assigning undefined narrows the field for the
// rest of the block, and the mocked client that repopulates it is opaque to the compiler, so the
// later property reads would land on `never`.
type CapturedWhere = Record<string, unknown>
const capture: { where: CapturedWhere; countWhere: CapturedWhere; description: string } = {
  where: {},
  countWhere: {},
  description: '',
}

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ id: 'u1', role: 'ADMIN' }),
    requireFreshPermission: async () => ({ id: 'u1', role: 'ADMIN' }),
    requireRole: async () => ({ id: 'u1', role: 'ADMIN' }),
    requireAuth: async () => ({ id: 'u1', role: 'ADMIN' }),
    freshAuthFailureResult: () => ({ success: false, error: 'stale' }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { description?: string }) => {
      capture.description = entry.description ?? ''
    },
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: {
        updateMany: async ({ where }: { where: Record<string, unknown> }) => {
          capture.where = where
          return { count: 2 }
        },
        count: async ({ where }: { where: Record<string, unknown> }) => {
          capture.countWhere = where
          return 3
        },
      },
    },
  },
})

for (const connector of ['xero', 'quickbooks'] as const) {
  test(`o3d-nepa: the ${connector} "retry failed" action refuses to revive a retention-compacted row`, async () => {
    capture.where = {}
    capture.countWhere = {}
    capture.description = ''

    const retry = connector === 'xero'
      ? (await import('@/app/actions/xero-sync')).retryFailedXeroSync
      : (await import('@/app/actions/quickbooks-sync')).retryFailedQuickBooksSync

    const result = await retry()

    // Read through explicitly typed locals: the `= undefined` resets above narrow the captured
    // fields, and the mocked client that repopulates them is opaque to the compiler.
    assert.equal(result.success, true)
    assert.equal(capture.where.status, 'FAILED')
    assert.equal(capture.where.connector, connector)
    // The whole point: a row whose request body retention has already removed is not eligible.
    assert.equal(capture.where.compactedAt, null, 'compacted rows must be excluded from the reset')
    // ...and the operator is told why the reset was short, since those rows still read FAILED on the
    // dashboard and a silently short reset makes the button look broken.
    assert.deepEqual(capture.countWhere.compactedAt, { not: null })
    assert.match(String(capture.description), /3 skipped/)
  })

  test(`o3d-nepa: the ${connector} single-entry retry carries the same guard`, async () => {
    capture.where = {}
    const retry = connector === 'xero'
      ? (await import('@/app/actions/xero-sync')).retryFailedXeroSync
      : (await import('@/app/actions/quickbooks-sync')).retryFailedQuickBooksSync

    await retry('entry-1')

    assert.equal(capture.where.id, 'entry-1')
    assert.equal(capture.where.compactedAt, null, 'retrying ONE compacted entry is the same hazard as retrying all of them')
  })
}
