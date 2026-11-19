/**
 * THE BRIDGE HOST STATUS REPORT AS IMS READS IT (attestation kind `bridge-units-masked`). Pure: no database, no clock of its own.
 *
 * The host prints it with `scripts/bridge/bridge_writers_status.py` (read-only, `systemctl show`); an administrator pastes the output into
 * `npm run writers:attest` or the Sync screen. The output is a small line format, parsed STRICTLY here: anything that does not parse is refused at
 * recording time, and a stored payload that no longer has the expected shape reads as `unreadable` for the check (never as clean).
 *
 *   # bridge_writers_status v1
 *   host: <name>
 *   generated_at: 2026-12-31T10:00:00Z
 *   unit: wc-mintsoft-order-sweep.timer LoadState=masked ActiveState=inactive UnitFileState=masked  // wms-connector-boundary-ok: 2026-11-19: sample output naming the bridge's own systemd units.
 *   unit: wc-mintsoft-order-sweep.service LoadState=masked ActiveState=inactive UnitFileState=masked  // wms-connector-boundary-ok: 2026-11-19: sample output naming the bridge's own systemd units.
 *   unit: wc-mintsoft-webhook.service LoadState=masked ActiveState=inactive UnitFileState=masked  // wms-connector-boundary-ok: 2026-11-19: sample output naming the bridge's own systemd units.
 *   journal_exit: 0                              (the worst exit status of the journal reads; absent in a report from an older script)
 *   last_trigger: 2026-12-30T23:55:01Z          (or `never`, or `unknown`)
 *
 * `last_trigger` is the LATEST of the sweep timer's last trigger, the sweep service's last start and exit from inactive, the webhook service's last start and
 * exit from inactive, and the newest journal entry of any of the three units, so a sweep that ran without the timer (by hand) still counts, and so does a
 * webhook delivery after S.
 *
 * `never` is a CLAIM that nothing ever ran, and it is believed only when the report PROVES the journal was read (`journal_exit: 0`): systemd keeps these
 * timestamps in memory, so a reboot or a daemon-reload that garbage-collects a masked unit wipes them, and an unreadable journal then looks the same as a bridge
 * that never ran. The script writes `unknown` when it cannot tell, and `never` from a report with no `journal_exit` line, or a non-zero one, reads as
 * unreadable for the check, exactly as `unknown` does.
 *
 * LIMIT: the report is plain text the administrator pastes. It is the owner's word plus a transcript, NOT evidence signed by the host: anyone who can feed a
 * paste to `writers:attest` can type a passing report with a current `generated_at`. The one-hour freshness limit stops accidents, not forgery.
 */

export const BRIDGE_STATUS_HEADER = '# bridge_writers_status v1'
export const BRIDGE_UNITS = [
  'wc-mintsoft-order-sweep.timer', // wms-connector-boundary-ok: 2026-11-19: names the bridge's own systemd units, not a WMS connector.
  'wc-mintsoft-order-sweep.service', // wms-connector-boundary-ok: 2026-11-19: names the bridge's own systemd units, not a WMS connector.
  'wc-mintsoft-webhook.service', // wms-connector-boundary-ok: 2026-11-19: names the bridge's own systemd units, not a WMS connector.
] as const
export type BridgeUnitName = (typeof BRIDGE_UNITS)[number]

export const BRIDGE_ATTESTATION_KIND = 'bridge-units-masked'
/** A pasted report older than this when it is recorded is refused: the attestation must describe the host now. */
export const BRIDGE_STATUS_MAX_AGE_MS = 60 * 60 * 1000
/** A report stamped later than the recording by more than this is refused (clock skew allowance). */
export const BRIDGE_STATUS_MAX_FUTURE_MS = 5 * 60 * 1000
export const BRIDGE_STATUS_MAX_BYTES = 8 * 1024

export type BridgeUnitState = { loadState: string; activeState: string; unitFileState: string }
export type BridgeLastTriggerState = 'time' | 'never' | 'unknown'
export type BridgeStatusReport = {
  host: string
  generatedAt: string
  units: Record<BridgeUnitName, BridgeUnitState>
  /** ISO instant of the latest trigger, or null for `never` and `unknown`. */
  lastTriggerAt: string | null
  /** What `last_trigger` said: a time, `never` (nothing ever ran) or `unknown` (the script could not tell). */
  lastTriggerState: BridgeLastTriggerState
  /** The worst exit status of the script's journal reads (0 = every journal read succeeded), or null when the report carries none (an older script). */
  journalExit: number | null
}

/** True when the report PROVES nothing triggered: `never`, with every journal read successful. A time is judged by the evaluator; `unknown` and unproven `never` are not a verdict. */
export function bridgeLastTriggerReadable(report: BridgeStatusReport): boolean {
  if (report.lastTriggerState === 'unknown') return false
  if (report.lastTriggerState === 'never') return report.journalExit === 0
  return report.lastTriggerAt !== null
}
export type BridgeStatusParse = { ok: true; report: BridgeStatusReport } | { ok: false; error: string }

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const TOKEN = /^[A-Za-z0-9_.:-]{1,40}$/
const HOST = /^[A-Za-z0-9_.-]{1,255}$/

function instant(text: string): string | null {
  if (!ISO_Z.test(text)) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** Parse the pasted output. Strict: a missing or repeated unit, an unknown line, an unreadable time or a missing property is an error. */
export function parseBridgeStatusOutput(text: string): BridgeStatusParse {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'The bridge status output is empty.' }
  if (Buffer.byteLength(text, 'utf8') > BRIDGE_STATUS_MAX_BYTES) return { ok: false, error: `The bridge status output is longer than ${BRIDGE_STATUS_MAX_BYTES} bytes.` }
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines[0] !== BRIDGE_STATUS_HEADER) return { ok: false, error: `The output must start with "${BRIDGE_STATUS_HEADER}" (run scripts/bridge/bridge_writers_status.py on the bridge host).` }
  let host: string | null = null
  let generatedAt: string | null = null
  let lastTrigger: { at: string | null; state: BridgeLastTriggerState } | null = null
  let journalExit: number | null = null
  let journalExitSeen = false
  const units: Partial<Record<BridgeUnitName, BridgeUnitState>> = {}
  for (const line of lines.slice(1)) {
    if (line.startsWith('host: ')) {
      if (host !== null) return { ok: false, error: 'The host line appears twice.' }
      host = line.slice('host: '.length).trim()
      if (!HOST.test(host)) return { ok: false, error: 'The host line is not a host name.' }
    } else if (line.startsWith('generated_at: ')) {
      if (generatedAt !== null) return { ok: false, error: 'The generated_at line appears twice.' }
      generatedAt = instant(line.slice('generated_at: '.length).trim())
      if (generatedAt === null) return { ok: false, error: 'generated_at is not a UTC time like 2026-12-31T10:00:00Z.' }
    } else if (line.startsWith('last_trigger: ')) {
      if (lastTrigger !== null) return { ok: false, error: 'The last_trigger line appears twice.' }
      const value = line.slice('last_trigger: '.length).trim()
      if (value === 'never') lastTrigger = { at: null, state: 'never' }
      else if (value === 'unknown') lastTrigger = { at: null, state: 'unknown' }
      else {
        const at = instant(value)
        if (at === null) return { ok: false, error: 'last_trigger is neither "never", "unknown" nor a UTC time like 2026-12-31T10:00:00Z.' }
        lastTrigger = { at, state: 'time' }
      }
    } else if (line.startsWith('journal_exit: ')) {
      if (journalExitSeen) return { ok: false, error: 'The journal_exit line appears twice.' }
      journalExitSeen = true
      const value = line.slice('journal_exit: '.length).trim()
      if (!/^\d{1,3}$/.test(value)) return { ok: false, error: 'journal_exit is not an exit status number.' }
      journalExit = Number(value)
    } else if (line.startsWith('unit: ')) {
      const parts = line.slice('unit: '.length).trim().split(/\s+/)
      const name = parts[0] as BridgeUnitName
      if (!(BRIDGE_UNITS as readonly string[]).includes(name)) return { ok: false, error: `Unknown unit "${parts[0]}".` }
      if (units[name] !== undefined) return { ok: false, error: `The unit ${name} appears twice.` }
      const props: Record<string, string> = {}
      for (const part of parts.slice(1)) {
        const eq = part.indexOf('=')
        if (eq <= 0) return { ok: false, error: `The unit ${name} has a malformed property "${part}".` }
        const key = part.slice(0, eq)
        const value = part.slice(eq + 1)
        if (props[key] !== undefined) return { ok: false, error: `The unit ${name} repeats ${key}.` }
        if (!TOKEN.test(value)) return { ok: false, error: `The unit ${name} has an unreadable ${key}.` }
        props[key] = value
      }
      const { LoadState, ActiveState, UnitFileState } = props
      if (LoadState === undefined || ActiveState === undefined || UnitFileState === undefined) {
        return { ok: false, error: `The unit ${name} must report LoadState, ActiveState and UnitFileState.` }
      }
      units[name] = { loadState: LoadState, activeState: ActiveState, unitFileState: UnitFileState }
    } else {
      return { ok: false, error: `Unrecognised line: "${line.slice(0, 60)}".` }
    }
  }
  if (host === null) return { ok: false, error: 'The host line is missing.' }
  if (generatedAt === null) return { ok: false, error: 'The generated_at line is missing.' }
  if (lastTrigger === null) return { ok: false, error: 'The last_trigger line is missing.' }
  for (const name of BRIDGE_UNITS) if (units[name] === undefined) return { ok: false, error: `The unit ${name} is missing.` }
  return { ok: true, report: { host, generatedAt, units: units as Record<BridgeUnitName, BridgeUnitState>, lastTriggerAt: lastTrigger.at, lastTriggerState: lastTrigger.state, journalExit } }
}

/** Refuse a report that does not describe the host now (stale, or stamped in the future). */
export function bridgeStatusFreshnessError(report: BridgeStatusReport, now: Date): string | null {
  const age = now.getTime() - Date.parse(report.generatedAt)
  if (age > BRIDGE_STATUS_MAX_AGE_MS) return 'The bridge status output is older than an hour: run the script again on the bridge host and paste the fresh output.'
  if (age < -BRIDGE_STATUS_MAX_FUTURE_MS) return 'The bridge status output is stamped in the future: check the bridge host clock.'
  return null
}

/** The stored payload (what `recordWriterAttestation` keeps). The raw text is kept for the audit trail, bounded. */
export type BridgeAttestationPayload = BridgeStatusReport & { schema: 1; raw: string }

export function bridgePayloadFromReport(report: BridgeStatusReport, raw: string): BridgeAttestationPayload {
  return { schema: 1, ...report, raw: raw.slice(0, BRIDGE_STATUS_MAX_BYTES) }
}

/** Closed violation codes the check reports (no host data in them). */
export const BRIDGE_VIOLATION = {
  notMasked: (unit: BridgeUnitName): string => `bridge-unit-not-masked:${unit}`,
  notInactive: (unit: BridgeUnitName): string => `bridge-unit-not-inactive:${unit}`,
  notPersistentlyMasked: (unit: BridgeUnitName): string => `bridge-unit-not-persistently-masked:${unit}`,
  triggerNotBeforeLiveFrom: 'bridge-last-trigger-not-before-live-from',
  triggerUnknownLiveFrom: 'bridge-live-from-unreadable',
} as const

function isUnitState(value: unknown): value is BridgeUnitState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.loadState === 'string' && typeof v.activeState === 'string' && typeof v.unitFileState === 'string'
}

/** Re-validate a stored payload. Null = not the shape this version wrote (the reader answers `unreadable`). */
export function readBridgePayload(payload: unknown): BridgeStatusReport | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  if (p.schema !== 1 || typeof p.host !== 'string' || typeof p.generatedAt !== 'string' || Number.isNaN(Date.parse(p.generatedAt))) return null
  if (p.lastTriggerAt !== null && (typeof p.lastTriggerAt !== 'string' || Number.isNaN(Date.parse(p.lastTriggerAt)))) return null
  // Payloads recorded before `lastTriggerState` and `journalExit` existed: a time is a time; `never` has no journal proof, so it reads as unproven.
  const state = p.lastTriggerState === undefined ? (p.lastTriggerAt === null ? 'never' : 'time') : p.lastTriggerState
  if (state !== 'time' && state !== 'never' && state !== 'unknown') return null
  if ((state === 'time') !== (p.lastTriggerAt !== null)) return null
  const journalExit = p.journalExit === undefined || p.journalExit === null ? null : p.journalExit
  if (journalExit !== null && (typeof journalExit !== 'number' || !Number.isInteger(journalExit))) return null
  const unitsIn = p.units
  if (typeof unitsIn !== 'object' || unitsIn === null) return null
  const units = {} as Record<BridgeUnitName, BridgeUnitState>
  for (const name of BRIDGE_UNITS) {
    const unit = (unitsIn as Record<string, unknown>)[name]
    if (!isUnitState(unit)) return null
    units[name] = { loadState: unit.loadState, activeState: unit.activeState, unitFileState: unit.unitFileState }
  }
  return { host: p.host, generatedAt: p.generatedAt, units, lastTriggerAt: p.lastTriggerAt as string | null, lastTriggerState: state, journalExit }
}

/**
 * What a report shows against the bridge having stopped: every unit masked (LoadState `masked`, UnitFileState exactly `masked`) and inactive (ActiveState `inactive`). The last trigger is
 * judged against the step's live-from instant by the evaluator (it alone reads that instant), which is why the instant is returned, not judged, here.
 * A unit that does not exist (`not-found`) is NOT masked: nothing stops a later install from starting it.
 */
export function bridgeUnitViolations(report: BridgeStatusReport): string[] {
  const out: string[] = []
  for (const name of BRIDGE_UNITS) {
    const unit = report.units[name]
    if (unit.loadState !== 'masked') out.push(BRIDGE_VIOLATION.notMasked(name))
    if (unit.activeState !== 'inactive') out.push(BRIDGE_VIOLATION.notInactive(name))
    // EXACTLY `masked`: `masked-runtime` (systemctl mask --runtime) lives in /run and is gone at the next reboot, when the still-enabled timer starts the bridge again.
    // A unit that is not masked at all is already reported above; this reports the persistent-mask gap for a unit that LOADS as masked.
    if (unit.loadState === 'masked' && unit.unitFileState !== 'masked') out.push(BRIDGE_VIOLATION.notPersistentlyMasked(name))
  }
  return out
}
