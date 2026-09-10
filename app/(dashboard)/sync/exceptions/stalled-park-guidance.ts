/**
 * WHAT AN OPERATOR IS TOLD ABOUT A STALLED OUTBOX PARK — AS STRUCTURE, NOT AS PROSE
 * (o3d-8td2 round 7, Codex round 6 HIGH; the withdrawn action is o3d-7qdb).
 *
 * ROUND 6 SHIPPED A LIST WITH NO BUTTON AND THEN TOLD THE OPERATOR, IN THE SECTION'S OWN TEXT, TO
 * GO AND DO THE WITHDRAWN THING BY HAND. The copy read "...then use the admin outbox API to
 * dead-letter or replay the row deliberately", and that is not a smaller version of the withdrawn
 * button, it is the same act with the safety rail removed: nothing checks the operator's evidence
 * on that path either. Verified again this round, at the source:
 *
 *   `permanentlyFailIntegrationOutboxAdminRow` (lib/domain/integrations/outbox-admin.ts) writes the
 *   `integration_outbox` row and NOTHING ELSE. For Xero the work is owned by an `AccountingSyncLog`
 *   that it does not touch, so the log stays PENDING — or PROCESSING with a `processingStartedAt`
 *   that is already stale, which is precisely the shape a park has — with `retryCount < MAX_RETRIES`.
 *   `processPendingXeroSyncViaOutbox` calls `ensureXeroOutboxForPendingSyncLogs` as its FIRST
 *   statement on EVERY sweep (lib/connectors/xero/sync-processor.ts), that selects exactly such logs,
 *   and `scheduleXeroAccountingOutbox` (lib/connectors/xero/outbox.ts) resets the row it finds —
 *   `status: PENDING`, `attempts: 0`, lock cleared — because its update matches
 *   `status: { not: PROCESSING }` and PERMANENT_FAILED is in that set. `claimIntegrationOutboxWork`
 *   then takes it on the SAME sweep. The invoice is posted, and its email sent, a second time.
 *   WooCommerce reaches the same end by its ordinary enqueue path on the next stock change for the
 *   product (lib/connectors/woocommerce/sync/stock-sync-jobs.ts).
 *
 * So on a listed park, dead-letter and replay are ONE action wearing two names, and the operator's
 * check of the remote system changes nothing: no available action is conditioned on what they found.
 * Confirming the invoice was already posted and then dead-lettering the row is how you get the
 * second invoice.
 *
 * THERE IS THEREFORE NO SAFE AUTOMATED REMEDY TO NAME, AND THIS FILE NAMES NONE. What survives is a
 * read of the remote system and a correction made THERE, outside the outbox, which cannot be
 * re-queued by anything because it never enters the queue. That is weaker than a remedy and it is
 * stated as weaker.
 *
 * WHY THE GUIDANCE IS DATA AND NOT A STRING. "Does this text recommend an action that can replay?"
 * is not answerable by searching the text: the honest copy has to NAME the dangerous routes in order
 * to warn about them, so any ban on the substring is satisfied by deleting the warning, and any
 * "unless a negation is nearby" rule passes on a stale sentence sitting next to the one that
 * corrects it. Splitting the prohibition and the recommendation into separate fields makes the
 * question structural: {@link STALLED_OUTBOX_PARK_GUIDANCE.neverUseOnAListedPark} is asserted to
 * hold EVERY row-mutating admin outbox route that exists on disk, and
 * {@link STALLED_OUTBOX_PARK_GUIDANCE.doInstead} is asserted to name none of them. Moving one entry
 * from the first slot to the second fails the test, which is the mutation that matters.
 */

/**
 * Every admin HTTP route that can move an `integration_outbox` row's status.
 *
 * `tests/domain/integrations/outbox.test.ts` enumerates `app/api/admin/outbox/[id]/` and asserts
 * this list is exactly the route directories found there, so a third mutating route cannot be added
 * without either appearing in the prohibition below or failing the suite. That is what keeps the
 * warning exhaustive as the API grows, rather than a reviewer remembering to update copy.
 */
export const ADMIN_OUTBOX_ROW_MUTATION_ROUTES = [
  'POST /api/admin/outbox/[id]/permanent-fail',
  'POST /api/admin/outbox/[id]/replay',
] as const

export const STALLED_OUTBOX_PARK_GUIDANCE = {
  what:
    'Rows still marked PROCESSING under a lock older than every drain lease, on an operation no worker '
    + 'may reclaim. Nothing retries these: no drain reclaims them, the retry ladder does not apply to a '
    + 'status that never failed, and no reconcile drains the outbox. For WooCommerce stock pushes every '
    + 'later change to the same product is folded into the parked row and waits behind it.',

  whyNothingIsOffered:
    'THIS SECTION IS A LIST AND NOTHING ELSE, AND THAT IS THE FINDING RATHER THAN CAUTION: there is at '
    + 'present no safe way — in this UI or anywhere else — to resolve one of these rows from IMS. A stale '
    + 'lock does not say whether the holder died or is merely paused, nor whether its effect already '
    + 'reached the remote system, and no status the row could be moved to is inert. Marking one '
    + 'permanently failed does not stop it: the next Xero sweep rebuilds and re-queues the row from the '
    + 'sync log that was never touched, and a WooCommerce row is re-queued by the next stock change for '
    + 'that product. On a row listed here, dead-lettering and replaying are the same act — each can post '
    + 'a second invoice, send a second invoice email, or overwrite a fresh quantity with a stale one — and '
    + 'checking the remote system first does not make either safe, because neither action is conditioned '
    + 'on what you found.',

  /**
   * The prohibition slot. Exhaustive over {@link ADMIN_OUTBOX_ROW_MUTATION_ROUTES} by test — every
   * route that can move a row is named here, so the warning cannot silently fall behind the API.
   */
  neverUseOnAListedPark: ADMIN_OUTBOX_ROW_MUTATION_ROUTES,

  /**
   * The recommendation slot: the only things this section tells an operator to DO. Asserted to name
   * no admin outbox mutation, which is what makes "the guidance no longer points at the replay"
   * a property of the data rather than a reading of the prose.
   */
  doInstead: [
    'Read the remote system directly and believe it over this row: for Xero, whether the invoice exists and whether its email went out; for WooCommerce, the quantity the product actually has.',
    'If the remote system is wrong, correct it there by hand — a change made outside the queue cannot be re-queued by anything.',
    'Then escalate the row id shown here rather than trying to clear it; an operator remedy that does not rest on elapsed time is open as o3d-7qdb.',
  ],

  trackedBy: 'o3d-7qdb',
} as const

/**
 * The paragraph the section actually renders. Composed from the fields above so that the text an
 * operator reads and the structure the test reasons about cannot drift apart; the test asserts every
 * entry of both slots appears in this output.
 */
export function stalledOutboxParkGuidanceDetail(): string {
  const guidance = STALLED_OUTBOX_PARK_GUIDANCE
  return [
    guidance.what,
    guidance.whyNothingIsOffered,
    `Do not reach for these on a row listed here: ${guidance.neverUseOnAListedPark.join('; ')}.`,
    `What to do instead: ${guidance.doInstead.join(' ')}`,
  ].join(' ')
}
