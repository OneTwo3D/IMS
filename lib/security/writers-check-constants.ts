/**
 * `npm run writers:check`: THE COEXISTENCE INTERLOCK. Constants and single-sourced text.
 *
 * Pure and import-light (the producer documentation blocks import this file). The evaluator is
 * lib/ops/writers-check.ts; the evidence the storefront import keeps is lib/domain/incumbent-evidence/.
 */

import { WRITER_OWNERSHIP_MAP, type LiveWriterStep, type OwnershipRow } from './writer-ownership-map'

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

/** `<destination>.<operation>` of every row the BRIDGE owns in P1 and IMS takes over in P2: what bridge evidence contests. Derived from the map, never written by hand. */
export function deriveBridgeContests(map: readonly OwnershipRow[] = WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]): string[] {
  return map.filter((row) => row.owners.P1 === 'woo-mintsoft-plugin' && row.owners.P2 === 'IMS').map((row) => `${row.destination}.${row.operation}`)
}

/** The rows Xeroom owns in P1 and IMS takes over in P2 (the WooCommerce invoice note and document). Derived from the map. */
export function deriveXeroomContests(map: readonly OwnershipRow[] = WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]): string[] {
  return map.filter((row) => row.owners.P1 === 'xeroom' && row.owners.P2 === 'IMS').map((row) => `${row.destination}.${row.operation}`)
}

/**
 * Which destination operations each kind of evidence contests: IMS being able to write one of them while the evidence is current is a double claim.
 *
 * DERIVED FROM THE MAP. The bridge kinds contest every row the bridge owns in P1 and IMS owns in P2 (not just order creation: the bridge sweep also wrote
 * the WooCommerce status, tracking and partial shipments). XEROOM_MARKER contests nothing: Xeroom marks every order it invoices, for good, so the marker
 * cannot say it is still writing the note; that is XEROOM_NOTE's evidence (the note itself, dated). The foreign-number evidence is Xero's own answer.
 */
export const EVIDENCE_CONTESTS: Readonly<Record<WritersCheckEvidenceKey, readonly string[]>> = {
  MINTSOFT_ORDER_ID: deriveBridgeContests(),
  MINTSOFT_OTHER_META: deriveBridgeContests(),
  XEROOM_MARKER: [],
  XERO_FOREIGN_NUMBER: ['xero.sales.invoice'],
}

/** The switchover step whose live-from instant bounds each kind of order evidence (it counts from that instant). */
export const EVIDENCE_KIND_STEP: Readonly<Record<WritersCheckEvidenceKey, LiveWriterStep>> = {
  MINTSOFT_ORDER_ID: 'mintsoft',
  MINTSOFT_OTHER_META: 'mintsoft',
  XEROOM_MARKER: 'xero',
  XERO_FOREIGN_NUMBER: 'xero',
}

// ---------------------------------------------------------------------------------------------
// Per-step phases and the step evidence
// ---------------------------------------------------------------------------------------------

/** The installation phases: P1 (no step live) and, once a step is live, the latest live step. */
export const WRITERS_CHECK_PHASES = ['P1', 'P2-M', 'P2-W', 'P2-X'] as const
export type WritersCheckPhase = (typeof WRITERS_CHECK_PHASES)[number]

export const PHASE_OF_LIVE_STEP: Readonly<Record<LiveWriterStep, WritersCheckPhase>> = { mintsoft: 'P2-M', woocommerce: 'P2-W', xero: 'P2-X' }

/**
 * The evidence about the INCUMBENTS' stopping that is not an imported order mark. Each has a source; a source that does not exist yet reads
 * `not-built`, which FAILS the check in every phase that requires the kind (it never passes vacuously).
 *
 *   BRIDGE_ATTESTATION        the bridge host's units are masked and inactive, last trigger before the live-from instant (a status script run on the host)
 *   BRIDGE_PROBE              the companion plugin reports the bridge plugin's routes unregistered, its switches off, webhook disabled, no jobs queued
 *   MINTSOFT_FOREIGN_ORDER    Mintsoft orders created at or after the live-from instant that IMS has no link for
 *   QOBLEX_STOCK_PUSH_STOPPED the owner's confirmation (a WriterAttestation) that Qoblex's stock push to WooCommerce is stopped
 *   STOCK_DRIFT               a WooCommerce stock change not explained by an order or refund after the confirmation
 *   QOBLEX_XERO_STOPPED       the owner's confirmation (a WriterAttestation) that Qoblex's native Xero posting is stopped
 *   XEROOM_NOTE               Xeroom's order note is still on (the probe reads the option o3d_xeroom_order_note_off, which must be on at step X)
 *   NATIVE_EMAIL_EXCLUSIVE    WooCommerce's native customer e-mails (processing, completed) and IMS's storefront customer e-mail switch are mutually exclusive, JUDGED PER E-MAIL:
 *                             each needs exactly one sender (not both on = duplicate, not both off = nobody sends). The IMS switch on before step W is flagged in every
 *                             phase. Read from the store's e-mail settings; a store that does not answer is `unreadable`
 */
export const STEP_EVIDENCE_KINDS = [
  'BRIDGE_ATTESTATION', 'BRIDGE_PROBE', 'MINTSOFT_FOREIGN_ORDER',
  'QOBLEX_STOCK_PUSH_STOPPED', 'STOCK_DRIFT',
  'QOBLEX_XERO_STOPPED', 'XEROOM_NOTE',
  'NATIVE_EMAIL_EXCLUSIVE',
] as const
export type StepEvidenceKind = (typeof STEP_EVIDENCE_KINDS)[number]

/** The step from which a kind is REQUIRED (the check needs it in that phase and every later one). */
export const STEP_EVIDENCE_REQUIRED_FROM: Readonly<Record<StepEvidenceKind, LiveWriterStep>> = {
  BRIDGE_ATTESTATION: 'mintsoft',
  BRIDGE_PROBE: 'mintsoft',
  MINTSOFT_FOREIGN_ORDER: 'mintsoft',
  QOBLEX_STOCK_PUSH_STOPPED: 'woocommerce',
  STOCK_DRIFT: 'woocommerce',
  QOBLEX_XERO_STOPPED: 'xero',
  XEROOM_NOTE: 'xero',
  NATIVE_EMAIL_EXCLUSIVE: 'woocommerce',
}

/** Kinds that are an owner/host attestation, with the step whose live-from instant the attestation must precede. */
export const STEP_ATTESTATION_BEFORE_STEP: Readonly<Partial<Record<StepEvidenceKind, LiveWriterStep>>> = {
  QOBLEX_STOCK_PUSH_STOPPED: 'woocommerce',
  QOBLEX_XERO_STOPPED: 'xero',
}

export const STEP_EVIDENCE_LABEL: Readonly<Record<StepEvidenceKind, string>> = {
  BRIDGE_ATTESTATION: 'the bridge host attestation (units masked and inactive)',
  BRIDGE_PROBE: 'the companion-plugin probe of the bridge plugin',
  MINTSOFT_FOREIGN_ORDER: 'the foreign Mintsoft order reader',
  QOBLEX_STOCK_PUSH_STOPPED: 'the owner\'s confirmation that the Qoblex stock push is stopped',
  STOCK_DRIFT: 'the WooCommerce stock-drift observer',
  QOBLEX_XERO_STOPPED: 'the owner\'s confirmation that Qoblex\'s Xero posting is stopped',
  XEROOM_NOTE: 'the Xeroom order-note switch (read by the companion-plugin probe)',
  NATIVE_EMAIL_EXCLUSIVE: 'the WooCommerce native customer e-mail state against the IMS storefront customer e-mail switch (exactly one of the two sends)',
}

/**
 * Host reports: the step whose live-from instant S the report's LAST TRIGGER must precede. Unlike an owner's confirmation, the report is NOT required to
 * be recorded before S: the runbook records S when the units are masked and takes the report AFTER it (a report taken later still shows them masked and
 * idle, which is the fact), so the rule is about when the incumbent last ran, not about when the report was pasted.
 * BUT the report must DESCRIBE THE HOST AFTER S: both its own `generated_at` and the time it was recorded must be at or after S. A report taken before S (a
 * rehearsal mask, then unmasked) shows nothing about the bridge running up to and past S, and would otherwise stay "clean" indefinitely.
 */
export const STEP_REPORT_TRIGGER_BEFORE_STEP: Readonly<Partial<Record<StepEvidenceKind, LiveWriterStep>>> = {
  BRIDGE_ATTESTATION: 'mintsoft',
}

/** The attestation kind (WriterAttestation.kind) behind each attestation-backed evidence kind that a source exists for. */
export const STEP_EVIDENCE_ATTESTATION_KIND: Readonly<Partial<Record<StepEvidenceKind, string>>> = {
  QOBLEX_STOCK_PUSH_STOPPED: 'qoblex-stock-push-stopped',
  QOBLEX_XERO_STOPPED: 'qoblex-xero-stopped',
}

/** The closed violation codes of the NATIVE_EMAIL_EXCLUSIVE reader (the per-e-mail ones are suffixed `:<woo e-mail id>`). */
export const NATIVE_EMAIL_VIOLATION = {
  bothOn: 'native-and-ims-customer-email-both-on',
  bothOff: 'native-and-ims-customer-email-both-off',
  imsOnBeforeStepW: 'ims-customer-email-on-before-step-w',
} as const

/** What a reader answers for one step-evidence kind. */
export type StepEvidenceReading =
  /** The source of this evidence does not exist yet. Fails closed wherever the kind is required. */
  | { state: 'not-built' }
  /** The reader's step is not live yet, so it asked nothing. Never a pass: where the evaluator requires the kind it FAILS (the reader and the evaluator disagree about the step). */
  | { state: 'not-due' }
  /** The source exists but did not answer. Fails closed in every phase. */
  | { state: 'not-probed' }
  | { state: 'unreadable' }
  /** An attestation kind with none recorded. */
  | { state: 'absent' }
  | { state: 'present'; at: string
      /** A host report (BRIDGE_ATTESTATION): the violated expectations of the report itself, by closed code (empty or absent = clean). */
      violations?: readonly string[]
      /** A host report: the instant of the latest trigger the report shows, or null for `never`. Judged against the step's live-from instant by the evaluator. */
      lastTriggerAt?: string | null
      /** A host report: the instant the report says it was generated. The evaluator requires it, and the attestation time, to be at or after the step's live-from instant. */
      generatedAt?: string }
  /** A count of offending rows since `floor`. */
  | { state: 'counted'; counted: number; floor: string }
  /** A probe that answered: the violated expectations, by closed code (empty = clean). */
  | { state: 'probed'; violations: readonly string[] }

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
  { code: 6, name: 'step-gap', meaning: 'the switchover steps are not consistent or not ready: a step is live before the one it follows, a live step has no grant for a destination its rows write, IMS owns an operation in this phase but its switch is off or no writer exists (no-writer gap), or an owner or host attestation a live step needs is missing or later than the step' },
  { code: 2, name: 'unreadable', meaning: 'a grant, a live-from instant or the enforcement variable is set but cannot be read, a destination has a grant without a live-from instant or a live-from instant without a grant, the evidence table holds a row of a kind this version does not know, or the settings or the evidence could not be read, or a step evidence source the current phase requires is not built (\'evidence source not built\') or did not answer (\'not-probed\'); no verdict can be given' },
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
  'the ownership map and the phase of each switchover step (P1, then P2-M, P2-W, P2-X), from the grants and the per-step live-from instants',
  'the owner\'s confirmations that Qoblex\'s stock push and Qoblex\'s Xero posting are stopped (the writer attestations IMS holds)',
  'whether IMS itself could write each mapped operation right now: the settings, the plugin switches, the grant and the producer decision (a schedule being off is not counted as a barrier: the scheduled route does not check it and stays callable by an authenticated request)',
  'the bridge plugin\'s warehouse-order metas and the invoicing plugin\'s markers on storefront orders that IMS imported (kept at import, with the paid time, values never stored)',
  'invoice numbers Xero reported as held by a document IMS does not own, at the moment IMS tried to post under them',
]

export const WRITERS_CHECK_CANNOT_SEE: readonly string[] = [
  'an incumbent\'s activity that leaves no trace IMS reads: a write an incumbent makes without a mark on an imported order or a refusal IMS provoked is invisible, and a green result says nothing about it',
  'any order IMS has not imported (its metas are unseen until the order is imported), and any change to an order\'s metas after its last import',
  'what Qoblex, Aelia, an operator working by hand or a Mintsoft channel writes: they leave no evidence IMS reads, so for their operations only the ownership map, IMS\'s own switches and the owner\'s confirmations are checked',
  'whether the bridge host\'s systemd units are stopped: that is seen only through the status report an administrator pasted into writers:attest (the status script lives in the bridge repository; a snapshot: a unit unmasked afterwards is invisible until the report is repeated; and the report is plain pasted text, the owner\'s word plus a transcript, NOT evidence signed by the host: anyone who can feed a paste to writers:attest can type a passing report, and the one-hour freshness limit stops accidents, not forgery), and until one is recorded the check FAILS from step M on',
  'anything the companion-plugin probe, the foreign-order reader and the stock-drift observer cannot read: each is only as current as its last run (the probe and the reader run when the check runs; the drift observer runs hourly from the host scheduler and the check asks for a recent complete run), and a source that does not answer FAILS the check',
  'an order whose evidence write did not finish: the import does not wait for it, so a write that timed out and could not log that it did, or that was still running when the process stopped, leaves no trace',
  'anything that changes after the report was taken: the check is a snapshot that detects a shared destination, it does not stop either writer, so only the periodic record narrows the gap',
  'Xero documents that IMS never tried to post under (no Xero call is made: the check reads IMS\'s own database and environment, and, from step M, the two GET reads named above)',
]

export const WRITERS_CHECK_BLOCK_ID = 'writers-check' as const

export function renderWritersCheckDocBlock(): string {
  return [
    `\`${WRITERS_CHECK_COMMAND} [-- --window-days N] [-- --json]\` is the coexistence interlock: it fails (non-zero) when two writers claim one destination operation in the current phase. It is read-only: it reads the environment and IMS's own database and writes nothing. It makes no call to Xero; once a switchover step is live it makes GET reads: the companion plugin's \`/incumbents\` probe (step M and later, and again for Xeroom's note at step X) and Mintsoft's order list for the client (step M and later), and, in step W and later, the store's own e-mail settings (WooCommerce native processing and completed e-mails), to show that WooCommerce and IMS do not both send customer e-mail; before then it makes no vendor call at all. For every operation in the ownership map it works out whether IMS could write it right now (the operation's settings, the plugin switch and the destination's grant all on, and, for a destination named in the enforcement variable, a producer decision that is not SHADOW), and compares that with the owner the map gives for the installation's current phase and with the incumbent evidence IMS holds. It fails when IMS can write an operation that another writer owns (an operation reached only by an operator button is a warning, stated in the report, while the map gives it to the operator, and fails like any other once the map gives it to another writer) (or that nobody has decided: an \`unknown\` owner), when the ownership map gives IMS an operation it must never own (the Xero sales documents), and when IMS can write any operation the bridge plugin owned (the Mintsoft order, product and WooCommerce fulfilment operations, derived from the map) while orders paid since step M's live-from instant still carry the bridge plugin's warehouse-order id.

PHASES ARE PER SWITCHOVER STEP. Each operation in the map names the step that moves it to IMS, and each step has its own live-from instant, so the installation is in P1 (no step live) or the latest live step: P2-M (Mintsoft, with the bridge's WooCommerce writeback), P2-W (WooCommerce stock, webhooks and customer e-mail) or P2-X (Xero and the invoice note). It also fails when a step's instant is set while the step before it is not set or is later (wrong order), when a step is set and the outbound-write grant of a destination its operations write to is not (a missing grant), and when IMS owns an operation in the phase its step has reached but its own switch is off or no IMS writer exists (the no-writer finding: nobody is writing it). From step M on it requires the evidence that each incumbent has stopped: an evidence source that does not exist yet, or a probe that did not answer (\`not-probed\`), is a failure and never a pass; the owner's confirmations are recorded with \`npm run writers:attest\` or the administrator confirmation screen. In P2-W the missing \`qoblex-stock-push-stopped\` confirmation is a failure, whether or not \`wc_stock_sync_enabled\` is already on, and in P2-X the missing \`qoblex-xero-stopped\` confirmation is a failure; in both, IMS holds the stock push or every step-X write (queued and retried, never shadowed) until the confirmation is recorded. It also reports the legacy single-variable live-from configuration (\`WC_WRITES_LIVE_FROM\` without \`MINTSOFT_WRITES_LIVE_FROM\`, which fails; \`MINTSOFT_WRITES_LIVE_FROM\` with the WooCommerce grant and no \`WC_WRITES_LIVE_FROM\`, which warns), whose meaning changed with the per-step phases. Evidence older than the live-from instant, or (with no instant) older than the window (default ${WRITERS_CHECK_DEFAULT_WINDOW_DAYS} days, \`--window-days\`), is not counted, nor is anything dated after the moment the report is taken, and an order with no readable paid time is reported but never counted, because IMS cannot create an unpaid order.`,
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
