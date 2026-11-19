import { OUTBOUND_CONNECTORS, type OutboundConnector } from '@/lib/security/outbound-write-hold-constants'
import { legacyLiveFromFindings } from '@/lib/security/live-from-legacy-config'
import { explainProducerDisposition, parseProducerCutoff, producerGrantCutoffAgreement } from '@/lib/security/producer-disposition'
import { PRODUCER_STEP_ENV, liveStepsOfDestination } from '@/lib/security/producer-disposition-constants'
import { producerOperationEgressVerdict, producerSeamVerdict, readProducerEnforcement } from '@/lib/security/producer-seam'
import { XERO_SYNC_TYPE_SETTING } from '@/lib/connectors/xero/sync-type-setting'
import { LIVE_WRITER_STEPS, WRITER_OWNERSHIP_MAP, type LiveWriterStep, type OwnershipRow } from '@/lib/security/writer-ownership-map'
import {
  EVIDENCE_CONTESTS,
  EVIDENCE_KIND_STEP,
  PHASE_OF_LIVE_STEP,
  STEP_ATTESTATION_BEFORE_STEP,
  STEP_REPORT_TRIGGER_BEFORE_STEP,
  STEP_EVIDENCE_ATTESTATION_KIND,
  STEP_EVIDENCE_KINDS,
  STEP_EVIDENCE_LABEL,
  STEP_EVIDENCE_REQUIRED_FROM,
  type StepEvidenceKind,
  type StepEvidenceReading,
  type WritersCheckPhase,
  IMS_FORBIDDEN_OWNERSHIP_ROWS,
  INCUMBENT_EVIDENCE_KINDS,
  INCUMBENT_EVIDENCE_UNRECORDED_ACTION,
  WRITERS_CHECK_CANNOT_SEE,
  WRITERS_CHECK_CAN_SEE,
  WRITERS_CHECK_DEFAULT_WINDOW_DAYS,
  WRITERS_CHECK_EXIT_CODES,
  WRITERS_CHECK_SCHEMA_VERSION,
  XERO_FOREIGN_NUMBER_ACTIVITY_ACTION,
  XERO_FOREIGN_NUMBER_EVIDENCE,
  XERO_FOREIGN_NUMBER_REFUSAL_CODES,
  type WritersCheckEvidenceKey,
} from '@/lib/security/writers-check-constants'

/**
 * THE COEXISTENCE INTERLOCK: DO TWO WRITERS CLAIM ONE DESTINATION OPERATION IN THE CURRENT PHASE?
 *
 * Read-only. The decision is pure (`evaluateWritersCheck`): it is handed the environment, the clock, the settings IMS holds and
 * the incumbent evidence IMS already keeps, and makes no call to any vendor. The reader at the foot is the one part that touches
 * the database.
 *
 * For each operation in the ownership map it answers one question: COULD IMS WRITE THIS RIGHT NOW? Yes only when the operation's
 * own switches are on, the destination's outbound-write grant lets a write through, and (for a destination whose producers obey
 * the producer decision) that decision is not SHADOW. If IMS could write it, the writer the map names for the current phase is
 * compared: any other owner (or an owner nobody has decided) is a double claim. Separately, the incumbent evidence is compared
 * with what IMS could write: bridge marks on orders paid since the live-from instant while IMS can create Mintsoft orders is a
 * double claim whatever the map says.
 *
 * Every state it cannot read is a failure, never a pass: an unreadable grant, live-from instant or enforcement value, a settings
 * or evidence read that threw, or an evidence kind the reader did not return.
 */

export type WritersCheckPlugin = 'woocommerce' | 'mintsoft' | 'xero'

type Requirement =
  | { plugin: WritersCheckPlugin }
  /** The setting must read exactly 'true' (the connectors compare with `=== 'true'`). */
  | { settingTrue: string; defaultValue: 'true' | 'false' }
  /** A posting mode: present and not 'off'. Absent reads as the default 'submitted'. */
  | { mode: string }
  /** At least one of these posting modes is on. */
  | { anyMode: readonly string[] }
  | { cron: string }

type Switch = {
  /** `<destination>.<operation>`. */
  key: string
  requires: readonly Requirement[]
  /** An operator pressing a button is not an automatic writer: a clash there is a warning, not a failure. */
  trigger: 'automatic' | 'operator'
}

const XERO_MASTER: Requirement[] = [{ plugin: 'xero' }, { settingTrue: 'xero_sync_enabled', defaultValue: 'false' }]

/**
 * THE SCHEDULED ROUTES THAT DRIVE A MAPPED OPERATION, AND WHETHER THEIR SCHEDULE FLAG IS A CAPABILITY.
 *
 * A schedule's enabled flag only decides whether the crontab line exists. A route that does not itself check the flag stays callable
 * (an authenticated manual call, a stale scheduler entry), so the flag must not be read as "IMS cannot write". Each route that drives a
 * mapped operation is declared here:
 *
 *   always-callable   the route does not enforce the flag: the flag is IGNORED by the check (no `cron` requirement may name it).
 *   flag-enforced     the route itself refuses when the job is off: a `cron` requirement may name it.
 *
 * tests/ops/writers-check-cron-census.test.ts reads each route's source and fails when the declaration and the route disagree.
 */
export const WRITER_CRON_ROUTES: Readonly<Record<string, 'always-callable' | 'flag-enforced'>> = {
  'wms-order-push': 'always-callable',
}

/**
 * THE POSTING-MODE REQUIREMENT OF THE JOURNAL OPERATION, DERIVED FROM THE SAME TWO TABLES THE QUEUE GATE USES: every sync type in the
 * ownership row of `xero.inventory.journals`, and the queue's per-type switch table. A type with a switch contributes it ("any of these
 * on"); a type with NO switch (STOCK_IN_TRANSIT, UNEARNED_REV_REVERSAL, ALLOCATION_REVERSAL) is queued as 'submitted' whenever Xero sync is
 * on, so it makes the operation a capability on the master switch alone and no per-type setting can say IMS cannot write it.
 */
function journalModeRequirement(): Requirement[] {
  const row = (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]).find((entry) => entry.destination === 'xero' && entry.operation === 'inventory.journals')
  const types = row?.accountingSyncTypes ?? []
  const keys = types.map((type) => XERO_SYNC_TYPE_SETTING[type])
  if (keys.length === 0 || keys.some((key) => key === undefined)) return []
  return [{ anyMode: [...new Set(keys as string[])] }]
}

/** The IMS-side switches of every operation IMS has a writer for. */
export const IMS_WRITER_SWITCHES: readonly Switch[] = [
  { key: 'xero.sales.invoice', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_sales_invoice' }] },
  { key: 'xero.sales.invoice-update', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_sales_invoice' }] },
  { key: 'xero.sales.invoice-delete', trigger: 'operator', requires: [...XERO_MASTER, { mode: 'xero_sync_sales_invoice' }, { settingTrue: 'xero_document_delete_enabled', defaultValue: 'false' }] },
  { key: 'xero.sales.credit-note', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_credit_note' }] },
  // Queued by an operator deleting a refund; the void itself is sent by the drain under the same credit-note switch.
  { key: 'xero.sales.credit-note-void', trigger: 'operator', requires: [...XERO_MASTER, { mode: 'xero_sync_credit_note' }] },
  { key: 'xero.sales.payment', trigger: 'automatic', requires: [...XERO_MASTER] },
  { key: 'xero.purchase.bill', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_purchase_invoice' }] },
  { key: 'xero.purchase.bill-delete', trigger: 'operator', requires: [...XERO_MASTER, { mode: 'xero_sync_purchase_invoice' }, { settingTrue: 'xero_document_delete_enabled', defaultValue: 'false' }] },
  { key: 'xero.purchase.bill-payment', trigger: 'automatic', requires: [...XERO_MASTER] },
  { key: 'xero.purchase.bill-attachment', trigger: 'automatic', requires: [...XERO_MASTER, { settingTrue: 'xero_sync_attach_pdf', defaultValue: 'true' }] },
  { key: 'xero.purchase.supplier-credit', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_purchase_credit_note' }] },
  { key: 'xero.inventory.journals', trigger: 'automatic', requires: [...XERO_MASTER, ...journalModeRequirement()] },
  { key: 'xero.daily-batch', trigger: 'automatic', requires: [...XERO_MASTER, { settingTrue: 'xero_daily_batch_enabled', defaultValue: 'false' }] },
  { key: 'xero.tax-rate', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_tax_rate' }] },
  { key: 'mintsoft.order.create', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.order.amend', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.order.cancel', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.order.hold', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.order.comment', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.product.upsert', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.product.content', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.product.delete', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }, { settingTrue: 'mintsoft_parent_sku_delete_enabled', defaultValue: 'false' }] },
  { key: 'mintsoft.product.bundle', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.asn.create', trigger: 'operator', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.supplier.create', trigger: 'operator', requires: [{ plugin: 'mintsoft' }, { settingTrue: 'mintsoft_supplier_create_enabled', defaultValue: 'false' }] },
  { key: 'woocommerce.stock', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }, { settingTrue: 'wc_stock_sync_enabled', defaultValue: 'false' }] },
  { key: 'woocommerce.product.meta', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }] },
  { key: 'woocommerce.order.status', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }] },
  { key: 'woocommerce.order.tracking', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }] },
  { key: 'woocommerce.order.partial-shipment', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }] },
  { key: 'woocommerce.order.wms-status-meta', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }] },
  // A dedicated switch (default OFF): the note used to follow xero_sync_sales_invoice, which defaults on, so IMS's note would have joined Xeroom's the moment the Xero flow ran.
  { key: 'woocommerce.order.invoice-note', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }, ...XERO_MASTER, { settingTrue: 'wc_invoice_note_enabled', defaultValue: 'false' }] },
  { key: 'woocommerce.order.invoice-document', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }, { settingTrue: 'wc_invoice_document_enabled', defaultValue: 'false' }] },
  // The bridge's /trackship/reconcile is taken over by the refire (owner decision 2026-11-18): the same switch drives both rows.
  // The outcome of a customer's EU withdrawal request, written to the storefront order (companion plugin 1.5.0); off by default.
  { key: 'woocommerce.order.withdrawal-outcome', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }, { settingTrue: 'wc_withdrawal_outcome_enabled', defaultValue: 'false' }] },
  { key: 'woocommerce.order.trackship-reconcile', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }, { settingTrue: 'trackship_refire_enabled', defaultValue: 'false' }] },
  { key: 'woocommerce.order.trackship-refire', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }, { settingTrue: 'trackship_refire_enabled', defaultValue: 'false' }] },
  { key: 'woocommerce.fx-rates', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }, { settingTrue: 'wc_fx_push_enabled', defaultValue: 'false' }] },
  { key: 'woocommerce.webhooks', trigger: 'operator', requires: [{ plugin: 'woocommerce' }] },
]

/** Mapped operations with no IMS-side writer to switch, each with the reason. Every other mapped row must have a switch above. */
export const WRITERS_WITHOUT_IMS_SWITCH: Readonly<Record<string, string>> = {
  'xero.fx-journal': 'never produced for Xero (suppressed)',
  'xero.demo-provisioning': 'a manual script against a demo tenant; no setting or schedule drives it',
  'mintsoft.auth.login': 'key minting is governed by the transport hold, not by a producer',
  'woocommerce.tax-rate': 'IMS has no writer for it yet (the owner corrects WooCommerce by hand from the VAT difference report in P1 and P2; the map gives it to IMS when the writer is built)',
}

export function writersCheckSettingKeys(): string[] {
  const keys = new Set<string>()
  for (const entry of IMS_WRITER_SWITCHES) {
    for (const req of entry.requires) {
      if ('settingTrue' in req) keys.add(req.settingTrue)
      if ('mode' in req) keys.add(req.mode)
      if ('anyMode' in req) for (const key of req.anyMode) keys.add(key)
    }
  }
  return [...keys].sort()
}

export function writersCheckCronSlugs(): string[] {
  const slugs = new Set<string>()
  for (const entry of IMS_WRITER_SWITCHES) for (const req of entry.requires) if ('cron' in req) slugs.add(req.cron)
  return [...slugs].sort()
}

// ---------------------------------------------------------------------------------------------
// Inputs and report
// ---------------------------------------------------------------------------------------------

export type EvidenceReading = {
  /** Rows at or after the floor (and for a storefront order: with a readable paid time). */
  counted: number
  /** Rows of this kind in total. */
  total: number
  /** Storefront rows whose order is not paid, so IMS cannot create it; never counted. */
  unpaid: number
  floor: string
}

export type WritersCheckInputs = {
  env: Record<string, string | undefined>
  now: Date
  windowDays: number
  /** Raw settings rows by key; null when the settings could not be read. */
  settings: ReadonlyMap<string, string> | null
  /** Whether each scheduled job is on, by slug; null when it could not be read. A slug the map lacks reads as ON. */
  cronEnabled: Readonly<Record<string, boolean>> | null
  pluginEnabled: Readonly<Record<WritersCheckPlugin, boolean>> | null
  /** Null when the evidence could not be read; a missing kind is unreadable. */
  evidence: Partial<Record<WritersCheckEvidenceKey, EvidenceReading>> | null
  /** Unrecorded-evidence log entries that could matter (counted by the reader against the same floors). */
  evidenceUnrecorded: number | null
  /** Stored evidence rows whose kind this version does not know (null: could not be counted). Any is unreadable; the kind text is never carried. */
  unknownEvidenceKinds: number | null
  /** What shows the incumbents stopped (attestations, probes, observers), by kind; null or undefined when the readers did not run. Only the phases that require a kind look at it. */
  stepEvidence?: Partial<Record<StepEvidenceKind, StepEvidenceReading>> | null
  /** Injectable for the tests; the real map by default. */
  map?: readonly OwnershipRow[]
}

export type WritersCheckFinding = {
  code: 'ims-writes-owned-elsewhere' | 'ims-writes-undecided' | 'ims-owns-forbidden-row' | 'incumbent-evidence-vs-ims-writer'
    | 'ims-writes-where-nobody-owns' | 'inconsistent-configuration' | 'unreadable' | 'evidence-gap' | 'operator-capability-overlaps'
    | 'step-order' | 'step-missing-grant' | 'no-writer' | 'attestation-missing' | 'step-evidence-violation'
    | 'evidence-source-not-built' | 'evidence-not-probed' | 'legacy-live-from'
  severity: 'fail' | 'warn'
  /** `<destination>.<operation>`, or the destination, or null. A map key, never a data key. */
  subject: string | null
  message: string
}

export type WritersCheckOperation = {
  key: string
  /** The switchover step that moves this operation to IMS. */
  step: string
  owner: string
  phase: 'P1' | 'P2'
  imsSwitchedOn: boolean
  grant: 'granted' | 'absent' | 'unreadable'
  verdict: 'legacy' | 'live' | 'shadow'
  imsCanWrite: boolean
  trigger: 'automatic' | 'operator'
}

export type WritersCheckVerdict = 'ok' | 'double-claim' | 'unreadable' | 'evidence-gap' | 'step-gap'

export type WritersCheckReport = {
  schemaVersion: number
  generatedAt: string
  windowDays: number
  /** The installation phase, derived per step: P1 while no step is live, then the latest live step (P2-M, P2-W, P2-X). */
  phase: WritersCheckPhase
  steps: Array<{ step: LiveWriterStep; env: string; liveFrom: string | null; state: 'unset' | 'scheduled' | 'live' | 'unreadable' }>
  stepEvidence: Partial<Record<StepEvidenceKind, StepEvidenceReading>> | null
  destinations: Array<{ connector: OutboundConnector; enforced: boolean; phase: 'P1' | 'P2'; liveFrom: string | null; grant: string }>
  operations: WritersCheckOperation[]
  withoutImsSwitch: Array<{ key: string; reason: string }>
  evidence: Partial<Record<WritersCheckEvidenceKey, EvidenceReading>> | null
  evidenceUnrecorded: number | null
  unknownEvidenceKinds: number | null
  findings: WritersCheckFinding[]
  canSee: readonly string[]
  cannotSee: readonly string[]
  verdict: WritersCheckVerdict
  exitCode: number
}

export const WRITERS_CHECK_EVIDENCE_KEYS: readonly WritersCheckEvidenceKey[] = [...INCUMBENT_EVIDENCE_KINDS, XERO_FOREIGN_NUMBER_EVIDENCE]

/** The configured live-from instant of a switchover step, read on its own (not through the enforcement-dependent decision). Null when absent or unreadable. */
function configuredStepLiveFrom(env: Record<string, string | undefined>, step: LiveWriterStep): Date | null {
  const name = PRODUCER_STEP_ENV[step]
  const read = parseProducerCutoff(Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined)
  return read.ok ? read.at : null
}

/** The earliest configured live-from instant among the steps that write to a destination (what bounds the destination's own live phase). */
function configuredLiveFrom(env: Record<string, string | undefined>, connector: OutboundConnector): Date | null {
  const instants = liveStepsOfDestination(connector).map((step) => configuredStepLiveFrom(env, step)).filter((at): at is Date => at !== null)
  return instants.length === 0 ? null : instants.reduce((a, b) => (b.getTime() < a.getTime() ? b : a))
}

/**
 * The instant from which each kind of evidence counts: the later of the live-from instant of the step that kind belongs to and the start of the
 * window. Evidence from before the live-from instant belongs to the writer that owned the destination then and is not a clash;
 * evidence older than the window is not current. The configured instant is read on its own: it does NOT depend on the producer hold
 * being enforced (a legacy-path destination with a configured live-from instant still bounds its evidence). An unreadable configured
 * instant gives the window start alone (the broader count, which fails closed; the evaluator reports the instant itself unreadable).
 */
export function evidenceFloors(env: Record<string, string | undefined>, now: Date, windowDays: number): Record<WritersCheckEvidenceKey, Date> {
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000)
  const floors = {} as Record<WritersCheckEvidenceKey, Date>
  for (const key of WRITERS_CHECK_EVIDENCE_KEYS) {
    const cutoff = configuredStepLiveFrom(env, EVIDENCE_KIND_STEP[key])
    floors[key] = cutoff && cutoff.getTime() > windowStart.getTime() ? cutoff : windowStart
  }
  return floors
}

// ---------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------

function requirementOn(req: Requirement, input: { settings: ReadonlyMap<string, string>; cronEnabled: Readonly<Record<string, boolean>>; pluginEnabled: Readonly<Record<WritersCheckPlugin, boolean>> }): boolean {
  const modeOn = (key: string): boolean => {
    const raw = input.settings.get(key)
    const value = raw === undefined || raw === '' ? 'submitted' : raw
    return value !== 'off'
  }
  if ('plugin' in req) return input.pluginEnabled[req.plugin] === true
  if ('settingTrue' in req) {
    const raw = input.settings.get(req.settingTrue)
    return (raw === undefined || raw === '' ? req.defaultValue : raw) === 'true'
  }
  if ('mode' in req) return modeOn(req.mode)
  if ('anyMode' in req) return req.anyMode.some(modeOn)
  // A scheduled job missing from the readings reads as ON: it cannot be shown to be off.
  return input.cronEnabled[req.cron] !== false
}

function exitFor(verdict: WritersCheckVerdict): number {
  const name = verdict === 'ok' ? 'ok' : verdict
  return WRITERS_CHECK_EXIT_CODES.find((row) => row.name === name)!.code
}

export function evaluateWritersCheck(inputs: WritersCheckInputs): WritersCheckReport {
  const map = inputs.map ?? (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[])
  const findings: WritersCheckFinding[] = []
  const operations: WritersCheckOperation[] = []
  // The owner's confirmations that the evidence reading holds: the producer decision keeps a step-X write held without `qoblex-xero-stopped`.
  const attested = new Set<string>()
  for (const [kind, attestationKind] of Object.entries(STEP_EVIDENCE_ATTESTATION_KIND)) {
    if (inputs.stepEvidence?.[kind as StepEvidenceKind]?.state === 'present') attested.add(attestationKind)
  }
  const context = { env: inputs.env, now: inputs.now, attestations: attested }
  const enforcement = readProducerEnforcement(inputs.env)

  const unreadable = (subject: string | null, message: string): void => {
    findings.push({ code: 'unreadable', severity: 'fail', subject, message })
  }

  // 1. The map itself: IMS must never own a row the incumbent keeps for good.
  for (const key of IMS_FORBIDDEN_OWNERSHIP_ROWS) {
    const row = map.find((candidate) => `${candidate.destination}.${candidate.operation}` === key)
    if (!row) {
      unreadable(key, `The ownership map has no row for ${key}, so the rule that IMS must never own it cannot be checked.`)
      continue
    }
    const phases = (['P1', 'P2'] as const).filter((phase) => row.owners[phase] === 'IMS')
    if (phases.length > 0) {
      findings.push({
        code: 'ims-owns-forbidden-row', severity: 'fail', subject: key,
        message: `The ownership map gives IMS ${key} in ${phases.join(' and ')}; the incumbent keeps this operation in every phase, so IMS would write what another writer writes.`,
      })
    }
  }

  // 2. Per destination: can the environment be read at all?
  const destinations: WritersCheckReport['destinations'] = []
  const envUnreadable = new Set<OutboundConnector>()
  for (const connector of OUTBOUND_CONNECTORS) {
    // The destination's phase is read through one IMS-owned row of each step that writes to it (WooCommerce: steps M, W and X).
    const probes = liveStepsOfDestination(connector).flatMap((step) => {
      const row = map.find((candidate) => candidate.destination === connector && candidate.step === step && candidate.owners.P2 === 'IMS')
      return row ? [explainProducerDisposition(connector, row.operation as never, inputs.now, context)] : []
    })
    const decision = probes.find((candidate) => candidate.phase === 'P2') ?? probes[0] ?? null
    const bad = probes.length > 0 && (probes.some((candidate) => ['unreadable', 'unreadable_grant', 'unreadable_cutoff'].includes(candidate.reason)) || producerGrantCutoffAgreement(connector, inputs.env).state === 'unreadable')
    if (bad) {
      envUnreadable.add(connector)
      unreadable(connector, `${connector}: the grant or the live-from instant is set but cannot be read, so the phase cannot be established.`)
    }
    const agreement = producerGrantCutoffAgreement(connector, inputs.env)
    if (!bad && agreement.state === 'inconsistent') {
      // Only one of the two is set (a live-from instant with no grant, or a grant with no live-from instant): the phase the installation
      // is in is not the one either setting alone describes, so the check cannot vouch for it.
      findings.push({ code: 'inconsistent-configuration', severity: 'fail', subject: connector, message: `${connector}: ${agreement.text}` })
    }
    const configured = configuredLiveFrom(inputs.env, connector)
    destinations.push({
      connector,
      enforced: enforcement.enforced && enforcement.destinations.has(connector),
      phase: decision?.phase ?? 'P1',
      liveFrom: configured ? configured.toISOString() : null,
      grant: decision?.grant ?? 'unreadable',
    })
  }
  if (enforcement.enforced && !enforcement.readable) {
    unreadable(null, 'The producer-hold enforcement variable is set to a value that cannot be read; every destination is treated as enforced.')
  }

  // 2b. The steps: per-step phases, their order, and a grant for every destination a live step writes.
  const stepReads = LIVE_WRITER_STEPS.map((step) => {
    const name = PRODUCER_STEP_ENV[step]
    const read = parseProducerCutoff(Object.prototype.hasOwnProperty.call(inputs.env, name) ? inputs.env[name] : undefined)
    const state: 'unset' | 'scheduled' | 'live' | 'unreadable' = read.ok ? (inputs.now.getTime() >= read.ms ? 'live' : 'scheduled') : read.reason === 'absent' ? 'unset' : 'unreadable'
    return { step, name, read, state }
  })
  const steps: WritersCheckReport['steps'] = stepReads.map((entry) => ({ step: entry.step, env: entry.name, liveFrom: entry.read.ok ? entry.read.at.toISOString() : null, state: entry.state }))
  const liveSteps = stepReads.filter((entry) => entry.state === 'live')
  const phase: WritersCheckPhase = liveSteps.length === 0 ? 'P1' : PHASE_OF_LIVE_STEP[liveSteps[liveSteps.length - 1]!.step]
  const liveRank = liveSteps.length === 0 ? 0 : LIVE_WRITER_STEPS.indexOf(liveSteps[liveSteps.length - 1]!.step) + 1
  const isSet = (entry: (typeof stepReads)[number]): boolean => entry.state !== 'unset'
  for (let index = 1; index < stepReads.length; index += 1) {
    const earlier = stepReads[index - 1]!
    const later = stepReads[index]!
    if (!isSet(later)) continue
    if (!earlier.read.ok) {
      findings.push({ code: 'step-order', severity: 'fail', subject: later.name, message: `${later.name} is set but ${earlier.name} (the step before it) is ${earlier.state === 'unset' ? 'not set' : 'unreadable'}: the steps must go live in the order Mintsoft, WooCommerce, Xero.` })
    } else if (later.read.ok && later.read.ms < earlier.read.ms) {
      findings.push({ code: 'step-order', severity: 'fail', subject: later.name, message: `${later.name} is earlier than ${earlier.name}: a step may not go live before the step it follows.` })
    }
  }
  for (const entry of stepReads) {
    if (!isSet(entry) || !entry.read.ok) continue
    const written = new Set<OutboundConnector>()
    for (const row of map) if (row.step === entry.step && row.owners.P2 === 'IMS' && row.destination !== 'customer-email') written.add(row.destination as OutboundConnector)
    for (const connector of written) {
      const row = map.find((candidate) => candidate.destination === connector && candidate.step === entry.step && candidate.owners.P2 === 'IMS')!
      const decision = explainProducerDisposition(connector, row.operation as never, inputs.now, context)
      if (decision.grant === 'absent') {
        findings.push({ code: 'step-missing-grant', severity: 'fail', subject: connector, message: `${entry.name} is set, so step ${entry.step} writes to ${connector}, but the outbound-write grant for ${connector} is not set.` })
      }
    }
  }

  // 2c. The legacy single-variable configuration: an installation that set WC_WRITES_LIVE_FROM or MINTSOFT_WRITES_LIVE_FROM before the per-step phases changes behaviour on upgrade.
  for (const legacy of legacyLiveFromFindings(inputs.env)) {
    findings.push({ code: 'legacy-live-from', severity: legacy.severity, subject: legacy.code === 'legacy-wc-only-live-from' ? 'WC_WRITES_LIVE_FROM' : 'MINTSOFT_WRITES_LIVE_FROM', message: legacy.message })
  }

  // 3. Settings, scheduled jobs and plugins must have been read.
  const readable = inputs.settings !== null && inputs.cronEnabled !== null && inputs.pluginEnabled !== null
  if (!readable) unreadable(null, 'The settings, scheduled-job rows or plugin switches could not be read, so what IMS could write cannot be established.')

  const writable = new Map<string, boolean>()
  const mapped = map.filter((row) => row.destination !== 'customer-email')
  for (const row of mapped) {
    const key = `${row.destination}.${row.operation}`
    const entry = IMS_WRITER_SWITCHES.find((candidate) => candidate.key === key)
    const connector = row.destination as OutboundConnector
    const decision = explainProducerDisposition(connector, row.operation as never, inputs.now, context)
    const decisionUnreadable = ['unreadable', 'unreadable_grant', 'unreadable_cutoff'].includes(decision.reason)
    if (!entry) {
      if (!(key in WRITERS_WITHOUT_IMS_SWITCH)) {
        unreadable(key, `${key} is in the ownership map but the check knows neither its IMS-side switches nor a reason it has none.`)
      } else if (decision.phase === 'P2' && row.owners.P2 === 'IMS' && !decisionUnreadable) {
        // No-writer gap: the map says IMS owns it in this phase and no IMS writer exists to do it.
        findings.push({ code: 'no-writer', severity: 'fail', subject: key, message: `The map gives ${key} to IMS from step ${row.step}, which is live, but IMS has no writer for it yet: nobody is writing it.` })
      }
      continue
    }
    const verdict = producerSeamVerdict(connector, row.operation as never, inputs.now, context).kind
    const switchedOn = readable
      ? entry.requires.every((req) => requirementOn(req, { settings: inputs.settings!, cronEnabled: inputs.cronEnabled!, pluginEnabled: inputs.pluginEnabled! }))
      : true
    // The owner's confirmation is a DELIVERY condition, not part of the producer decision: while it is missing the work is held, so IMS cannot write it.
    const delivery = producerOperationEgressVerdict(connector, row.operation as never, context).kind
    const imsCanWrite = switchedOn && decision.grant === 'granted' && verdict !== 'shadow' && delivery !== 'held'
    writable.set(key, imsCanWrite)
    const owner = row.owners[decision.phase]
    // No-writer gap: IMS owns this operation in the phase its step has reached, and its own switch is off, so nobody is writing it. Today "nobody
    // writing" passes; once a step is live it does not.
    if (readable && !switchedOn && decision.phase === 'P2' && owner === 'IMS' && !decisionUnreadable) {
      // An operator-triggered operation (a delete, an ASN, webhook registration) is not something nobody is doing while its switch is off: it is done on demand, so it is a
      // warning. An AUTOMATIC operation with its switch off is the gap this finding exists for.
      findings.push({ code: 'no-writer', severity: entry.trigger === 'automatic' ? 'fail' : 'warn', subject: key, message: `IMS owns ${key} from step ${row.step}, which is live, but its switch is off in IMS: nobody ${entry.trigger === 'automatic' ? 'is writing it' : 'writes it unless an operator turns the switch on and acts'}.` })
    }
    operations.push({ key, step: row.step, owner, phase: decision.phase, imsSwitchedOn: switchedOn, grant: decision.grant, verdict, imsCanWrite, trigger: entry.trigger })
    if (!imsCanWrite) continue

    // The map's owner in the current phase against IMS being able to write it.
    if (owner === 'IMS') continue
    if (owner === 'unknown') {
      findings.push({ code: 'ims-writes-undecided', severity: 'fail', subject: key, message: `IMS can write ${key} in ${decision.phase} while nobody has decided who owns it.` })
    } else if (owner === 'nobody') {
      findings.push({ code: 'ims-writes-where-nobody-owns', severity: 'warn', subject: key, message: `IMS can write ${key} in ${decision.phase}, where the map says nobody writes it. No other writer is claimed.` })
    } else if (entry.trigger === 'operator' && owner === 'operator-manual') {
      // The owner IS the operator: IMS's button is how that owner acts, so IMS being able to write it is the intended state.
      findings.push({ code: 'operator-capability-overlaps', severity: 'warn', subject: key, message: `${key} is operator-manual in ${decision.phase}: IMS can write it only when an operator uses the button, which is the owner acting, not a second writer.` })
    } else {
      findings.push({ code: 'ims-writes-owned-elsewhere', severity: 'fail', subject: key, message: `IMS can write ${key} in ${decision.phase} while the map gives it to ${decision.owner}: two writers claim one operation.` })
    }
  }
  // A stale declaration: a switch for a row the map no longer has.
  for (const entry of IMS_WRITER_SWITCHES) {
    if (!mapped.some((row) => `${row.destination}.${row.operation}` === entry.key)) unreadable(entry.key, `The check declares switches for ${entry.key}, which the ownership map does not have.`)
  }

  // 4. Incumbent evidence against what IMS can write.
  const evidenceRead = inputs.evidence
  if (evidenceRead === null) {
    unreadable(null, 'The incumbent evidence could not be read, so the check is blind to it.')
  } else {
    for (const key of WRITERS_CHECK_EVIDENCE_KEYS) {
      const reading = evidenceRead[key]
      if (!reading) { unreadable(key, `The incumbent evidence ${key} was not returned by the reader.`); continue }
      if (reading.counted <= 0) continue
      for (const contested of EVIDENCE_CONTESTS[key]) {
        if (writable.get(contested) !== true) continue
        findings.push({
          code: 'incumbent-evidence-vs-ims-writer', severity: 'fail', subject: contested,
          message: `${reading.counted} ${key} marks since ${reading.floor} show another writer working ${contested} while IMS can write it.`,
        })
      }
    }
  }
  // 4b. The step evidence: what shows each incumbent has stopped. A kind is required from its step on; a source that is not built, did not answer
  // or could not be read FAILS (never passes), and a probe that returned "not-probed" fails in every phase.
  const stepEvidence = inputs.stepEvidence ?? null
  for (const kind of STEP_EVIDENCE_KINDS) {
    const requiredStep = STEP_EVIDENCE_REQUIRED_FROM[kind]
    const required = liveRank >= LIVE_WRITER_STEPS.indexOf(requiredStep) + 1
    const reading = stepEvidence?.[kind]
    if (reading === undefined) {
      if (required) unreadable(kind, `The step evidence ${kind} (${STEP_EVIDENCE_LABEL[kind]}) was not read, and phase ${phase} requires it.`)
      continue
    }
    if (reading.state === 'not-probed') {
      findings.push({ code: 'evidence-not-probed', severity: 'fail', subject: kind, message: `${STEP_EVIDENCE_LABEL[kind]} was not probed: the probe did not answer, so the check cannot show the incumbent has stopped.` })
      continue
    }
    if (!required) continue
    switch (reading.state) {
      case 'not-built':
        findings.push({ code: 'evidence-source-not-built', severity: 'fail', subject: kind, message: `Evidence source not built: ${STEP_EVIDENCE_LABEL[kind]} has no source yet, so the check cannot show the incumbent has stopped. Phase ${phase} requires it, so the check fails closed.` })
        break
      case 'unreadable':
        unreadable(kind, `${STEP_EVIDENCE_LABEL[kind]} could not be read, and phase ${phase} requires it.`)
        break
      case 'not-due':
        unreadable(kind, `${STEP_EVIDENCE_LABEL[kind]} was not asked (its reader judges the step not live) although phase ${phase} requires it: the live-from instants could not be read consistently.`)
        break
      case 'absent':
        findings.push({ code: 'attestation-missing', severity: 'fail', subject: kind, message: `Phase ${phase} requires ${STEP_EVIDENCE_LABEL[kind]}, and none is recorded.` })
        break
      case 'present': {
        const before = STEP_ATTESTATION_BEFORE_STEP[kind]
        const attestedMs = Date.parse(reading.at)
        const stepRead = before ? stepReads.find((entry) => entry.step === before) : undefined
        if (!Number.isFinite(attestedMs)) unreadable(kind, `${STEP_EVIDENCE_LABEL[kind]} carries a time that cannot be read.`)
        else if (stepRead?.read.ok && attestedMs > stepRead.read.ms) {
          findings.push({ code: 'attestation-missing', severity: 'fail', subject: kind, message: `${STEP_EVIDENCE_LABEL[kind]} was recorded after ${stepRead.name}: IMS went live before the incumbent was confirmed stopped.` })
        }
        // A host report carries its own facts: what it shows is not clean, or the incumbent last triggered at or after the step's live-from instant.
        if (reading.violations !== undefined && reading.violations.length > 0) {
          findings.push({ code: 'step-evidence-violation', severity: 'fail', subject: kind, message: `${STEP_EVIDENCE_LABEL[kind]} reports: ${reading.violations.join(', ')}.` })
        }
        const triggerStep = STEP_REPORT_TRIGGER_BEFORE_STEP[kind]
        if (triggerStep !== undefined) {
          const triggerRead = stepReads.find((entry) => entry.step === triggerStep)
          if (reading.lastTriggerAt === undefined || reading.violations === undefined) {
            // A host report that does not say what it showed is not a pass.
            unreadable(kind, `${STEP_EVIDENCE_LABEL[kind]} carries no report facts (units, last trigger), so nothing can be shown from it.`)
          } else if (reading.lastTriggerAt !== null) {
            const triggerMs = Date.parse(reading.lastTriggerAt)
            if (!triggerRead?.read.ok) {
              // The instant it is judged against cannot be read: no verdict on the trigger, so no pass (the live-from itself is reported separately).
              unreadable(kind, `${STEP_EVIDENCE_LABEL[kind]} cannot be judged: the live-from instant of ${triggerStep} is not readable, so the last trigger cannot be compared with it.`)
            } else if (!Number.isFinite(triggerMs)) {
              unreadable(kind, `${STEP_EVIDENCE_LABEL[kind]} carries a last-trigger time that cannot be read.`)
            } else if (triggerMs >= triggerRead.read.ms) {
              findings.push({ code: 'step-evidence-violation', severity: 'fail', subject: kind, message: `${STEP_EVIDENCE_LABEL[kind]} shows a trigger at ${reading.lastTriggerAt}, not before ${triggerRead.name}: the incumbent was still running when IMS went live.` })
            }
          }
        }
        break
      }
      case 'counted':
        if (reading.counted > 0) findings.push({ code: 'step-evidence-violation', severity: 'fail', subject: kind, message: `${reading.counted} ${kind} since ${reading.floor}: ${STEP_EVIDENCE_LABEL[kind]} shows the incumbent still writing.` })
        break
      case 'probed':
        if (reading.violations.length > 0) findings.push({ code: 'step-evidence-violation', severity: 'fail', subject: kind, message: `${STEP_EVIDENCE_LABEL[kind]} reports: ${reading.violations.join(', ')}.` })
        break
    }
  }
  if (inputs.unknownEvidenceKinds === null || inputs.unknownEvidenceKinds === undefined) {
    unreadable(null, 'Whether the evidence table holds rows of a kind this version does not know could not be established.')
  } else if (inputs.unknownEvidenceKinds > 0) {
    unreadable(null, `${inputs.unknownEvidenceKinds} stored evidence row(s) are of a kind this version of the check does not know (a newer writer or a restored database); the check cannot read them, so no verdict can be given.`)
  }
  if (inputs.evidenceUnrecorded === null) {
    unreadable(null, `The log of evidence the storefront import could not keep (${INCUMBENT_EVIDENCE_UNRECORDED_ACTION}) could not be read.`)
  } else if (inputs.evidenceUnrecorded > 0) {
    findings.push({ code: 'evidence-gap', severity: 'fail', subject: null, message: `${inputs.evidenceUnrecorded} storefront order(s) in the window could not have their incumbent evidence kept; the check is blind to them.` })
  }

  const failing = findings.filter((finding) => finding.severity === 'fail')
  const UNREADABLE_CODES: readonly string[] = ['unreadable', 'inconsistent-configuration', 'evidence-source-not-built', 'evidence-not-probed']
  const STEP_GAP_CODES: readonly string[] = ['step-order', 'step-missing-grant', 'no-writer', 'attestation-missing', 'legacy-live-from']
  const verdict: WritersCheckVerdict = failing.some((f) => !UNREADABLE_CODES.includes(f.code) && !STEP_GAP_CODES.includes(f.code) && f.code !== 'evidence-gap')
    ? 'double-claim'
    : failing.some((f) => UNREADABLE_CODES.includes(f.code)) ? 'unreadable'
    : failing.some((f) => STEP_GAP_CODES.includes(f.code)) ? 'step-gap'
    : failing.length > 0 ? 'evidence-gap' : 'ok'
  return {
    schemaVersion: WRITERS_CHECK_SCHEMA_VERSION,
    generatedAt: inputs.now.toISOString(),
    windowDays: inputs.windowDays,
    phase,
    steps,
    stepEvidence,
    destinations,
    operations,
    withoutImsSwitch: Object.entries(WRITERS_WITHOUT_IMS_SWITCH).map(([key, reason]) => ({ key, reason })),
    evidence: evidenceRead,
    evidenceUnrecorded: inputs.evidenceUnrecorded,
    unknownEvidenceKinds: inputs.unknownEvidenceKinds ?? null,
    findings,
    canSee: WRITERS_CHECK_CAN_SEE,
    cannotSee: WRITERS_CHECK_CANNOT_SEE,
    verdict,
    exitCode: exitFor(verdict),
  }
}

export function renderWritersCheckText(report: WritersCheckReport): string {
  const lines = [`Writers check ${report.generatedAt} (evidence window ${report.windowDays} days): ${report.verdict.toUpperCase()}`]
  lines.push(`  phase ${report.phase}: ${report.steps.map((step) => `${step.step} ${step.state}${step.liveFrom ? ` (${step.liveFrom})` : ''}`).join(', ')}`)
  for (const destination of report.destinations) {
    lines.push(`  ${destination.connector}: phase ${destination.phase}, grant ${destination.grant}, live-from ${destination.liveFrom ?? 'not set'}, producer hold ${destination.enforced ? 'enforced' : 'not enforced'}`)
  }
  const operatorManual = report.operations.filter((op) => op.imsCanWrite && op.owner === 'operator-manual')
  if (operatorManual.length > 0) lines.push(`  operator-manual operations (IMS writes them only by an operator action): ${operatorManual.map((op) => op.key).join(', ')}`)
  const claiming = report.operations.filter((op) => op.imsCanWrite)
  lines.push(`  IMS can write ${claiming.length} of ${report.operations.length} mapped operations now${claiming.length ? ': ' + claiming.map((op) => op.key).join(', ') : ''}`)
  if (report.evidence) {
    for (const [key, reading] of Object.entries(report.evidence)) lines.push(`  evidence ${key}: ${reading.counted} current of ${reading.total} (${reading.unpaid} unpaid, not counted), counted since ${reading.floor}`)
  }
  if (report.stepEvidence) {
    for (const [key, reading] of Object.entries(report.stepEvidence)) lines.push(`  step evidence ${key}: ${reading.state}`)
  }
  lines.push(`  evidence rows of an unknown kind: ${report.unknownEvidenceKinds ?? 'unreadable'}`)
  lines.push(`  evidence the import could not keep: ${report.evidenceUnrecorded ?? 'unreadable'}`)
  for (const finding of report.findings) lines.push(`  ${finding.severity === 'fail' ? 'FAIL' : 'warn'} [${finding.code}] ${finding.message}`)
  lines.push('  What this check can see:')
  for (const item of report.canSee) lines.push(`    - ${item}`)
  lines.push('  What this check CANNOT see:')
  for (const item of report.cannotSee) lines.push(`    - ${item}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// The reader: the database. Imported lazily so the pure parts above load without it.
// ---------------------------------------------------------------------------------------------

type Db = typeof import('@/lib/db')['db']

const UNRECORDED_READ_LIMIT = 5000

export async function readWritersCheckInputs(options: { env?: Record<string, string | undefined>; now?: Date; windowDays?: number; client?: unknown } = {}): Promise<WritersCheckInputs> {
  const env = options.env ?? process.env
  const now = options.now ?? new Date()
  const windowDays = options.windowDays ?? WRITERS_CHECK_DEFAULT_WINDOW_DAYS
  const base: WritersCheckInputs = { env, now, windowDays, settings: null, cronEnabled: null, pluginEnabled: null, evidence: null, evidenceUnrecorded: null, unknownEvidenceKinds: null }
  const db = (options.client ?? (await import('@/lib/db')).db) as Db

  try {
    await import('@/lib/cron-jobs')
    const { getAllCronJobs } = await import('@/lib/cron-registry')
    const { resolveCronEnablement } = await import('@/lib/domain/settings/cron-enablement')
    const keys = await import('@/lib/integration-plugin-keys')
    const jobs = getAllCronJobs()
    const wanted = new Set<string>(writersCheckSettingKeys())
    for (const slug of writersCheckCronSlugs()) {
      const job = jobs.find((candidate) => candidate.slug === slug)
      if (job) { wanted.add(`cron_${job.settingKey}_enabled`); if (job.legacyEnabledKey) wanted.add(job.legacyEnabledKey) }
    }
    for (const key of Object.values(keys.INTEGRATION_PLUGIN_SETTING_KEYS)) wanted.add(key)
    const rows = await db.setting.findMany({ where: { key: { in: [...wanted] } }, select: { key: true, value: true } })
    const settings = new Map(rows.map((row) => [row.key, row.value]))
    const cronEnabled: Record<string, boolean> = {}
    for (const slug of writersCheckCronSlugs()) {
      const job = jobs.find((candidate) => candidate.slug === slug)
      // An unregistered job is left out, which reads as ON.
      if (!job) continue
      cronEnabled[slug] = resolveCronEnablement({
        canonical: settings.get(`cron_${job.settingKey}_enabled`),
        legacy: job.legacyEnabledKey ? settings.get(job.legacyEnabledKey) : undefined,
        hasLegacyKey: Boolean(job.legacyEnabledKey),
        defaultEnabled: job.defaultEnabled,
      })
    }
    const state = keys.buildIntegrationPluginState((id) => keys.parseIntegrationPluginEnabled(settings.get(keys.INTEGRATION_PLUGIN_SETTING_KEYS[id])))
    base.settings = settings
    base.cronEnabled = cronEnabled
    base.pluginEnabled = { woocommerce: state.woocommerce === true, mintsoft: state.mintsoft === true, xero: state.xero === true }
  } catch {
    // Left null: the evaluator reports it as unreadable.
  }

  // Never throws: a reader that fails answers `unreadable` for its own kind.
  const { readStepEvidence } = await import('@/lib/ops/writers-check-step-evidence')
  base.stepEvidence = await readStepEvidence({ db: db as never, now, env })

  const floors = evidenceFloors(env, now, windowDays)
  try {
    const evidence: Partial<Record<WritersCheckEvidenceKey, EvidenceReading>> = {}
    for (const kind of INCUMBENT_EVIDENCE_KINDS) {
      const floor = floors[kind]
      evidence[kind] = {
        counted: await db.incumbentWriterEvidence.count({ where: { connector: 'woocommerce', kind, paidAt: { gte: floor, lte: now } } }),
        total: await db.incumbentWriterEvidence.count({ where: { connector: 'woocommerce', kind } }),
        unpaid: await db.incumbentWriterEvidence.count({ where: { connector: 'woocommerce', kind, paidAt: null } }),
        floor: floor.toISOString(),
      }
    }
    const foreignFloor = floors[XERO_FOREIGN_NUMBER_EVIDENCE]
    const foreignWhere = { action: XERO_FOREIGN_NUMBER_ACTIVITY_ACTION, OR: XERO_FOREIGN_NUMBER_REFUSAL_CODES.map((code) => ({ metadata: { path: ['refusalCode'], equals: code } })) }
    evidence[XERO_FOREIGN_NUMBER_EVIDENCE] = {
      counted: await db.activityLog.count({ where: { ...foreignWhere, createdAt: { gte: foreignFloor, lte: now } } }),
      total: await db.activityLog.count({ where: foreignWhere }),
      unpaid: 0,
      floor: foreignFloor.toISOString(),
    }
    base.evidence = evidence
  } catch {
    base.evidence = null
  }
  try {
    base.unknownEvidenceKinds = await db.incumbentWriterEvidence.count({ where: { kind: { notIn: [...INCUMBENT_EVIDENCE_KINDS] } } })
  } catch {
    base.unknownEvidenceKinds = null
  }

  try {
    const windowStart = new Date(now.getTime() - windowDays * 86_400_000)
    const entries = await db.activityLog.findMany({
      where: { action: INCUMBENT_EVIDENCE_UNRECORDED_ACTION, createdAt: { gte: windowStart, lte: now } },
      select: { metadata: true },
      orderBy: { createdAt: 'desc' },
      take: UNRECORDED_READ_LIMIT,
    })
    let counted = 0
    for (const entry of entries) {
      const meta = entry.metadata as { kinds?: unknown; paidState?: unknown; paidAt?: unknown } | null
      const kinds = Array.isArray(meta?.kinds) ? (meta!.kinds as unknown[]) : []
      // An entry that cannot be read, or whose paid time cannot be read, counts: it cannot be shown to predate the instant.
      if (!meta || meta.paidState === 'unreadable' || typeof meta.paidState !== 'string') { counted += 1; continue }
      // An unpaid order is one IMS cannot create, so its missing evidence cannot matter yet (the import keeps it once it is paid).
      if (meta.paidState === 'unpaid') continue
      const paidMs = typeof meta.paidAt === 'string' ? Date.parse(meta.paidAt) : NaN
      if (!Number.isFinite(paidMs)) { counted += 1; continue }
      const relevant = (kinds.length === 0 ? WRITERS_CHECK_EVIDENCE_KEYS : (kinds as string[]).map((kind) => (kind in floors ? kind : null)))
      // A paid time after the report instant is not a current claim either.
      if (paidMs > now.getTime()) continue
      const anyAfter = relevant.some((kind) => kind === null || paidMs >= floors[kind as WritersCheckEvidenceKey].getTime())
      if (anyAfter) counted += 1
    }
    // A list cut at the limit cannot be shown to hold nothing relevant beyond it.
    base.evidenceUnrecorded = entries.length >= UNRECORDED_READ_LIMIT ? Math.max(counted, 1) : counted
  } catch {
    base.evidenceUnrecorded = null
  }
  return base
}

export async function buildWritersCheckReport(options: { env?: Record<string, string | undefined>; now?: Date; windowDays?: number; readInputs?: (o: { env: Record<string, string | undefined>; now: Date; windowDays: number }) => Promise<WritersCheckInputs> } = {}): Promise<WritersCheckReport> {
  const env = options.env ?? process.env
  const now = options.now ?? new Date()
  const windowDays = options.windowDays ?? WRITERS_CHECK_DEFAULT_WINDOW_DAYS
  const inputs = await (options.readInputs ?? ((o) => readWritersCheckInputs(o)))({ env, now, windowDays })
  return evaluateWritersCheck(inputs)
}
