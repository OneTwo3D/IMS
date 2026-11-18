import type { db } from '@/lib/db'
import type { MixedScope } from '@/lib/domain/wms/mixed-scope'

/**
 * Record the outcome of a scope check on the push link (see WmsOrderPushLink.scope*).
 *
 *  - FULL / MIXED: the part that was just SENT. A scope that differs from the recorded one (or the first) becomes the next version, with its line
 *    snapshot; the same scope only refreshes the check time. A previous freeze is lifted.
 *  - HOLD: nothing was sent; the check is stamped.
 *  - REFUSED / EMPTY: nothing can be sent; the link is marked frozen with the reason (retryable, lifted by the next sendable scope).
 *
 * The dirty mark is cleared only when it was set at or before `readAt`: an allocation change made while the scope was being read or sent stays dirty and is
 * seen by the next amend pass.
 */
export async function recordMixedScopeOutcome(client: typeof db, orderId: string, scope: MixedScope, readAt: Date): Promise<void> {
  await client.$transaction(async (tx) => {
    const link = await tx.wmsOrderPushLink.findUnique({ where: { orderId }, select: { id: true, scopeMode: true, scopeVersion: true, scopeHash: true, scopeFrozenAt: true, scopeFrozenReason: true } })
    if (!link) return
    if (scope.mode === 'HOLD') {
      await tx.wmsOrderPushLink.update({ where: { id: link.id }, data: { scopeCheckedAt: readAt } })
    } else if (scope.mode === 'REFUSED' || scope.mode === 'EMPTY') {
      await tx.wmsOrderPushLink.update({
        where: { id: link.id },
        data: {
          scopeCheckedAt: readAt,
          // A permanent past-NEW freeze is never downgraded to the retryable kind.
          ...(link.scopeFrozenReason === 'NOT_NEW' ? {} : { scopeFrozenAt: link.scopeFrozenAt ?? readAt, scopeFrozenReason: scope.mode === 'REFUSED' ? `UNSENDABLE:${scope.code}` : 'UNSENDABLE:EMPTY' }),
        },
      })
    } else {
      const hash = scope.mode === 'MIXED' ? scope.hash : null
      const changed = link.scopeVersion === 0 || link.scopeMode !== scope.mode || link.scopeHash !== hash
      const version = changed ? link.scopeVersion + 1 : link.scopeVersion
      await tx.wmsOrderPushLink.update({
        where: { id: link.id },
        data: {
          scopeMode: scope.mode,
          scopeVersion: version,
          scopeHash: hash,
          scopeCheckedAt: readAt,
          scopeFrozenAt: null,
          scopeFrozenReason: null,
          scopeDiscountMinor: scope.mode === 'MIXED' ? scope.discountMinor : null,
          scopeShippingMinor: scope.mode === 'MIXED' ? scope.shippingMinor : null,
          scopeVatMinor: scope.mode === 'MIXED' ? scope.vatMinor : null,
        },
      })
      if (scope.mode === 'MIXED' && changed) {
        await tx.wmsOrderPushScopeLine.createMany({
          data: scope.lines.map((line) => ({ linkId: link.id, scopeVersion: version, orderLineId: line.lineId, sku: line.sku, quantity: line.quantity })),
          skipDuplicates: true,
        })
      }
    }
    await tx.wmsOrderPushLink.updateMany({ where: { id: link.id, scopeDirtyAt: { lte: readAt } }, data: { scopeDirtyAt: null } })
  })
}
