import {
  STEP_EVIDENCE_ATTESTATION_KIND,
  STEP_EVIDENCE_KINDS,
  type StepEvidenceKind,
  type StepEvidenceReading,
} from '@/lib/security/writers-check-constants'
import { isWriterAttestationKind } from '@/lib/security/writer-attestation-constants'
import { BRIDGE_ATTESTATION_KIND, bridgeUnitViolations, readBridgePayload } from '@/lib/domain/writer-attestation/bridge-status'
import { STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY } from '@/lib/domain/storefront-customer-email/constants'
import type { WooNativeEmailState } from '@/lib/connectors/woocommerce/native-email-state'

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

type EvidenceReaderDb = AttestationReaderDb & {
  writerAttestation: { findFirst(args: { where: { kind: string }; orderBy: { attestedAt: 'desc' }; select: { attestedAt: true; payload?: true } }): Promise<{ attestedAt: Date; payload?: unknown } | null> }
  setting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> }
}

/**
 * `env` and `readNativeEmail` are what the readers that look outside IMS's database need. `readNativeEmail` is the store's own e-mail settings read
 * (injected by tests; the default is the connector's read-only GET). It is only ever called from step W on (see NATIVE_EMAIL_EXCLUSIVE below).
 */
export type StepEvidenceContext = { db: EvidenceReaderDb; now: Date; env?: Record<string, string | undefined>; readNativeEmail?: () => Promise<WooNativeEmailState> }
export type StepEvidenceReader = (ctx: StepEvidenceContext) => Promise<StepEvidenceReading>

const notBuilt: StepEvidenceReader = async () => ({ state: 'not-built' })

function attestationReader(kind: string): StepEvidenceReader {
  return async ({ db }) => {
    if (!isWriterAttestationKind(kind)) return { state: 'unreadable' }
    const row = await db.writerAttestation.findFirst({ where: { kind }, orderBy: { attestedAt: 'desc' }, select: { attestedAt: true } })
    return row ? { state: 'present', at: row.attestedAt.toISOString() } : { state: 'absent' }
  }
}

/**
 * BRIDGE_ATTESTATION: the newest `bridge-units-masked` attestation, which carries the host report. Present with the report's own facts: the unit
 * violations (anything not masked or not inactive) and the latest trigger time, which the evaluator judges against the step's live-from instant. A row whose
 * payload is not the shape this version wrote is `unreadable`, never clean. Absent until one is recorded; not due before step M (P1 passes with none).
 */
const bridgeAttestationReader: StepEvidenceReader = async ({ db }) => {
  const row = await db.writerAttestation.findFirst({ where: { kind: BRIDGE_ATTESTATION_KIND }, orderBy: { attestedAt: 'desc' }, select: { attestedAt: true, payload: true } })
  if (!row) return { state: 'absent' }
  const report = readBridgePayload(row.payload)
  if (report === null) return { state: 'unreadable' }
  return { state: 'present', at: row.attestedAt.toISOString(), violations: bridgeUnitViolations(report), lastTriggerAt: report.lastTriggerAt }
}

/**
 * NATIVE_EMAIL_EXCLUSIVE: WooCommerce native customer e-mail and the IMS storefront e-mail switch are mutually exclusive.
 * Before step W (no WooCommerce live-from) nothing is read from the store at all: the answer is `absent`, which no phase below W requires.
 * From step W: the IMS switch is read from the settings, the store's two native e-mails from the store. A store that does not answer, or answers
 * something else than yes/no, is `unreadable` and fails closed. Both on = duplicate e-mails; both off = nobody sends: each is a violation.
 */
export const NATIVE_EMAIL_VIOLATION = { bothOn: 'native-and-ims-customer-email-both-on', bothOff: 'native-and-ims-customer-email-both-off' } as const

const nativeEmailExclusiveReader: StepEvidenceReader = async ({ db, env, readNativeEmail }) => {
  const live = env?.WC_WRITES_LIVE_FROM
  if (live === undefined || live.trim() === '') return { state: 'absent' }
  const setting = await db.setting.findUnique({ where: { key: STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY }, select: { value: true } })
  const imsOn = setting?.value === 'true'
  const read = readNativeEmail ?? (async () => (await import('@/lib/connectors/woocommerce/native-email-state')).readWooNativeCustomerEmailState())
  const native = await read()
  if (!native.ok) return { state: 'unreadable' }
  const nativeOn = Object.values(native.enabled).some((on) => on)
  const violations: string[] = []
  if (imsOn && nativeOn) violations.push(NATIVE_EMAIL_VIOLATION.bothOn)
  if (!imsOn && !nativeOn) violations.push(NATIVE_EMAIL_VIOLATION.bothOff)
  return { state: 'probed', violations }
}

export const STEP_EVIDENCE_READERS: Readonly<Record<StepEvidenceKind, StepEvidenceReader>> = {
  // Source: scripts/bridge/bridge_writers_status.py run on the bridge host, pasted into `writers:attest` (kind bridge-units-masked).
  BRIDGE_ATTESTATION: bridgeAttestationReader,
  // Source: the companion plugin's /incumbents route and its client. Not built.
  BRIDGE_PROBE: notBuilt,
  // Source: a Mintsoft read of orders for the client that IMS has no link for. Not built.
  MINTSOFT_FOREIGN_ORDER: notBuilt,
  QOBLEX_STOCK_PUSH_STOPPED: attestationReader(STEP_EVIDENCE_ATTESTATION_KIND.QOBLEX_STOCK_PUSH_STOPPED!),
  // Source: the stock-drift observer. Not built.
  STOCK_DRIFT: notBuilt,
  QOBLEX_XERO_STOPPED: attestationReader(STEP_EVIDENCE_ATTESTATION_KIND.QOBLEX_XERO_STOPPED!),
  // Source: import-time evidence of a Xeroom-written note, dated. Not built.
  XEROOM_NOTE: notBuilt,
  NATIVE_EMAIL_EXCLUSIVE: nativeEmailExclusiveReader,
}

/** Read every kind. A reader that throws gives `unreadable` for that kind alone. */
export async function readStepEvidence(ctx: StepEvidenceContext, readers: Readonly<Record<StepEvidenceKind, StepEvidenceReader>> = STEP_EVIDENCE_READERS): Promise<Record<StepEvidenceKind, StepEvidenceReading>> {
  const out = {} as Record<StepEvidenceKind, StepEvidenceReading>
  for (const kind of STEP_EVIDENCE_KINDS) {
    try {
      out[kind] = await readers[kind](ctx)
    } catch {
      out[kind] = { state: 'unreadable' }
    }
  }
  return out
}
