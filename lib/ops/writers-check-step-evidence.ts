import {
  STEP_EVIDENCE_ATTESTATION_KIND,
  STEP_EVIDENCE_KINDS,
  type StepEvidenceKind,
  type StepEvidenceReading,
  NATIVE_EMAIL_VIOLATION,
} from '@/lib/security/writers-check-constants'
import { isWriterAttestationKind } from '@/lib/security/writer-attestation-constants'
import { BRIDGE_ATTESTATION_KIND, bridgeLastTriggerReadable, bridgeUnitViolations, readBridgePayload } from '@/lib/domain/writer-attestation/bridge-status'
import { STOREFRONT_CUSTOMER_EMAIL_ENABLED_AT_KEY, STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY, parseStorefrontEmailEnabledAt } from '@/lib/domain/storefront-customer-email/constants'
import type { WooNativeEmailState } from '@/lib/connectors/woocommerce/native-email-state'
import { parseProducerCutoff } from '@/lib/security/producer-disposition'
import { PRODUCER_STEP_ENV } from '@/lib/security/producer-disposition-constants'
import type { LiveWriterStep } from '@/lib/security/writer-ownership-map'
import type { IncumbentsProbeResult } from '@/lib/connectors/woocommerce/incumbent-plugins'

/**
 * THE READERS OF THE STEP EVIDENCE (what shows an incumbent has stopped, beyond the marks on imported orders).
 *
 * Each kind has exactly one reader. A kind whose source does not exist yet is registered as `not-built`; the evaluator then FAILS the phases that
 * require it with an "evidence source not built" finding. A reader never answers "fine" for a source it cannot read: it answers `not-built`,
 * `not-probed`, or `unreadable`. When a source is built, replace its entry here and nothing else changes.
 */

type AttestationReaderDb = {
  writerAttestation: { findFirst(args: { where: { kind: string }; orderBy: { attestedAt: 'desc' }; select: { attestedAt: true } }): Promise<{ attestedAt: Date } | null> }
}

/** The observer's tables, read by the STOCK_DRIFT reader. */
type DriftReaderDb = {
  wcStockDriftRun: {
    findFirst(args: { where: { ok: true; startedAt?: { gte: Date } }; orderBy: { startedAt: 'asc' | 'desc' }; select: { startedAt: true } }): Promise<{ startedAt: Date } | null>
  }
  wcStockDriftEvent: { count(args: { where: { observedAt: { gte: Date; lte: Date }; acknowledgedAt: null } }): Promise<number> }
}

type EvidenceReaderDb = AttestationReaderDb & {
  writerAttestation: { findFirst(args: { where: { kind: string }; orderBy: { attestedAt: 'desc' }; select: { attestedAt: true; payload?: true } }): Promise<{ attestedAt: Date; payload?: unknown } | null> }
  setting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> }
}

/**
 * `env`, `readNativeEmail`, `probe` and `foreignOrders` are what the readers that look outside IMS's database need; all are test seams (absent = the live ones).
 * `readNativeEmail` is the store's own e-mail settings read (the default is the connector's read-only GET); it is only ever called from step W on.
 */
export type StepEvidenceContext = {
  db: EvidenceReaderDb & Partial<DriftReaderDb>
  now: Date
  /** The environment the live-from instants are read from. Absent = the process environment. */
  env?: Record<string, string | undefined>
  readNativeEmail?: () => Promise<WooNativeEmailState>
  /** Test seams: the companion-plugin probe and the foreign-order reader. Absent = the live ones. */
  probe?: () => Promise<IncumbentsProbeResult>
  foreignOrders?: (since: Date) => Promise<{ foreign: number }>
}

export type StepEvidenceReader = (ctx: StepEvidenceContext & { probeOnce: () => Promise<IncumbentsProbeResult> }) => Promise<StepEvidenceReading>

const notBuilt: StepEvidenceReader = async () => ({ state: 'not-built' })

/** The live-from instant of a step as the check reads it: a Date, `unset`, or `unreadable`. */
export function stepLiveFrom(env: Record<string, string | undefined>, step: LiveWriterStep): Date | 'unset' | 'unreadable' {
  const name = PRODUCER_STEP_ENV[step]
  const read = parseProducerCutoff(Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined)
  if (read.ok) return read.at
  return read.reason === 'absent' ? 'unset' : 'unreadable'
}

/**
 * A reader that only asks once its step is live. Before that the evidence is not required, and asking would make the daily P1 check depend on a
 * plugin that is not deployed yet (an unanswered probe fails the check in every phase). A live-from that cannot be read is `unreadable`; one in the future is `not-due`.
 */
function whenStepLive(step: LiveWriterStep, read: (ctx: Parameters<StepEvidenceReader>[0], liveFrom: Date) => Promise<StepEvidenceReading>): StepEvidenceReader {
  return async (ctx) => {
    const liveFrom = stepLiveFrom(ctx.env ?? process.env, step)
    if (liveFrom === 'unset') return { state: 'not-due' }
    if (liveFrom === 'unreadable') return { state: 'unreadable' }
    // A live-from still in the future is not live: the evaluator counts a step live only once now >= live-from, so nothing is asked (or required) before.
    if (liveFrom.getTime() > ctx.now.getTime()) return { state: 'not-due' }
    return read(ctx, liveFrom)
  }
}

const bridgeProbeReader: StepEvidenceReader = whenStepLive('mintsoft', async (ctx, liveFrom) => {
  const { bridgeProbeViolations } = await import('@/lib/connectors/woocommerce/incumbent-plugins')
  const result = await ctx.probeOnce()
  return result.ok ? { state: 'probed', violations: bridgeProbeViolations({ probe: result.probe, mintsoftLiveFrom: liveFrom }) } : { state: 'not-probed' }
})

const xeroomNoteReader: StepEvidenceReader = whenStepLive('xero', async (ctx) => {
  const { xeroomNoteViolations } = await import('@/lib/connectors/woocommerce/incumbent-plugins')
  const result = await ctx.probeOnce()
  return result.ok ? { state: 'probed', violations: xeroomNoteViolations(result.probe) } : { state: 'not-probed' }
})

const foreignOrderReader: StepEvidenceReader = whenStepLive('mintsoft', async (ctx, liveFrom) => {
  const read = ctx.foreignOrders ?? (async (since: Date) => (await import('@/lib/connectors/mintsoft/foreign-orders')).readMintsoftForeignOrders(since))
  // A read that throws is `unreadable` (readStepEvidence catches it): a Mintsoft that does not answer is never a clean answer.
  const result = await read(liveFrom)
  return { state: 'counted', counted: result.foreign, floor: liveFrom.toISOString() }
})

/** How long the drift observer must have been watching, after the owner's confirmation, before its quiet is believed (design section 4, step W). */
export const STOCK_DRIFT_QUIET_WINDOW_MS = 24 * 3_600_000
/** The latest complete run must be at least this recent (the observer runs hourly). */
export const STOCK_DRIFT_MAX_RUN_AGE_MS = 6 * 3_600_000

const stockDriftReader: StepEvidenceReader = whenStepLive('woocommerce', async (ctx) => {
  const db = ctx.db
  if (!db.wcStockDriftRun || !db.wcStockDriftEvent) return { state: 'unreadable' }
  const attestation = await db.writerAttestation.findFirst({ where: { kind: STEP_EVIDENCE_ATTESTATION_KIND.QOBLEX_STOCK_PUSH_STOPPED! }, orderBy: { attestedAt: 'desc' }, select: { attestedAt: true } })
  // Without the owner's confirmation there is nothing to measure the quiet from; that kind is its own finding.
  if (!attestation) return { state: 'not-probed' }
  const first = await db.wcStockDriftRun.findFirst({ where: { ok: true, startedAt: { gte: attestation.attestedAt } }, orderBy: { startedAt: 'asc' }, select: { startedAt: true } })
  const last = await db.wcStockDriftRun.findFirst({ where: { ok: true }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } })
  if (!first || !last) return { state: 'not-probed' }
  if (last.startedAt.getTime() < ctx.now.getTime() - STOCK_DRIFT_MAX_RUN_AGE_MS) return { state: 'not-probed' }
  if (last.startedAt.getTime() - first.startedAt.getTime() < STOCK_DRIFT_QUIET_WINDOW_MS) return { state: 'not-probed' }
  const counted = await db.wcStockDriftEvent.count({ where: { observedAt: { gte: attestation.attestedAt, lte: ctx.now }, acknowledgedAt: null } })
  return { state: 'counted', counted, floor: attestation.attestedAt.toISOString() }
})

function attestationReader(kind: string): StepEvidenceReader {
  return async ({ db }) => {
    if (!isWriterAttestationKind(kind)) return { state: 'unreadable' }
    const row = await db.writerAttestation.findFirst({ where: { kind }, orderBy: { attestedAt: 'desc' }, select: { attestedAt: true } })
    return row ? { state: 'present', at: row.attestedAt.toISOString() } : { state: 'absent' }
  }
}

/**
 * BRIDGE_ATTESTATION: the newest `bridge-units-masked` attestation, which carries the host report. Present with the report's own facts: the unit
 * violations (anything not masked, not persistently masked or not inactive), the generation time of the report and the latest trigger time, which the evaluator judges against the step's live-from instant. A row whose
 * payload is not the shape this version wrote is `unreadable`, never clean. Absent until one is recorded; not due before step M (P1 passes with none).
 */
const bridgeAttestationReader: StepEvidenceReader = async ({ db }) => {
  const row = await db.writerAttestation.findFirst({ where: { kind: BRIDGE_ATTESTATION_KIND }, orderBy: { attestedAt: 'desc' }, select: { attestedAt: true, payload: true } })
  return bridgeAttestationReading(row)
}

/**
 * The BRIDGE_ATTESTATION reading of one stored row (the newest `bridge-units-masked` attestation, or null when none is recorded). Exported so a reader
 * that holds the row by another route (the first-load Mintsoft archive reads it inside its own READ ONLY transaction on the target) reads it exactly as
 * writers:check does.
 */
export function bridgeAttestationReading(row: { attestedAt: Date; payload?: unknown } | null): StepEvidenceReading {
  if (!row) return { state: 'absent' }
  const report = readBridgePayload(row.payload)
  if (report === null) return { state: 'unreadable' }
  // `last_trigger: unknown`, or `never` without proof that the journal was read, is NOT "the bridge never ran": systemd's timestamps are in memory and a reboot
  // wipes them. It is unreadable (fails closed), never a pass.
  if (!bridgeLastTriggerReadable(report)) return { state: 'unreadable' }
  return { state: 'present', at: row.attestedAt.toISOString(), violations: bridgeUnitViolations(report), lastTriggerAt: report.lastTriggerAt, generatedAt: report.generatedAt, journalEarliestAt: report.journalEarliestAt }
}

/**
 * NATIVE_EMAIL_EXCLUSIVE: WooCommerce native customer e-mail and the IMS storefront e-mail switch are mutually exclusive, JUDGED PER E-MAIL: every e-mail kind
 * IMS replaces needs EXACTLY ONE sender. The IMS switch covers both the confirmation (WooCommerce's customer_processing_order) and the dispatched e-mail
 * (customer_completed_order), so with the switch ON each native one must be OFF (else a duplicate), and with it OFF each must be ON (else nobody sends that
 * kind: a mixed state, such as processing off with completed on, is a violation, not a pass).
 * BEFORE STEP W (no live WooCommerce live-from: unset, unreadable or in the future) nothing is read from the store, but the IMS switch being ON is itself a
 * violation: it would start IMS e-mail to live customers beside WooCommerce's, and no phase before W requires this evidence, so it is reported in every phase.
 * From step W: the IMS switch is read from the settings, the store's two native e-mails from the store. A store that does not answer, or answers something
 * else than yes/no, is `unreadable` and fails closed.
 */
export { NATIVE_EMAIL_VIOLATION }

const nativeEmailExclusiveReader: StepEvidenceReader = async ({ db, env, now, readNativeEmail }) => {
  const setting = await db.setting.findUnique({ where: { key: STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY }, select: { value: true } })
  const imsOn = setting?.value === 'true'
  // The switch ON with no readable switch-on stamp (a direct write, a restore): every send fails closed on the missing stamp, so nobody sends any customer
  // e-mail, yet the native e-mails are off. That is not a pass.
  const stampRow = imsOn ? await db.setting.findUnique({ where: { key: STOREFRONT_CUSTOMER_EMAIL_ENABLED_AT_KEY }, select: { value: true } }) : null
  const stampMissing = imsOn && parseStorefrontEmailEnabledAt(stampRow?.value) === null
  const liveFrom = stepLiveFrom(env ?? process.env, 'woocommerce')
  if (liveFrom === 'unset' || liveFrom === 'unreadable' || liveFrom.getTime() > now.getTime()) {
    return imsOn ? { state: 'probed', violations: [NATIVE_EMAIL_VIOLATION.imsOnBeforeStepW, ...(stampMissing ? [NATIVE_EMAIL_VIOLATION.onWithoutStamp] : [])] } : { state: 'absent' }
  }
  const read = readNativeEmail ?? (async () => (await import('@/lib/connectors/woocommerce/native-email-state')).readWooNativeCustomerEmailState())
  const native = await read()
  if (!native.ok) return { state: 'unreadable' }
  const violations: string[] = stampMissing ? [NATIVE_EMAIL_VIOLATION.onWithoutStamp] : []
  for (const [id, on] of Object.entries(native.enabled)) {
    if (imsOn && on) violations.push(`${NATIVE_EMAIL_VIOLATION.bothOn}:${id}`)
    if (!imsOn && !on) violations.push(`${NATIVE_EMAIL_VIOLATION.bothOff}:${id}`)
  }
  return { state: 'probed', violations }
}

export const STEP_EVIDENCE_READERS: Readonly<Record<StepEvidenceKind, StepEvidenceReader>> = {
  // Source: scripts/bridge/bridge_writers_status.py run on the bridge host, pasted into `writers:attest` (kind bridge-units-masked).
  BRIDGE_ATTESTATION: bridgeAttestationReader,
  // Source: the companion plugin's /incumbents route (1.5.0) and its client (lib/connectors/woocommerce/incumbent-plugins.ts). Asked from step M.
  BRIDGE_PROBE: bridgeProbeReader,
  // Source: a Mintsoft read of orders for the client that IMS has no link for (lib/connectors/mintsoft/foreign-orders.ts). Asked from step M.
  MINTSOFT_FOREIGN_ORDER: foreignOrderReader,
  QOBLEX_STOCK_PUSH_STOPPED: attestationReader(STEP_EVIDENCE_ATTESTATION_KIND.QOBLEX_STOCK_PUSH_STOPPED!),
  // Source: the stock-drift observer (lib/connectors/woocommerce/stock-drift.ts, `npm run switchover:stock-drift`). Asked from step W.
  STOCK_DRIFT: stockDriftReader,
  QOBLEX_XERO_STOPPED: attestationReader(STEP_EVIDENCE_ATTESTATION_KIND.QOBLEX_XERO_STOPPED!),
  // Source: the probe's reading of the option o3d_xeroom_order_note_off (the mu-plugin switch that suppresses only Xeroom's order note). Asked from step X.
  XEROOM_NOTE: xeroomNoteReader,
  NATIVE_EMAIL_EXCLUSIVE: nativeEmailExclusiveReader,
}

/** Read every kind. A reader that throws gives `unreadable` for that kind alone. */
export async function readStepEvidence(ctx: StepEvidenceContext, readers: Readonly<Record<StepEvidenceKind, StepEvidenceReader>> = STEP_EVIDENCE_READERS): Promise<Record<StepEvidenceKind, StepEvidenceReading>> {
  const out = {} as Record<StepEvidenceKind, StepEvidenceReading>
  // ONE probe per check, shared by the two readers that read it (the bridge's state and Xeroom's note); a probe that throws answers `not-probed`.
  let probe: Promise<IncumbentsProbeResult> | null = null
  const probeOnce = (): Promise<IncumbentsProbeResult> => {
    probe ??= (ctx.probe ?? (async () => (await import('@/lib/connectors/woocommerce/incumbent-plugins')).fetchIncumbentsProbe()))().catch(() => ({ ok: false as const, reason: 'unreachable' as const, message: 'The probe did not complete.' }))
    return probe
  }
  for (const kind of STEP_EVIDENCE_KINDS) {
    try {
      out[kind] = await readers[kind]({ ...ctx, probeOnce })
    } catch {
      out[kind] = { state: 'unreadable' }
    }
  }
  return out
}
