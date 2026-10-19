/**
 * `npm run writers:check`: THE COEXISTENCE INTERLOCK. Constants and single-sourced text.
 *
 * Pure and import-light (the producer documentation blocks import this file). The evaluator is
 * lib/ops/writers-check.ts; the evidence the storefront import keeps is lib/domain/incumbent-evidence/.
 */

export const WRITERS_CHECK_COMMAND = 'npm run writers:check'
export const WRITERS_CHECK_CRON_SLUG = 'writers-check'
export const WRITERS_CHECK_RECORD_ACTION = 'writers_check_recorded'
export const WRITERS_CHECK_SCHEMA_VERSION = 1

/** How far back incumbent evidence counts when no live-from instant bounds it. */
export const WRITERS_CHECK_DEFAULT_WINDOW_DAYS = 14
export const WRITERS_CHECK_MAX_WINDOW_DAYS = 365

/** Logged when the storefront import could not keep a piece of incumbent evidence (the check is then blind to it). */
export const INCUMBENT_EVIDENCE_UNRECORDED_ACTION = 'incumbent_evidence_unrecorded'

/**
 * The closed codes of incumbent evidence a storefront order can carry. The meta VALUES are never stored.
 *
 * - MINTSOFT_ORDER_ID: the bridge plugin's warehouse order id on the order.
 * - MINTSOFT_OTHER_META: any other `_mintsoft_` meta (the bridge's split and merge bookkeeping).
 * - XEROOM_MARKER: a meta key the invoicing plugin owns (a key beginning `xeroom` or `_xeroom`).
 */
export const INCUMBENT_EVIDENCE_KINDS = ['MINTSOFT_ORDER_ID', 'MINTSOFT_OTHER_META', 'XEROOM_MARKER'] as const
export type IncumbentEvidenceKind = (typeof INCUMBENT_EVIDENCE_KINDS)[number]

/** Evidence that comes from Xero's own answer rather than from an order: a number held by a document IMS does not own. */
export const XERO_FOREIGN_NUMBER_EVIDENCE = 'XERO_FOREIGN_NUMBER' as const
export const XERO_FOREIGN_NUMBER_ACTIVITY_ACTION = 'sales_invoice_number_not_ours'
export const XERO_FOREIGN_NUMBER_REFUSAL_CODES = ['NUMBER_HELD_BY_FOREIGN_DOCUMENT', 'NUMBER_HELD_BY_MULTIPLE_DOCUMENTS'] as const

export type WritersCheckEvidenceKey = IncumbentEvidenceKind | typeof XERO_FOREIGN_NUMBER_EVIDENCE

/** Which destination operations each kind of evidence contests: IMS being able to write one of them while the evidence is current is a double claim. */
export const EVIDENCE_CONTESTS: Readonly<Record<WritersCheckEvidenceKey, readonly string[]>> = {
  MINTSOFT_ORDER_ID: ['mintsoft.order.create'],
  MINTSOFT_OTHER_META: ['mintsoft.order.create'],
  XEROOM_MARKER: ['woocommerce.order.invoice-note', 'woocommerce.order.invoice-document'],
  XERO_FOREIGN_NUMBER: ['xero.sales.invoice'],
}

/** Rows IMS must never own in any phase (the incumbent keeps SALES invoicing for good): an `IMS` owner here is a defect in the map. */
export const IMS_FORBIDDEN_OWNERSHIP_ROWS: readonly string[] = [
  'xero.sales.invoice',
  'xero.sales.invoice-update',
  'xero.sales.credit-note',
]

export type WritersCheckExitCode = { code: number; name: string; meaning: string }

export const WRITERS_CHECK_EXIT_CODES: readonly WritersCheckExitCode[] = [
  { code: 3, name: 'usage', meaning: 'an unknown or malformed argument; nothing was read' },
  { code: 5, name: 'failed', meaning: 'an unexpected error; no verdict was reached, so treat it as a failure' },
  { code: 4, name: 'evidence-gap', meaning: 'the storefront import could not keep some incumbent evidence in the window (its own log entries say how many); the check is blind to those orders' },
  { code: 2, name: 'unreadable', meaning: 'a grant, a live-from instant or the enforcement variable is set but cannot be read, a destination has a grant without a live-from instant or a live-from instant without a grant, or the settings or the evidence could not be read; no verdict can be given' },
  { code: 1, name: 'double-claim', meaning: 'two writers claim one destination operation in the current phase (IMS can write it while another writer owns it or is seen writing it), or the ownership map gives IMS a row it must never own' },
  { code: 0, name: 'ok', meaning: 'no double claim was found in the evidence IMS holds; this is not proof that none exists (see what the check cannot see)' },
]

export function renderWritersCheckExitTable(): string {
  const rows = [...WRITERS_CHECK_EXIT_CODES]
    .sort((left, right) => left.code - right.code)
    .map((row) => `| ${row.code} | ${row.name} | ${row.meaning} |`)
  return ['| Exit code | Name | Meaning |', '|---|---|---|', ...rows].join('\n')
}

/** What the check can see, and what it cannot. Printed in every report and rendered into the documentation. */
export const WRITERS_CHECK_CAN_SEE: readonly string[] = [
  'the ownership map and the phase each destination is in, from the grant and the live-from instant',
  'whether IMS itself could write each mapped operation right now: the settings, the plugin switches, the grant and the producer decision (a schedule being off is not counted as a barrier: the scheduled route does not check it and stays callable by an authenticated request)',
  'the bridge plugin\'s warehouse-order metas and the invoicing plugin\'s markers on storefront orders that IMS imported (kept at import, with the paid time, values never stored)',
  'invoice numbers Xero reported as held by a document IMS does not own, at the moment IMS tried to post under them',
]

export const WRITERS_CHECK_CANNOT_SEE: readonly string[] = [
  'an incumbent\'s activity that leaves no trace IMS reads: a write an incumbent makes without a mark on an imported order or a refusal IMS provoked is invisible, and a green result says nothing about it',
  'any order IMS has not imported (its metas are unseen until the order is imported), and any change to an order\'s metas after its last import',
  'what Qoblex, Aelia, an operator working by hand or a Mintsoft channel writes: they leave no evidence IMS reads, so for their operations only the ownership map and IMS\'s own switches are checked',
  'an order whose evidence write did not finish: the import does not wait for it, so a write that timed out and could not log that it did, or that was still running when the process stopped, leaves no trace',
  'anything that changes after the report was taken: the check is a snapshot that detects a shared destination, it does not stop either writer, so only the periodic record narrows the gap',
  'Xero documents that IMS never tried to post under (no new Xero call is made: the check reads only IMS\'s own database and environment)',
]

export const WRITERS_CHECK_BLOCK_ID = 'writers-check' as const

export function renderWritersCheckDocBlock(): string {
  return [
    `\`${WRITERS_CHECK_COMMAND} [-- --window-days N] [-- --json]\` is the coexistence interlock: it fails (non-zero) when two writers claim one destination operation in the current phase. It is read-only: it reads the environment and IMS's own database, makes no call to Xero, Mintsoft or WooCommerce, and writes nothing. For every operation in the ownership map it works out whether IMS could write it right now (the operation's settings, the plugin switch and the destination's grant all on, and, for a destination named in the enforcement variable, a producer decision that is not SHADOW), and compares that with the owner the map gives for the installation's current phase and with the incumbent evidence IMS holds. It fails when IMS can write an operation that another writer owns (an operation reached only by an operator button is a warning, stated in the report, while the map gives it to the operator, and fails like any other once the map gives it to another writer) (or that nobody has decided: an \`unknown\` owner), when the ownership map gives IMS an operation it must never own (the Xero sales documents), and when IMS can create a Mintsoft order while orders paid since the live-from instant still carry the bridge plugin's warehouse-order id. Evidence older than the live-from instant, or (with no instant) older than the window (default ${WRITERS_CHECK_DEFAULT_WINDOW_DAYS} days, \`--window-days\`), is not counted, nor is anything dated after the moment the report is taken, and an order with no readable paid time is reported but never counted, because IMS cannot create an unpaid order.`,
    '',
    renderWritersCheckExitTable(),
    '',
    `WHAT IT CAN SEE: ${WRITERS_CHECK_CAN_SEE.join('; ')}.`,
    '',
    `WHAT IT CANNOT SEE: ${WRITERS_CHECK_CANNOT_SEE.join('; ')}. Every report prints both lists.`,
    '',
    `The \`${WRITERS_CHECK_CRON_SLUG}\` scheduled job (off by default) records the same report as JSON in the activity log (action \`${WRITERS_CHECK_RECORD_ACTION}\`) each time it runs, and the run is red when the verdict is not ok. Counts only appear in the report: it carries no order id, invoice number or other data key.`,
  ].join('\n')
}

/** Every evidence key a complete reading contains. */
export const WRITERS_CHECK_EVIDENCE_KEYS_FOR_TESTS: readonly WritersCheckEvidenceKey[] = [...INCUMBENT_EVIDENCE_KINDS, XERO_FOREIGN_NUMBER_EVIDENCE]
