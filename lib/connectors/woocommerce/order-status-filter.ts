/**
 * The `wc_sync_order_statuses` order-status filter — the rules, in one place
 * (o3d-tj6v follow-up).
 *
 * The setting is edited in Settings -> Sync -> WooCommerce as "Import order
 * statuses". Before this module it was interpreted in three different places
 * that disagreed: `syncNewWcOrders` read it, the initial import fetched a
 * hardcoded `processing,pending,on-hold`, and the Sync page parsed it a third
 * way for the checkboxes. So an operator who unticked `on-hold` still got
 * on-hold orders from the one import that runs on every new installation.
 *
 * ROUTES IT GOVERNS — every route that PULLS orders out of WooCommerce, i.e.
 * turns the selection into a `?status=<list>` query:
 *   - `initial`            — the one-off "Import Active Orders" backfill
 *   - `poll`               — the frequent live-order sweep
 *   - `reconcile`          — the cron backstop sweep
 *   - `manual_reconcile`   — the same sweep, run from the Sync page
 *
 * THE ROUTE THAT HAS NO `?status=` QUERY — the order WEBHOOK — is governed too,
 * as an ADMISSION boundary rather than a fetch filter (o3d-tj6v r3). See
 * `isWcOrderAdmittedByStatus`.
 *
 * This module is deliberately DEPENDENCY-FREE so the Sync page (a client
 * component) can share it. Anything needing the database lives in
 * `sync/order-import.ts` (`getWcPullStatuses`).
 */

/** What the Settings form seeds, and what every parse falls back to. */
export const WC_DEFAULT_SYNC_ORDER_STATUSES: readonly string[] = ['processing']

export const WC_SYNC_ORDER_STATUSES_SETTING_KEY = 'wc_sync_order_statuses'

/**
 * The PULL routes — the ones that turn the selection into a `?status=` query.
 * The webhook is absent because it has no query to build, not because the
 * selection does not reach it: see `isWcOrderAdmittedByStatus`.
 */
export type WcOrderPullRoute = 'initial' | 'poll' | 'reconcile' | 'manual_reconcile'

/**
 * WooCommerce reports `processing`, but a setting may be entered as
 * `wc-processing`. NB startsWith + slice, never lstrip-style character
 * stripping, which would turn "withdrawn" into "ithdrawn".
 */
export function normaliseWcOrderStatus(status: unknown): string {
  const value = String(status ?? '').trim().toLowerCase()
  return value.startsWith('wc-') ? value.slice(3) : value
}

/**
 * Parse the stored JSON array.
 *
 * An EMPTY array is honoured as "import nothing", not treated as unset. The old
 * inline parse fell back to the default only for a missing or blank row, so an
 * operator who unticked every box stored `[]`, which became `status=` on the
 * WooCommerce query — and an empty `status` means *any* status to the REST API.
 * Unticking everything therefore imported everything: the exact inversion of
 * the request, and the worst version of this branch's thesis, since the control
 * did not merely fail to act, it acted in reverse.
 *
 * Anything that is not a JSON array of strings (a corrupt row, a hand-edited
 * object) still falls back to the default, because that is a malformed setting
 * rather than an expressed choice.
 */
export function parseWcSyncOrderStatuses(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.trim() === '') return [...WC_DEFAULT_SYNC_ORDER_STATUSES]

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [...WC_DEFAULT_SYNC_ORDER_STATUSES]
  }
  if (!Array.isArray(parsed)) return [...WC_DEFAULT_SYNC_ORDER_STATUSES]
  if (parsed.some((entry) => typeof entry !== 'string')) return [...WC_DEFAULT_SYNC_ORDER_STATUSES]

  const cleaned: string[] = []
  for (const entry of parsed as string[]) {
    const status = normaliseWcOrderStatus(entry)
    if (status && !cleaned.includes(status)) cleaned.push(status)
  }
  return cleaned
}

/**
 * The statuses one pull route asks WooCommerce for.
 *
 * `configured` is the operator's selection; `withdrawal` is the pair of
 * customer-withdrawal statuses. Pure, so the per-route rules can be asserted
 * without a database and the Sync page can show the operator the same list the
 * importer will use.
 */
export function resolveWcPullStatuses(
  route: WcOrderPullRoute,
  configured: readonly string[],
  withdrawal: { submitted: string; approved: string },
): string[] {
  // An empty selection is a decision: fetch nothing at all. Adding the
  // reconcile/withdrawal extras to it would resurrect exactly the orders the
  // operator just excluded.
  if (configured.length === 0) return []

  const statuses = [...configured]
  const add = (status: string) => {
    const normalised = normaliseWcOrderStatus(status)
    if (normalised && !statuses.includes(normalised)) statuses.push(normalised)
  }

  // The reconcile sweeps are the backstop for an order that finished while IMS
  // was not looking, so they always include `completed`.
  if (route === 'reconcile' || route === 'manual_reconcile') add('completed')

  // o3d-e1yb [wdraw]: the live sweeps ALWAYS carry the withdrawal statuses. They
  // are the only backstop for a withdrawal whose webhook never arrived, and a
  // withdrawal that is never seen means an order the customer asked to stop
  // carries on to the warehouse. Deliberately not left to the operator's
  // selection.
  //
  // `initial` is excluded, and that is deliberate too: it runs BEFORE live sync
  // is unlocked, its own o3d-d82p guard covers the page-snapshot race, and an
  // unlinked withdrawal is skipped by importWcOrderGuarded anyway — so fetching
  // them here would only add "skipped" orders, which decideInitialImportOutcome
  // counts as progress and could turn a systemic import failure into a false
  // "complete" that unlocks live sync having imported nothing.
  if (route !== 'initial') {
    add(withdrawal.submitted)
    add(withdrawal.approved)
  }

  return statuses
}

/**
 * Whether a PUSHED WooCommerce order may be CREATED in IMS — the webhook half of the
 * `wc_sync_order_statuses` selection (o3d-tj6v r3).
 *
 * ROUND 2 EXEMPTED THE WEBHOOK ENTIRELY AND SAID SO IN THE UI. Saying so is not honouring it: the
 * checkbox is labelled "Import order statuses", the operator unticks `pending`, and pending orders
 * carried on being imported — on the route that, with webhooks enabled, is how almost every order
 * arrives. A control that is advertised and not enforced is the exact defect this branch exists to
 * remove, so the selection now governs the webhook as well.
 *
 * The part of round 2's reasoning that WAS right is kept by scoping the rule to ADMISSION. The real
 * hazard it named is IMS silently disagreeing with the store about an order IMS already holds — an
 * order that ships and then moves to a status the operator excluded must not stop updating. So:
 *
 *   - an order IMS ALREADY HAS is never gated. Updates always apply, whatever the status. This
 *     predicate is not even consulted for one (see the caller in webhooks.ts).
 *   - an order IMS HAS NEVER SEEN is created only if its CURRENT status is admitted.
 *
 * That is also what answers round 2's other objection — "an order that later moved into an admitted
 * status would arrive with no `order.created` behind it". It does not need one. The `order.updated`
 * payload is the full order, `importWcOrder` creates from it exactly as it creates from a fetch, and
 * the status it carries is the admitted one. The order joins IMS at the moment it becomes eligible,
 * which is what the operator asked for.
 *
 * WITHDRAWAL STATUSES ARE ADMITTED WHATEVER THE SELECTION, exactly as `resolveWcPullStatuses` adds
 * them to every live sweep and for the same reason (o3d-e1yb): a withdrawal that is never seen means
 * an order the customer asked to stop carries on to the warehouse. `importWcOrderGuarded` still
 * decides what to do with one.
 *
 * AN EMPTY SELECTION ADMITS NOTHING — including withdrawals — because that is precisely what
 * `resolveWcPullStatuses` does with an empty list, short-circuiting before the withdrawal statuses
 * are added. Empty means "import nothing" on every route or it means nothing at all.
 */
export function isWcOrderAdmittedByStatus(
  status: unknown,
  configured: readonly string[],
  withdrawal: { submitted: string; approved: string },
): boolean {
  if (configured.length === 0) return false

  const normalised = normaliseWcOrderStatus(status)
  // An order with no usable status is not admitted. Treating it as admitted would make a malformed
  // payload the one way past the boundary.
  if (!normalised) return false

  // Normalised on BOTH sides. `configured` is normally the output of parseWcSyncOrderStatuses, which
  // already normalises, but this function is pure and callers may pass a raw list.
  if (configured.some((entry) => normaliseWcOrderStatus(entry) === normalised)) return true

  return normalised === normaliseWcOrderStatus(withdrawal.submitted)
    || normalised === normaliseWcOrderStatus(withdrawal.approved)
}

/**
 * The message shown when the selection is empty. Shared so the Sync page, the
 * initial import and the sweeps all say the same thing about the same setting.
 */
export const WC_NO_STATUSES_SELECTED_MESSAGE =
  'No order statuses are selected under Sync -> WooCommerce -> Order Sync -> "Import order statuses", '
  + 'so there is nothing to import. Tick at least one status to import orders.'
