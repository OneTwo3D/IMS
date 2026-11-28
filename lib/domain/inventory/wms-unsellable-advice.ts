/**
 * WHAT TO DO WITH AN UNSELLABLE UNIT THAT IS AT THE 3PL (switch return_condition_check_enabled). Pure, no imports, so the restock dialog can
 * show the same words the server refuses with (the dashboard hands the dialog the route the server computed, `wmsWriteOffRoute`).
 *
 * Quarantine is kept in IMS only, so a unit held at the 3PL is never quarantined: it is restocked as Sellable into the bound warehouse (which
 * also clears a refund's return in transit) and written off, promptly. WHO books the write-off depends on the binding:
 *  - ALIGNED: the binding aligns IMS to the warehouse system (ALIGN_TO_WMS) AND align-down can run (binding and connection active, alignment
 *    confirmed, an active align-down reason with an account, thresholds set, the inventory account mapped where the reason-cost rule needs
 *    it). The 3PL writes the unit off there; a later stock sync, once it has seen the same difference twice, aligns IMS down under the
 *    align-down reason. An IMS adjustment as well would be undone: the next sync books it back as a stock gain.
 *  - ALIGNED_MANUAL: aligned, but align-down cannot run (`why` says what is missing). The 3PL writes it off there AND IMS is adjusted by
 *    hand, which also clears the discrepancy.
 *  - IMS_MASTER: NOTIFICATION_ONLY or DISABLED, or the binding/connection is inactive (nothing aligns). A real write-off at the 3PL and an
 *    IMS stock adjustment.
 *  - UNKNOWN: no binding known, or several that disagree. Both routes are given.
 * Either way the units leave at FIFO cost (the warehouse's oldest open layers), not necessarily at the returned unit's own layer.
 */

export type WmsStockMode = 'ALIGNED' | 'ALIGNED_MANUAL' | 'IMS_MASTER' | 'UNKNOWN'

export type WmsWriteOffRoute = { mode: WmsStockMode; /** ALIGNED_MANUAL only: why align-down cannot run. */ why?: string }

/** What decides the route for one binding, as read by the server. */
export type WmsBindingWriteOffFacts = {
  stockSyncMode: string | null | undefined
  active: boolean
  connectionActive: boolean
  alignmentConfirmed: boolean
  alignDownReason: { active: boolean; accountCode: string | null } | null
  thresholdsConfigured: boolean
  /** True when the reason-cost rule is on and no inventory account is mapped: align-down would hold the write-off. */
  inventoryAccountMissing: boolean
}

/** The route for one binding. Pure. */
export function wmsWriteOffRoute(facts: WmsBindingWriteOffFacts | null | undefined): WmsWriteOffRoute {
  if (!facts) return { mode: 'UNKNOWN' }
  if (!facts.active || !facts.connectionActive) return { mode: 'IMS_MASTER' }
  if (facts.stockSyncMode === 'NOTIFICATION_ONLY' || facts.stockSyncMode === 'DISABLED') return { mode: 'IMS_MASTER' }
  if (facts.stockSyncMode !== 'ALIGN_TO_WMS') return { mode: 'UNKNOWN' }
  const why = !facts.alignmentConfirmed
    ? 'its alignment is not confirmed yet (dry run)'
    : !facts.alignDownReason
      ? 'it has no align-down reason'
      : !facts.alignDownReason.active
        ? 'its align-down reason is inactive'
        : !facts.alignDownReason.accountCode
          ? 'its align-down reason has no account'
          : !facts.thresholdsConfigured
            ? 'it has no discrepancy thresholds'
            : facts.inventoryAccountMissing
              ? 'no inventory account is mapped'
              : null
  return why ? { mode: 'ALIGNED_MANUAL', why } : { mode: 'ALIGNED' }
}

/** One route for several bindings: theirs when they agree, else UNKNOWN. */
export function combineWmsWriteOffRoutes(routes: readonly WmsWriteOffRoute[]): WmsWriteOffRoute {
  if (routes.length === 0) return { mode: 'UNKNOWN' }
  const first = routes[0]
  return routes.every((r) => r.mode === first.mode && r.why === first.why) ? first : { mode: 'UNKNOWN' }
}

const PROMPTLY = 'Do it promptly: until it is written off the unit still counts as sellable stock.'

const ADJUST_IN_IMS = 'write it off in IMS with a stock adjustment in that warehouse (a reason mapped to your write-off account)'

function routeAdvice(route: WmsWriteOffRoute): string {
  switch (route.mode) {
    case 'ALIGNED':
      return 'This warehouse is aligned to the warehouse system, so have the 3PL write the unit off there (or confirm the warehouse system does not count it): a later stock sync, once it has seen the same difference twice, aligns IMS down and books the write-off under the binding\'s align-down reason (mapped to your write-off account). Do not also make a stock adjustment in IMS: the next sync would book it back as a stock gain, leaving an extra write-off and gain in the ledger. Align-down can still hold a difference (one larger than the thresholds, stock reserved for orders, open goods-in or a despatch not yet recorded), so if the stock does not come down, check the open discrepancies.'
    case 'ALIGNED_MANUAL':
      return `This warehouse is aligned to the warehouse system, but its stock sync cannot write the unit off by itself (${route.why ?? 'align-down cannot run'}). Have the 3PL write the unit off there (or confirm the warehouse system does not count it), then ${ADJUST_IN_IMS}; that also clears the discrepancy.`
    case 'IMS_MASTER':
      return `IMS is the stock master for this warehouse (or its binding is inactive), so nothing books the write-off for you: have the 3PL make a real write-off in the warehouse system (or confirm it does not count the unit), and ${ADJUST_IN_IMS}.`
    default:
      return `How it is written off depends on the warehouse's binding: if its stock is aligned to the warehouse system and align-down can run, the 3PL writes it off there and a later stock sync books it in IMS under the align-down reason (do not also adjust in IMS); otherwise the 3PL writes it off there and you ${ADJUST_IN_IMS}.`
  }
}

/** The write-off half of the advice for a route. */
export function wmsUnsellableWriteOffAdvice(route: WmsWriteOffRoute): string {
  return `${routeAdvice(route)} The write-off is valued at FIFO (the warehouse's oldest open layers), not necessarily at the returned unit's own layer. ${PROMPTLY}`
}

/** The returns-inbox refusal for an UNSELLABLE unit held at the 3PL. */
export function wmsUnsellableReturnRefusal(route: WmsWriteOffRoute): string {
  return `This return is at the 3PL warehouse, and quarantine is kept in IMS only: the warehouse system would still count the unit, and stock alignment would book it into the bound warehouse a second time. Restock it as Sellable into the bound warehouse instead (that also clears a return in transit). ${wmsUnsellableWriteOffAdvice(route)} Nothing was recorded.`
}

/** The refund-dialog refusal for an UNSELLABLE return of units that shipped from a WMS-bound warehouse. */
export function wmsUnsellableRefundRefusal(route: WmsWriteOffRoute): string {
  return `These units shipped from a 3PL warehouse (bound to the warehouse system), so they go back to the 3PL, and quarantine is kept in IMS only: the warehouse system would count them again and stock alignment would book them into the bound warehouse a second time. Record the refund as Sellable into that warehouse (or with no stock return). ${wmsUnsellableWriteOffAdvice(route)} Nothing was recorded.`
}
