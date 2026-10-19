import { OUTBOUND_CONNECTORS, type OutboundConnector } from '@/lib/security/outbound-write-hold-constants'
import { explainProducerDisposition, producerGrantCutoffAgreement } from '@/lib/security/producer-disposition'
import { producerSeamVerdict, readProducerEnforcement, producerCutoffFloor } from '@/lib/security/producer-seam'
import { WRITER_OWNERSHIP_MAP, type OwnershipRow } from '@/lib/security/writer-ownership-map'
import {
  EVIDENCE_CONTESTS,
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

/** The IMS-side switches of every operation IMS has a writer for. */
export const IMS_WRITER_SWITCHES: readonly Switch[] = [
  { key: 'xero.sales.invoice', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_sales_invoice' }] },
  { key: 'xero.sales.invoice-update', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_sales_invoice' }] },
  { key: 'xero.sales.credit-note', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_credit_note' }] },
  { key: 'xero.sales.payment', trigger: 'automatic', requires: [...XERO_MASTER] },
  { key: 'xero.purchase.bill', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_purchase_invoice' }] },
  { key: 'xero.purchase.bill-payment', trigger: 'automatic', requires: [...XERO_MASTER] },
  { key: 'xero.purchase.bill-attachment', trigger: 'automatic', requires: [...XERO_MASTER, { settingTrue: 'xero_sync_attach_pdf', defaultValue: 'true' }] },
  { key: 'xero.purchase.supplier-credit', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_purchase_credit_note' }] },
  {
    key: 'xero.inventory.journals',
    trigger: 'automatic',
    requires: [...XERO_MASTER, {
      anyMode: [
        'xero_sync_stock_receipt', 'xero_sync_inventory_adjustment', 'xero_sync_cogs_journal', 'xero_sync_cogs_reversal',
        'xero_sync_stock_allocation', 'xero_sync_manufacturing_journal',
      ],
    }],
  },
  { key: 'xero.daily-batch', trigger: 'automatic', requires: [...XERO_MASTER, { settingTrue: 'xero_daily_batch_enabled', defaultValue: 'false' }] },
  { key: 'xero.tax-rate', trigger: 'automatic', requires: [...XERO_MASTER, { mode: 'xero_sync_tax_rate' }] },
  { key: 'mintsoft.order.create', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }, { cron: 'wms-order-push' }] },
  { key: 'mintsoft.order.amend', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }, { cron: 'wms-order-push' }] },
  { key: 'mintsoft.order.cancel', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }, { cron: 'wms-order-push' }] },
  { key: 'mintsoft.order.hold', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }, { cron: 'wms-order-push' }] },
  { key: 'mintsoft.order.comment', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.product.upsert', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.product.content', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.product.bundle', trigger: 'automatic', requires: [{ plugin: 'mintsoft' }] },
  { key: 'mintsoft.asn.create', trigger: 'operator', requires: [{ plugin: 'mintsoft' }] },
  { key: 'woocommerce.stock', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }, { settingTrue: 'wc_stock_sync_enabled', defaultValue: 'false' }] },
  { key: 'woocommerce.product.meta', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }] },
  { key: 'woocommerce.order.status', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }] },
  { key: 'woocommerce.order.tracking', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }] },
  { key: 'woocommerce.order.partial-shipment', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }] },
  { key: 'woocommerce.order.wms-status-meta', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }] },
  { key: 'woocommerce.order.invoice-note', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }, ...XERO_MASTER, { mode: 'xero_sync_sales_invoice' }] },
  { key: 'woocommerce.fx-rates', trigger: 'automatic', requires: [{ plugin: 'woocommerce' }, { settingTrue: 'wc_fx_push_enabled', defaultValue: 'false' }] },
  { key: 'woocommerce.webhooks', trigger: 'operator', requires: [{ plugin: 'woocommerce' }] },
]

/** Mapped operations with no IMS-side writer to switch, each with the reason. Every other mapped row must have a switch above. */
export const WRITERS_WITHOUT_IMS_SWITCH: Readonly<Record<string, string>> = {
  'xero.fx-journal': 'never produced for Xero (suppressed)',
  'xero.demo-provisioning': 'a manual script against a demo tenant; no setting or schedule drives it',
  'mintsoft.auth.login': 'key minting is governed by the transport hold, not by a producer',
  'woocommerce.order.withdrawal-outcome': 'the endpoint lives in the storefront plugin; IMS only receives',
  'woocommerce.order.trackship-reconcile': 'the endpoint lives in the storefront plugin; IMS only receives',
  'woocommerce.order.invoice-document': 'IMS has no writer for it yet',
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
  /** Injectable for the tests; the real map by default. */
  map?: readonly OwnershipRow[]
}

export type WritersCheckFinding = {
  code: 'ims-writes-owned-elsewhere' | 'ims-writes-undecided' | 'ims-owns-forbidden-row' | 'incumbent-evidence-vs-ims-writer'
    | 'ims-writes-where-nobody-owns' | 'unreadable' | 'evidence-gap' | 'operator-capability-overlaps'
  severity: 'fail' | 'warn'
  /** `<destination>.<operation>`, or the destination, or null. A map key, never a data key. */
  subject: string | null
  message: string
}

export type WritersCheckOperation = {
  key: string
  owner: string
  phase: 'P1' | 'P2'
  imsSwitchedOn: boolean
  grant: 'granted' | 'absent' | 'unreadable'
  verdict: 'legacy' | 'live' | 'shadow'
  imsCanWrite: boolean
  trigger: 'automatic' | 'operator'
}

export type WritersCheckVerdict = 'ok' | 'double-claim' | 'unreadable' | 'evidence-gap'

export type WritersCheckReport = {
  schemaVersion: number
  generatedAt: string
  windowDays: number
  destinations: Array<{ connector: OutboundConnector; enforced: boolean; phase: 'P1' | 'P2'; liveFrom: string | null; grant: string }>
  operations: WritersCheckOperation[]
  withoutImsSwitch: Array<{ key: string; reason: string }>
  evidence: Partial<Record<WritersCheckEvidenceKey, EvidenceReading>> | null
  evidenceUnrecorded: number | null
  findings: WritersCheckFinding[]
  canSee: readonly string[]
  cannotSee: readonly string[]
  verdict: WritersCheckVerdict
  exitCode: number
}

const KIND_DESTINATION: Record<WritersCheckEvidenceKey, OutboundConnector> = {
  MINTSOFT_ORDER_ID: 'mintsoft',
  MINTSOFT_OTHER_META: 'mintsoft',
  XEROOM_MARKER: 'woocommerce',
  XERO_FOREIGN_NUMBER: 'xero',
}

export const WRITERS_CHECK_EVIDENCE_KEYS: readonly WritersCheckEvidenceKey[] = [...INCUMBENT_EVIDENCE_KINDS, XERO_FOREIGN_NUMBER_EVIDENCE]

/**
 * The instant from which each kind of evidence counts: the later of the destination's live-from instant and the start of the
 * window. Evidence from before the live-from instant belongs to the writer that owned the destination then and is not a clash;
 * evidence older than the window is not current. An unreadable instant gives the window start alone (the broader count).
 */
export function evidenceFloors(env: Record<string, string | undefined>, now: Date, windowDays: number): Record<WritersCheckEvidenceKey, Date> {
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000)
  const floors = {} as Record<WritersCheckEvidenceKey, Date>
  for (const key of WRITERS_CHECK_EVIDENCE_KEYS) {
    const cutoff = producerCutoffFloor(KIND_DESTINATION[key], { env, now })
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
  const context = { env: inputs.env, now: inputs.now }
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
    const first = map.find((row) => row.destination === connector)
    const decision = first ? explainProducerDisposition(connector, first.operation as never, inputs.now, context) : null
    const bad = decision !== null && (['unreadable', 'unreadable_grant', 'unreadable_cutoff'].includes(decision.reason) || producerGrantCutoffAgreement(connector, inputs.env).state === 'unreadable')
    if (bad) {
      envUnreadable.add(connector)
      unreadable(connector, `${connector}: the grant or the live-from instant is set but cannot be read, so the phase cannot be established.`)
    }
    const floor = producerCutoffFloor(connector, context)
    destinations.push({
      connector,
      enforced: enforcement.enforced && enforcement.destinations.has(connector),
      phase: decision?.phase ?? 'P1',
      liveFrom: floor ? floor.toISOString() : null,
      grant: decision?.grant ?? 'unreadable',
    })
  }
  if (enforcement.enforced && !enforcement.readable) {
    unreadable(null, 'The producer-hold enforcement variable is set to a value that cannot be read; every destination is treated as enforced.')
  }

  // 3. Settings, scheduled jobs and plugins must have been read.
  const readable = inputs.settings !== null && inputs.cronEnabled !== null && inputs.pluginEnabled !== null
  if (!readable) unreadable(null, 'The settings, scheduled-job rows or plugin switches could not be read, so what IMS could write cannot be established.')

  const writable = new Map<string, boolean>()
  const mapped = map.filter((row) => row.destination !== 'customer-email')
  for (const row of mapped) {
    const key = `${row.destination}.${row.operation}`
    const entry = IMS_WRITER_SWITCHES.find((candidate) => candidate.key === key)
    if (!entry) {
      if (!(key in WRITERS_WITHOUT_IMS_SWITCH)) {
        unreadable(key, `${key} is in the ownership map but the check knows neither its IMS-side switches nor a reason it has none.`)
      }
      continue
    }
    const connector = row.destination as OutboundConnector
    const decision = explainProducerDisposition(connector, row.operation as never, inputs.now, context)
    const verdict = producerSeamVerdict(connector, row.operation as never, inputs.now, context).kind
    const switchedOn = readable
      ? entry.requires.every((req) => requirementOn(req, { settings: inputs.settings!, cronEnabled: inputs.cronEnabled!, pluginEnabled: inputs.pluginEnabled! }))
      : true
    const imsCanWrite = switchedOn && decision.grant === 'granted' && verdict !== 'shadow'
    writable.set(key, imsCanWrite)
    const owner = row.owners[decision.phase]
    operations.push({ key, owner, phase: decision.phase, imsSwitchedOn: switchedOn, grant: decision.grant, verdict, imsCanWrite, trigger: entry.trigger })
    if (!imsCanWrite) continue

    // The map's owner in the current phase against IMS being able to write it.
    if (owner === 'IMS') continue
    if (owner === 'unknown') {
      findings.push({ code: 'ims-writes-undecided', severity: 'fail', subject: key, message: `IMS can write ${key} in ${decision.phase} while nobody has decided who owns it.` })
    } else if (owner === 'nobody') {
      findings.push({ code: 'ims-writes-where-nobody-owns', severity: 'warn', subject: key, message: `IMS can write ${key} in ${decision.phase}, where the map says nobody writes it. No other writer is claimed.` })
    } else if (entry.trigger === 'operator') {
      findings.push({ code: 'operator-capability-overlaps', severity: 'warn', subject: key, message: `IMS offers a button that writes ${key} while the map gives it to ${owner} in ${decision.phase}; it is a double claim only if the button is used.` })
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
  if (inputs.evidenceUnrecorded === null) {
    unreadable(null, `The log of evidence the storefront import could not keep (${INCUMBENT_EVIDENCE_UNRECORDED_ACTION}) could not be read.`)
  } else if (inputs.evidenceUnrecorded > 0) {
    findings.push({ code: 'evidence-gap', severity: 'fail', subject: null, message: `${inputs.evidenceUnrecorded} storefront order(s) in the window could not have their incumbent evidence kept; the check is blind to them.` })
  }

  const failing = findings.filter((finding) => finding.severity === 'fail')
  const verdict: WritersCheckVerdict = failing.some((f) => f.code !== 'unreadable' && f.code !== 'evidence-gap')
    ? 'double-claim'
    : failing.some((f) => f.code === 'unreadable') ? 'unreadable'
    : failing.length > 0 ? 'evidence-gap' : 'ok'
  return {
    schemaVersion: WRITERS_CHECK_SCHEMA_VERSION,
    generatedAt: inputs.now.toISOString(),
    windowDays: inputs.windowDays,
    destinations,
    operations,
    withoutImsSwitch: Object.entries(WRITERS_WITHOUT_IMS_SWITCH).map(([key, reason]) => ({ key, reason })),
    evidence: evidenceRead,
    evidenceUnrecorded: inputs.evidenceUnrecorded,
    findings,
    canSee: WRITERS_CHECK_CAN_SEE,
    cannotSee: WRITERS_CHECK_CANNOT_SEE,
    verdict,
    exitCode: exitFor(verdict),
  }
}

export function renderWritersCheckText(report: WritersCheckReport): string {
  const lines = [`Writers check ${report.generatedAt} (evidence window ${report.windowDays} days): ${report.verdict.toUpperCase()}`]
  for (const destination of report.destinations) {
    lines.push(`  ${destination.connector}: phase ${destination.phase}, grant ${destination.grant}, live-from ${destination.liveFrom ?? 'not set'}, producer hold ${destination.enforced ? 'enforced' : 'not enforced'}`)
  }
  const claiming = report.operations.filter((op) => op.imsCanWrite)
  lines.push(`  IMS can write ${claiming.length} of ${report.operations.length} mapped operations now${claiming.length ? ': ' + claiming.map((op) => op.key).join(', ') : ''}`)
  if (report.evidence) {
    for (const [key, reading] of Object.entries(report.evidence)) lines.push(`  evidence ${key}: ${reading.counted} current of ${reading.total} (${reading.unpaid} unpaid, not counted), counted since ${reading.floor}`)
  }
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
  const base: WritersCheckInputs = { env, now, windowDays, settings: null, cronEnabled: null, pluginEnabled: null, evidence: null, evidenceUnrecorded: null }
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

  const floors = evidenceFloors(env, now, windowDays)
  try {
    const evidence: Partial<Record<WritersCheckEvidenceKey, EvidenceReading>> = {}
    for (const kind of INCUMBENT_EVIDENCE_KINDS) {
      const floor = floors[kind]
      evidence[kind] = {
        counted: await db.incumbentWriterEvidence.count({ where: { connector: 'woocommerce', kind, paidAt: { gte: floor } } }),
        total: await db.incumbentWriterEvidence.count({ where: { connector: 'woocommerce', kind } }),
        unpaid: await db.incumbentWriterEvidence.count({ where: { connector: 'woocommerce', kind, paidAt: null } }),
        floor: floor.toISOString(),
      }
    }
    const foreignFloor = floors[XERO_FOREIGN_NUMBER_EVIDENCE]
    const foreignWhere = { action: XERO_FOREIGN_NUMBER_ACTIVITY_ACTION, OR: XERO_FOREIGN_NUMBER_REFUSAL_CODES.map((code) => ({ metadata: { path: ['refusalCode'], equals: code } })) }
    evidence[XERO_FOREIGN_NUMBER_EVIDENCE] = {
      counted: await db.activityLog.count({ where: { ...foreignWhere, createdAt: { gte: foreignFloor } } }),
      total: await db.activityLog.count({ where: foreignWhere }),
      unpaid: 0,
      floor: foreignFloor.toISOString(),
    }
    base.evidence = evidence
  } catch {
    base.evidence = null
  }

  try {
    const windowStart = new Date(now.getTime() - windowDays * 86_400_000)
    const entries = await db.activityLog.findMany({
      where: { action: INCUMBENT_EVIDENCE_UNRECORDED_ACTION, createdAt: { gte: windowStart } },
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
