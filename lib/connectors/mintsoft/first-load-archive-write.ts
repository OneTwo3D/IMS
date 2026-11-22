/**
 * THE FIRST-LOAD MINTSOFT ARCHIVE WRITER: the one Mintsoft write of the first-load archive command (scripts/first-load-mintsoft-archive.ts), which sets a
 * product discontinued (`DisCont`) for each product the owner set to Archived on the lifecycle review sheet. A ONE-OFF OPERATOR WRITE at the cut-over,
 * never run by the application: ownership-map row `mintsoft / product.discontinue` (lib/security/writer-ownership-map.ts).
 *
 * THE REQUEST SHAPE WAS VERIFIED on the live tenant with the owner's approval (2026-11-21, one zero-stock product, restored afterwards):
 *   - `POST /api/Product` with ONLY `{ID, SKU, DisCont}` changes `DisCont` and nothing else (every other field of `GET /api/Product/{id}` identical, but
 *     `LastUpdated` and `LastUpdatedByUser`). Mintsoft answers HTTP 200 with `{Success, Message, ...}`; success is `Success === true` ('Product
 *     Successfully Updated!'). A FULL product body is refused with HTTP 200 and `Success: false` ('One or more pallet sizes are not valid!'), so HTTP 200
 *     alone proves nothing and the full body is never sent.
 *   - `GET /api/Product/{id}` returns the whole product, with `ID`, `SKU`, `ClientId`, `Bundle` and `DisCont`, so each write is verified on the one product.
 *   - Mintsoft's edge answers 403 to a request without a User-Agent: every request here names one.
 *
 * WHAT IT CAN SEND, judged on every hop before anything leaves (`archiveHopRefusal`, and the producer hold judged on the TARGET installation's
 * environment): `GET /api/Product/{digits}`, `GET /api/Product/StockLevels?WarehouseId=<digits>`, `GET /api/Warehouse` and `POST /api/Product` with no
 * parameter, to the connection's own origin, no redirect. `POST /api/Auth` is unreachable: the key is the fixed key of the operator's credentials file
 * (the same file the lifecycle review reads), never exchanged.
 *
 * WHOSE RULES (#1128 R1 MED-3). Every decision about whether the write may leave is taken on the TARGET installation's own environment (the variables of
 * the env file the command confirmed as the target), never the operator's shell: the outbound-write grant (`MINTSOFT_WRITE_ALLOWED`, which must name
 * exactly the credentials file's tenant), the producer hold (`PRODUCER_HOLD_ENFORCED_DESTINATIONS`) and the producer disposition of the ownership row
 * `mintsoft / product.discontinue`, which is LIVE only once the Mintsoft step (M) is live there: the grant set and `MINTSOFT_WRITES_LIVE_FROM` reached.
 * Step M is the retirement of the woo-mintsoft plugin's product sync, which may reset DisCont, so the write is refused before it (`archivePreflight`).
 *
 * THE RETIREMENT EVIDENCE (#1128 R2 MED-A). The env file being at step M is NOT proof that the plugin and the bridge product sync are retired: stage
 * carries MINTSOFT_WRITES_LIVE_FROM and the grant during its stage proof (wired to the LIVE Mintsoft client while production's plugin and bridge still
 * sync), and an M rollback hands back to the bridge. So the preflight also requires evidence that lives in the TARGET installation: the newest
 * `bridge-units-masked` writer attestation there (read in the command's READ ONLY transaction), judged exactly as `writers:check` judges it from step M
 * (lib/ops/writers-check.ts stepEvidenceFindings: units masked and inactive, report generated and recorded at or after the step-M instant, last trigger
 * before it), and generated no more than ARCHIVE_RETIREMENT_MAX_AGE_MS before the run (an old report says nothing about the host now).
 *
 * THE SWITCHOVER CHECK (#1129 R1 MED-1). A fresh attestation still passes when an M rollback resumes the bridge or the plugin BEFORE the live-from is
 * unset, and a run started before a rollback would go on. So the run also requires the TARGET's own newest scheduled `writers:check` record (the
 * `writers_check_recorded` activity-log row, lib/ops/writers-check-record.ts) to pass: level INFO and verdict ok, phase P2-M or later with step M live
 * at the same instant as the target env file's, generated no more than ARCHIVE_SWITCHOVER_CHECK_MAX_AGE_MS before. That check reads what this command
 * cannot (it never calls WooCommerce): the companion-plugin probe of the plugin and the bridge, and foreign Mintsoft orders. It is judged in the
 * preflight and AGAIN before every POST (`judgeSwitchoverCheck`), so a failing check recorded during the run stops it before the next write. LIMIT: the
 * check runs hourly, so a rollback is caught within the hour after it starts plus one run, not at once; rollback step 1 also turns the archive switch off
 * (docs/woocommerce-live-runbook.md), which stops a run at its next write.
 *
 * Requests are sequential and paced (`MIN_INTERVAL_MS` between any two). Every failure is a short reason without the key, a URL or a response body;
 * Mintsoft's own `Message` is passed on, cut to 200 printable characters.
 */
import { connectorFetch } from '@/lib/security/connector-fetch'
import { OutboundWriteHeldError, outboundWriteRefusal, type OutboundEnv } from '@/lib/security/outbound-write-grant'
import { explainProducerDisposition } from '@/lib/security/producer-disposition'
import type { WmsArchiveWriter, WmsDiscontinueAnswer, WmsProductRead, WmsStep } from '@/lib/first-load/wms-discontinue/execute'
import { WmsCensusFailed as WmsCensusFailedError, WmsCensusRefused as WmsCensusRefusedError, type WmsArchiveOpenWriter, type WmsCensusReader } from '@/lib/first-load/wms-discontinue/cli'
import { MintsoftReviewFailed, MintsoftReviewRefused, readMintsoftProductCensus, readMintsoftReviewConfig } from './lifecycle-review-read'
import { classifyMintsoftRequest } from './api/read-allowlist'
import { normalizeMintsoftStockLevels } from './api/normalizers'
import type { MintsoftReviewConfig } from './lifecycle-review-read'
import { mintsoftEgressHold, mintsoftEgressRefusalText } from './producer-egress'
import { BRIDGE_ATTESTATION_KIND } from '@/lib/domain/writer-attestation/bridge-status'
import { stepEvidenceFindings } from '@/lib/ops/writers-check'
import { bridgeAttestationReading, stepLiveFrom } from '@/lib/ops/writers-check-step-evidence'
import { WRITERS_CHECK_PHASES } from '@/lib/security/writers-check-constants'
import type { ArchiveEvidence, ArchivePreflightFacts, ArchiveRetirementRow, ArchiveSwitchoverCheckRow } from '@/lib/first-load/wms-discontinue/execute'

export const ARCHIVE_USER_AGENT = 'onetwo3d-ims-first-load-archive/1'
export const MIN_INTERVAL_MS = 1000
const REQUEST_TIMEOUT_MS = 60_000
/** Fields any accepted update moves; they are not compared after the write. `DisCont` is compared on its own. */
export const FIELDS_ANY_UPDATE_MOVES = ['LastUpdated', 'LastUpdatedByUser'] as const
const DISCONTINUED_FIELD = 'DisCont'

const DIGITS = /^[1-9][0-9]{0,17}$/

/**
 * The decision for one hop, exported so a test drives it directly. A string refuses the hop (nothing is sent).
 */
export function archiveHopRefusal(base: URL, hop: { method: string; url: URL; redirectCount: number }): string | null {
  if (hop.redirectCount !== 0) return 'redirect'
  if (hop.url.origin !== base.origin || hop.url.username || hop.url.password || hop.url.hash) return 'origin'
  const prefix = base.pathname.replace(/\/+$/, '')
  if (!hop.url.pathname.startsWith(`${prefix}/`)) return 'path'
  const relative = hop.url.pathname.slice(prefix.length)
  const method = hop.method.toUpperCase()
  const params = [...hop.url.searchParams]
  if (method === 'GET' && /^\/api\/Product\/[1-9][0-9]{0,17}$/.test(relative)) {
    if (classifyMintsoftRequest('GET', relative).class !== 'read') return 'path'
    return params.length === 0 ? null : 'parameter'
  }
  if (method === 'GET' && relative === '/api/Product/StockLevels') {
    if (classifyMintsoftRequest('GET', relative).class !== 'read') return 'path'
    return params.length === 1 && params[0]![0] === 'WarehouseId' && DIGITS.test(params[0]![1]) ? null : 'parameter'
  }
  if (method === 'GET' && relative === '/api/Warehouse') {
    if (classifyMintsoftRequest('GET', relative).class !== 'read') return 'path'
    return params.length === 0 ? null : 'parameter'
  }
  if (method === 'POST' && relative === '/api/Product') return params.length === 0 ? null : 'parameter'
  return method === 'GET' || method === 'POST' ? 'path' : 'method'
}

export interface MintsoftArchiveWriterDeps {
  /** The TARGET installation's environment: the transport (the e2e loopback allowance, the outbound-write grant) and the producer hold judge it. Required. */
  env: OutboundEnv
  sleep?: (ms: number) => Promise<void>
  minIntervalMs?: number
  timeoutMs?: number
}

type Sent = { status: number; json: unknown | undefined }

/** The producer hold's per-hop decision (as mintsoftHopGate), judged on the target installation's environment instead of the process's. */
export function targetHoldRefusal(hop: { method: string; url: URL; redirectCount: number }, env: OutboundEnv, base?: URL): string | null {
  const hold = mintsoftEgressHold({ env })
  // Classified on the path below the connection's base (an installation whose Mintsoft address carries a path prefix).
  const prefix = base === undefined ? '' : base.pathname.replace(/\/+$/, '')
  const relative = prefix !== '' && hop.url.pathname.startsWith(`${prefix}/`) ? hop.url.pathname.slice(prefix.length) : hop.url.pathname
  if (!hold.held || classifyMintsoftRequest(hop.method, relative).class !== 'write') return null
  return mintsoftEgressRefusalText(hold, { method: hop.method.toUpperCase(), target: hop.url.pathname })
}

/** The writer-attestation kind whose newest row in the target is the evidence that the bridge and the plugin's product sync are retired. */
export const ARCHIVE_RETIREMENT_ATTESTATION_KIND = BRIDGE_ATTESTATION_KIND
/** The bridge host report must have been generated at most this long before the run (run the status script again and record it otherwise). */
export const ARCHIVE_RETIREMENT_MAX_AGE_MS = 24 * 3_600_000

/**
 * The target-resident retirement evidence (#1128 R2 MED-A): the newest `bridge-units-masked` attestation of the TARGET, judged by writers:check's own
 * rule under the target's environment, at the run's instant. Refuses without one, before step M is live in that environment, on any finding the check
 * gives the attestation, and on a report older than ARCHIVE_RETIREMENT_MAX_AGE_MS. Sends nothing.
 */
export function archiveRetirementEvidence(row: ArchiveRetirementRow | null, env: OutboundEnv, now: Date): { ok: true; evidence: string } | { ok: false; problem: string } {
  const flat = env as Record<string, string | undefined>
  const remedy = `run scripts/bridge/bridge_writers_status.py on the bridge host after step M and record it in the target with npm run writers:attest -- --kind ${ARCHIVE_RETIREMENT_ATTESTATION_KIND}`
  if (row === null) return { ok: false, problem: `the target installation holds no ${ARCHIVE_RETIREMENT_ATTESTATION_KIND} attestation, so nothing there shows the bridge and the woo-mintsoft plugin's product sync retired: ${remedy}` }
  const liveFrom = stepLiveFrom(flat, 'mintsoft')
  if (!(liveFrom instanceof Date) || liveFrom.getTime() > now.getTime()) return { ok: false, problem: 'the Mintsoft step (M) is not live in the target installation, so its bridge attestation cannot be judged against the step-M instant' }
  const attestedMs = Date.parse(row.attestedAt)
  if (!Number.isFinite(attestedMs)) return { ok: false, problem: `the target's newest ${ARCHIVE_RETIREMENT_ATTESTATION_KIND} attestation carries a time that cannot be read` }
  const reading = bridgeAttestationReading({ attestedAt: new Date(attestedMs), payload: row.payload })
  const findings = stepEvidenceFindings('BRIDGE_ATTESTATION', reading, flat, now).filter((f) => f.severity === 'fail')
  if (findings.length > 0) return { ok: false, problem: `the target's newest ${ARCHIVE_RETIREMENT_ATTESTATION_KIND} attestation does not show the bridge retired, as writers:check judges it: ${findings.map((f) => f.message).join(' ')}` }
  // Defence in depth (#1129 R1 LOW-4): with step M live the check requires this kind, so any reading but a clean `present` one already gave a finding above.
  if (reading.state !== 'present' || reading.generatedAt === undefined) return { ok: false, problem: `the target's newest ${ARCHIVE_RETIREMENT_ATTESTATION_KIND} attestation cannot be read` }
  const generatedMs = Date.parse(reading.generatedAt)
  if (!(now.getTime() - generatedMs <= ARCHIVE_RETIREMENT_MAX_AGE_MS)) return { ok: false, problem: `the target's newest ${ARCHIVE_RETIREMENT_ATTESTATION_KIND} report was generated at ${reading.generatedAt}, more than 24 hours before this run, so it says nothing about the bridge now (an M rollback resumes it): ${remedy}` }
  return { ok: true, evidence: `${ARCHIVE_RETIREMENT_ATTESTATION_KIND} attestation recorded ${reading.at} in the target (report generated ${reading.generatedAt}, last trigger ${reading.lastTriggerAt ?? 'never'}; units masked and inactive), judged as writers:check judges it against MINTSOFT_WRITES_LIVE_FROM ${liveFrom.toISOString()}` }
}

/** The target's scheduled writers:check record must have been generated at most this long before the run and before each write (the check runs hourly). */
export const ARCHIVE_SWITCHOVER_CHECK_MAX_AGE_MS = 6 * 3_600_000
/** A record stamped later than this after the instant of the run is refused (clock skew allowance). */
const SWITCHOVER_CHECK_MAX_FUTURE_MS = 5 * 60_000

/**
 * The target's newest scheduled writers:check record (#1129 R1 MED-1), judged at `now` under the target's environment: it must be a PASSING check (level
 * INFO and verdict ok), of phase P2-M or later with step M live at the same instant as the target env file's, generated within
 * ARCHIVE_SWITCHOVER_CHECK_MAX_AGE_MS. Sends nothing.
 */
export function archiveSwitchoverCheckEvidence(row: ArchiveSwitchoverCheckRow | null, env: OutboundEnv, now: Date): ArchiveEvidence {
  const remedy = 'let the target\'s scheduled Writers Coexistence Check (cron writers-check) run and pass, and run again'
  if (row === null) return { ok: false, problem: `the target installation holds no writers:check record, so nothing there shows the switchover check passing: ${remedy}` }
  const report = record(record(row.metadata)?.report)
  if (row.level !== 'INFO' || report === null || report.verdict !== 'ok') return { ok: false, problem: `the target's newest writers:check record did not pass (level ${mintsoftMessage(row.level)}, verdict ${mintsoftMessage(report?.verdict)}): the incumbents are not shown stopped, as after an M rollback that resumed the bridge or the plugin. Resolve its findings first` }
  const generatedMs = typeof report.generatedAt === 'string' ? Date.parse(report.generatedAt) : Number.NaN
  if (!Number.isFinite(generatedMs) || generatedMs > now.getTime() + SWITCHOVER_CHECK_MAX_FUTURE_MS) return { ok: false, problem: 'the target\'s newest writers:check record carries a generation time that cannot be read, or one in the future' }
  if (now.getTime() - generatedMs > ARCHIVE_SWITCHOVER_CHECK_MAX_AGE_MS) return { ok: false, problem: `the target's newest writers:check record was generated at ${new Date(generatedMs).toISOString()}, more than 6 hours before this run: ${remedy}` }
  const phaseRank = WRITERS_CHECK_PHASES.indexOf(report.phase as (typeof WRITERS_CHECK_PHASES)[number])
  if (phaseRank < WRITERS_CHECK_PHASES.indexOf('P2-M')) return { ok: false, problem: `the target's newest writers:check record is of phase ${mintsoftMessage(report.phase)}, not P2-M or later: step M was not live when it ran` }
  const liveFrom = stepLiveFrom(env as Record<string, string | undefined>, 'mintsoft')
  const step = Array.isArray(report.steps) ? report.steps.map(record).find((entry) => entry?.step === 'mintsoft') : undefined
  if (!(liveFrom instanceof Date) || step?.state !== 'live' || step.liveFrom !== liveFrom.toISOString()) return { ok: false, problem: 'the target\'s newest writers:check record does not show step M live at the instant the target env file names (MINTSOFT_WRITES_LIVE_FROM changed since, or the check ran under another environment)' }
  return { ok: true, evidence: `writers:check record of the target: verdict ok, phase ${String(report.phase)}, generated ${new Date(generatedMs).toISOString()}, step M live since ${liveFrom.toISOString()}` }
}

/**
 * Before anything is read for the write (#1128 R1 LOW-2, MED-3; R2 MED-A): on the TARGET's environment, the ownership row `product.discontinue` is LIVE
 * (the Mintsoft step is live: the grant is set and its live-from instant reached), the outbound-write grant admits `POST /api/Product` to exactly this
 * tenant, the target holds the evidence that the bridge and the plugin's product sync are retired (`archiveRetirementEvidence`), and its own scheduled
 * writers:check passed recently (`archiveSwitchoverCheckEvidence`). A string refuses
 * (nothing sent); both evidences are recorded with every write.
 *
 * The producer-hold check here is defence in depth and cannot refuse on its own (#1128 R2 LOW-H): a LIVE disposition is exactly the live phase the
 * hold releases, so with the disposition LIVE the hold never holds Mintsoft. It is kept so a change to either rule fails closed.
 */
export function archivePreflight(config: MintsoftReviewConfig, env: OutboundEnv, facts: ArchivePreflightFacts): { ok: true; evidence: string; retirementEvidence: string; switchoverEvidence: string } | { ok: false; problem: string } {
  const decision = explainProducerDisposition('mintsoft', 'product.discontinue', undefined, { env })
  if (decision.disposition !== 'LIVE') return { ok: false, problem: `the Mintsoft step (M) is not live in the target installation (producer decision ${decision.disposition}: ${decision.reason}): the woo-mintsoft plugin's product sync, which may reset DisCont, is not retired there. Set MINTSOFT_WRITE_ALLOWED and MINTSOFT_WRITES_LIVE_FROM in the target's env file at the cut-over first` }
  if (mintsoftEgressHold({ env }).held) return { ok: false, problem: 'the producer hold holds Mintsoft in the target installation' }
  const base = new URL(config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`)
  const refusal = outboundWriteRefusal({ connectorName: 'Mintsoft', method: 'POST', url: new URL('api/Product', base), headers: {}, body: '{}', writeScopeId: config.clientId, env })
  if (refusal !== null) return { ok: false, problem: `the target's outbound-write grant does not admit POST /api/Product to the credentials file's tenant (${refusal.code}): MINTSOFT_WRITE_ALLOWED in the target env file must name exactly this base URL and client id` }
  const retired = archiveRetirementEvidence(facts.retirement, env, facts.now)
  if (!retired.ok) return retired
  const checked = archiveSwitchoverCheckEvidence(facts.switchoverCheck, env, facts.now)
  if (!checked.ok) return checked
  return { ok: true, evidence: `Mintsoft step live in the target since ${decision.cutoff === null ? 'unknown' : decision.cutoff.toISOString()} (producer decision LIVE, ${decision.phase}, owner ${decision.owner})`, retirementEvidence: retired.evidence, switchoverEvidence: checked.evidence }
}

/**
 * ONE request of the archive writer: through the connector fetch seam with the transport's outbound-write grant (the POST is a write), the producer
 * hold's per-hop gate and this writer's own exact-path gate, the fixed key in `ms-apikey`, a User-Agent, no redirect. Never throws a body, URL or key.
 */
export async function sendMintsoftArchiveRequest(config: MintsoftReviewConfig, method: 'GET' | 'POST', relativePath: string, params: Record<string, string>, body: unknown, deps: MintsoftArchiveWriterDeps, onDispatch?: () => void): Promise<Sent> {
  const base = new URL(config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`)
  const url = new URL(relativePath.replace(/^\/+/, ''), base)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  const headers: Record<string, string> = { 'ms-apikey': config.apiKey, Accept: 'application/json', 'User-Agent': ARCHIVE_USER_AGENT }
  if (method === 'POST') headers['Content-Type'] = 'application/json'
  const response = await connectorFetch(url, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
  }, {
    connectorName: 'Mintsoft',
    allowE2eLocalHttp: true,
    env: deps.env,
    refuseRedirects: true,
    outboundWriteContext: { writeScopeId: config.clientId },
    // Every gate passed is the last decision before the request leaves: once this hop is admitted, the request is dispatched.
    hopGate: (hop) => {
      const refusal = archiveHopRefusal(new URL(config.baseUrl), hop) ?? targetHoldRefusal(hop, deps.env, new URL(config.baseUrl))
      if (refusal === null) onDispatch?.()
      return refusal
    },
  })
  const type = response.headers.get('content-type') ?? ''
  let json: unknown | undefined
  if (type.includes('application/json')) {
    try {
      json = await response.json()
    } catch {
      json = undefined
    }
  } else {
    await response.arrayBuffer().catch(() => undefined)
  }
  return { status: response.status, json }
}

const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const idOf = (v: unknown): string | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? String(v) : typeof v === 'string' && DIGITS.test(v) ? v : null)
/** Mintsoft's own message, printable and short (it is shown to the operator; it never carries the key). */
export function mintsoftMessage(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') return '(no message)'
  const clean = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffd\ufffe\uffff]/gu, ' ').trim()
  return clean.length > 200 ? `${clean.slice(0, 200)}...` : clean
}

/** The fields of two product answers that differ, but `DisCont` and the fields any update moves. A field present in only one answer differs. */
export function changedMintsoftProductFields(before: unknown, after: unknown): string[] {
  const a = record(before)
  const b = record(after)
  if (a === null || b === null) return ['(the product answer is not an object)']
  const skip = new Set<string>([DISCONTINUED_FIELD, ...FIELDS_ANY_UPDATE_MOVES])
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !skip.has(k)).sort()
  return names.filter((k) => !(Object.prototype.hasOwnProperty.call(a, k) && Object.prototype.hasOwnProperty.call(b, k) && stableJson(a[k]) === stableJson(b[k])))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const r = record(value)
  if (r !== null) return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${stableJson(r[k])}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * The discontinue request itself: `POST /api/Product` with exactly `{ID, SKU, DisCont: true}` (the verified partial body). A failure says whether the
 * request may have reached Mintsoft (#1128 R1 LOW-1): `sent: false` when it was refused before it left IMS (the hold, the grant, the hop gate),
 * `'unknown'` when the request was dispatched and no usable answer came back (a dropped connection, a timeout, an unreadable answer).
 */
export async function discontinueMintsoftProduct(config: MintsoftReviewConfig, productId: string, sku: string, deps: MintsoftArchiveWriterDeps): Promise<WmsDiscontinueAnswer> {
  if (!DIGITS.test(productId)) return { ok: false, sent: false, problem: 'the product id is not a whole number' }
  // The producer hold first, as mintsoftRequest does (the per-hop gate refuses it too), judged on the target's environment.
  if (mintsoftEgressHold({ env: deps.env }).held) return { ok: false, sent: false, problem: 'held before it left IMS: the producer hold is enforced for Mintsoft in the target and it is not in its live phase, so nothing was sent' }
  let dispatched = false
  let sent: Sent
  try {
    sent = await sendMintsoftArchiveRequest(config, 'POST', '/api/Product', {}, { ID: Number(productId), SKU: sku, DisCont: true }, deps, () => { dispatched = true })
  } catch (error) {
    if (error instanceof OutboundWriteHeldError) return { ok: false, sent: false, problem: 'held before it left IMS: the target\'s outbound-write grant MINTSOFT_WRITE_ALLOWED does not name this tenant, so nothing was sent' }
    if (!dispatched) return { ok: false, sent: false, problem: 'refused before it left IMS (the request gate), so nothing was sent' }
    return { ok: false, sent: 'unknown', problem: 'the request was sent and no answer came back (the connection failed or timed out): it may or may not have reached Mintsoft' }
  }
  if (sent.status !== 200) return { ok: false, sent: 'unknown', problem: `Mintsoft answered HTTP ${sent.status}` }
  const body = record(sent.json)
  if (body === null || typeof body.Success !== 'boolean') return { ok: false, sent: 'unknown', problem: 'Mintsoft answered HTTP 200 without a {Success, Message} body' }
  return { ok: true, value: { accepted: body.Success === true, message: mintsoftMessage(body.Message) } }
}

/** The writer the first-load archive command drives (lib/first-load/wms-discontinue/execute.ts). Every request is paced. */
export function createMintsoftArchiveWriter(config: MintsoftReviewConfig, deps: MintsoftArchiveWriterDeps): WmsArchiveWriter {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let requests = 0
  const paced = async <T>(run: () => Promise<T>): Promise<T> => {
    if (requests > 0) await sleep(deps.minIntervalMs ?? MIN_INTERVAL_MS)
    requests++
    return run()
  }
  const client = Number(config.clientId)
  return {
    label: 'Mintsoft',
    async readProduct(productId: string): Promise<WmsStep<WmsProductRead>> {
      if (!DIGITS.test(productId)) return { ok: false, problem: 'the product id is not a whole number' }
      let sent: Sent
      try {
        sent = await paced(() => sendMintsoftArchiveRequest(config, 'GET', `/api/Product/${productId}`, {}, undefined, deps))
      } catch {
        return { ok: false, problem: 'the request failed' }
      }
      if (sent.status !== 200) return { ok: false, problem: `Mintsoft answered HTTP ${sent.status}` }
      const raw = record(sent.json)
      if (raw === null) return { ok: false, problem: 'the answer is not a product object' }
      const id = idOf(raw.ID)
      if (id === null || typeof raw.SKU !== 'string') return { ok: false, problem: 'the answer carries no usable ID and SKU' }
      return {
        ok: true,
        value: {
          productId: id,
          sku: raw.SKU,
          bundle: typeof raw.Bundle === 'boolean' ? raw.Bundle : null,
          discontinued: typeof raw.DisCont === 'boolean' ? raw.DisCont : null,
          ownClient: raw.ClientId === client,
          snapshot: raw,
        },
      }
    },
    /**
     * The product's physical stock, read again live (#1128 R1 LOW-5, LOW-6): the warehouse list first, then EVERY listed warehouse. A configured
     * warehouse must be listed; `stockRow` says whether a configured one has a row for the product; `onHand` sums the product's rows in every listed
     * warehouse (a warehouse nobody configured that holds it counts). A row under the same SKU but another product id, a repeated row, or a row that
     * does not name its warehouse and our client is a failure.
     */
    async readStock(productId: string, sku: string): Promise<WmsStep<{ stockRow: boolean; onHand: number }>> {
      let listedSent: Sent
      try {
        listedSent = await paced(() => sendMintsoftArchiveRequest(config, 'GET', '/api/Warehouse', {}, undefined, deps))
      } catch {
        return { ok: false, problem: 'the warehouse list could not be read' }
      }
      if (listedSent.status !== 200 || !Array.isArray(listedSent.json)) return { ok: false, problem: `the warehouse list could not be read (HTTP ${listedSent.status})` }
      const listed: string[] = []
      for (const item of listedSent.json) {
        const raw = record(item)
        const named = raw === null ? [] : ['ID', 'Id', 'id', 'WarehouseId', 'warehouseId'].filter((k) => raw[k] !== undefined).map((k) => idOf(raw[k]))
        const id = named.length > 0 && named.every((v) => v !== null && v === named[0]) ? named[0]! : null
        if (id === null || listed.includes(id)) return { ok: false, problem: 'the warehouse list holds a warehouse without a usable id, or one twice' }
        listed.push(id)
      }
      const unlisted = config.warehouseIds.filter((w) => !listed.includes(w))
      if (unlisted.length > 0) return { ok: false, problem: `configured warehouse(s) ${unlisted.join(', ')} are not in the Mintsoft warehouse list` }
      let stockRow = false
      let onHand = 0
      for (const warehouse of listed) {
        let sent: Sent
        try {
          sent = await paced(() => sendMintsoftArchiveRequest(config, 'GET', '/api/Product/StockLevels', { WarehouseId: warehouse }, undefined, deps))
        } catch {
          return { ok: false, problem: `the stock of warehouse ${warehouse} could not be read` }
        }
        if (sent.status !== 200 || sent.json === undefined) return { ok: false, problem: `the stock of warehouse ${warehouse} could not be read (HTTP ${sent.status})` }
        let lines
        try {
          lines = normalizeMintsoftStockLevels(sent.json)
        } catch {
          return { ok: false, problem: `the stock of warehouse ${warehouse} is unreadable` }
        }
        let rows = 0
        for (const line of lines) {
          const raw = record(line.raw)
          const rowId = raw === null ? null : idOf(raw.ProductId)
          if (rowId !== productId) {
            if (line.sku === sku.trim()) return { ok: false, problem: `the stock of warehouse ${warehouse} holds the SKU under another product id (${rowId ?? 'none'}), not product ${productId}` }
            continue
          }
          // A repeated row is refused on its second occurrence, before its SKU is compared: the normalizer already refuses an exact repeat, so the
          // repeat that reaches here differs in SKU spelling (case), and it is reported as the repeat it is.
          rows++
          if (rows > 1) return { ok: false, problem: `product ${productId} appears more than once in the stock of warehouse ${warehouse}` }
          if (raw!.WarehouseId !== Number(warehouse) || raw!.ClientId !== client) return { ok: false, problem: `a stock row of warehouse ${warehouse} for product ${productId} does not name that warehouse and our client` }
          if (line.sku !== sku.trim()) return { ok: false, problem: `the stock of warehouse ${warehouse} names product ${productId} under another SKU` }
          onHand += line.onHand
        }
        if (rows === 1 && config.warehouseIds.includes(warehouse)) stockRow = true
      }
      return { ok: true, value: { stockRow, onHand } }
    },
    async setDiscontinued(productId: string, sku: string) {
      return paced(() => discontinueMintsoftProduct(config, productId, sku, deps))
    },
    changedFields: changedMintsoftProductFields,
    preflight: (facts) => archivePreflight(config, deps.env, facts),
    judgeSwitchoverCheck: (row, now) => archiveSwitchoverCheckEvidence(row, deps.env, now),
  }
}

/**
 * THE COMMAND'S MINTSOFT WIRING (#1128 R1 LOW-7): the credentials file is parsed ONCE, and that one configuration feeds both the census the plan is made
 * from and the writer, so the plan's token (client id, origin) and the writes are about the same tenant. A second, different file is refused.
 */
export function createMintsoftArchiveWiring(seams: {
  readConfig?: (file: string) => MintsoftReviewConfig
  readCensus?: typeof readMintsoftProductCensus
  writerDeps?: Omit<MintsoftArchiveWriterDeps, 'env'>
} = {}): { reader: WmsCensusReader; openWriter: WmsArchiveOpenWriter } {
  let parsed: { file: string; config: MintsoftReviewConfig } | null = null
  const configOf = (file: string): MintsoftReviewConfig => {
    if (parsed !== null) {
      if (parsed.file !== file) throw new MintsoftReviewRefused('the writer must use the credentials file the plan was made from')
      return parsed.config
    }
    const config = (seams.readConfig ?? readMintsoftReviewConfig)(file)
    parsed = { file, config }
    return config
  }
  return {
    reader: {
      flag: '--mintsoft-env-file',
      label: 'Mintsoft',
      read: async (file) => {
        try {
          return await (seams.readCensus ?? readMintsoftProductCensus)(configOf(file))
        } catch (error) {
          // Both messages are written to carry no key, URL or body.
          if (error instanceof MintsoftReviewRefused) throw new WmsCensusRefusedError(`refused before any request: ${error.message}`)
          if (error instanceof MintsoftReviewFailed) throw new WmsCensusFailedError(error.message)
          throw new WmsCensusFailedError('the product census could not be read')
        }
      },
    },
    openWriter: (file, targetEnv) => {
      try {
        return createMintsoftArchiveWriter(configOf(file), { ...seams.writerDeps, env: targetEnv })
      } catch (error) {
        if (error instanceof MintsoftReviewRefused) throw new WmsCensusRefusedError(`refused before any request: ${error.message}`)
        throw error
      }
    },
  }
}
