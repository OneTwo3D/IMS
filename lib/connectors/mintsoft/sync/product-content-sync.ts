/**
 * MINTSOFT PRODUCT CONTENT SYNC: IMS HUB COPY -> MINTSOFT, THROUGH THE PRODUCER DISPOSITION.
 *
 * Content (description, short description, picture) is authored in WooCommerce, held in IMS (the hub) and sent from
 * here to Mintsoft. One call per product, in this order, and the order is the safety argument:
 *
 *   1. Project the hub copy onto the fields Mintsoft takes. A field that is empty is NOT in the projection, so an
 *      empty value is never compared, planned or sent (the never-empty rule; the wire builder refuses it too).
 *   2. Without a Mintsoft link the product does not exist there yet: product creation is the product-upsert's job
 *      and content follows it. Nothing is written.
 *   3. Change detection, per field, against what was last accepted: only changed fields go further.
 *   4. `producerDisposition('mintsoft', 'product.content')` decides LIVE or SHADOW from the environment alone. SHADOW
 *      records what would have been sent (a `shadow` sync-log row) and returns; no connector method is called.
 *      A field whose Mintsoft wire name is not verified is a shadow even when the disposition is LIVE.
 *   5. LIVE sends only the changed, verified fields through the connector, which goes through connectorFetch and the
 *      outbound-write hold. A refusal by the hold is recorded as held and changes no state, so the field is offered
 *      again on the next run.
 *
 * The product META (name, barcode, weight, customs data) is not touched here: it stays with the product upsert and
 * its own owner. Nothing here writes to WooCommerce.
 */

import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import type { WmsConnector, WmsWriteClearance } from '@/lib/connectors/wms/types'
import { contentValueHash, type ProductContentSnapshot } from '@/lib/domain/product-content/snapshot'
import { explainProducerDisposition, type ProducerDecisionContext } from '@/lib/security/producer-disposition'
import { PRODUCER_REASON_TEXT } from '@/lib/security/producer-disposition-constants'
import { isMintsoftContentRefusal, MINTSOFT_CONTENT_FIELDS, MINTSOFT_CONTENT_WIRE, type MintsoftContentField } from '../api/product-content'
import { mintsoftProducerSeam } from '../producer-seam'

export type ContentSyncState = {
  /** Field -> hash of the value Mintsoft last accepted. */
  pushed: Partial<Record<MintsoftContentField, string>>
  /** Field -> hash of the value last recorded as a shadow, so an unchanged shadow is not recorded again every run. */
  shadowed: Partial<Record<MintsoftContentField, string>>
  /**
   * Field -> the value Mintsoft ANSWERED "no" to (`Success: false`): its hash, how many times it refused that same value, and when it last did.
   * The record is what stops IMS re-POSTing a refused value to Mintsoft on every run: it is retried with a growing back-off and then not at all.
   * A different value for the field starts again.
   */
  refused: Partial<Record<MintsoftContentField, ContentRefusal>>
}

export type ContentRefusal = { hash: string; count: number; at: string }

/** Answered refusals of one value before IMS stops sending it and raises a discrepancy (the customs-clear pattern: five answered refusals). */
export const CONTENT_REFUSAL_MAX_ATTEMPTS = 5
/** Minutes to wait after the Nth refusal of the same value before offering it again (index N-1). The last entry is never reached: the cap comes first. */
export const CONTENT_REFUSAL_BACKOFF_MINUTES = [30, 120, 480, 1440, 1440] as const

export type MintsoftContentProjection = Partial<Record<MintsoftContentField, string>>

export type ContentOutcomeKind =
  | 'no_content'
  | 'no_link'
  | 'unchanged'
  | 'sent'
  | 'shadow'
  | 'shadow_repeat'
  | 'held'
  /** Mintsoft answered Success:false in this run: recorded, and the next retry is backed off. */
  | 'refused'
  /** Every changed field is waiting out a refusal back-off, or has spent its retry cap: nothing was sent. */
  | 'refused_wait'

export type ContentLineResult = {
  kind: ContentOutcomeKind
  fields: MintsoftContentField[]
  /** Changed fields that were NOT sent in this run (a shadow), whatever the line's own kind says: a send does not hide them. */
  shadowedFields: MintsoftContentField[]
  /** Operator text, from `describeContentOutcome` only. */
  reason: string
  payload: Prisma.InputJsonValue
  /** Fields whose refusal cap is spent: the caller raises the operator discrepancy for them. */
  capReachedFields?: MintsoftContentField[]
  /** True when a stored refusal record was dropped this run (the value changed or was accepted): the caller may resolve the discrepancy. */
  refusalCleared?: boolean
}

const FIELD_LABEL: Record<MintsoftContentField, string> = {
  description: 'description',
  shortDescription: 'short description',
  imageUrl: 'picture',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readHashes(value: unknown): Partial<Record<MintsoftContentField, string>> {
  const out: Partial<Record<MintsoftContentField, string>> = {}
  if (!isRecord(value)) return out
  for (const field of MINTSOFT_CONTENT_FIELDS) {
    const hash = value[field]
    if (typeof hash === 'string') out[field] = hash
  }
  return out
}

export function readContentSyncState(raw: unknown): ContentSyncState {
  if (!isRecord(raw)) return { pushed: {}, shadowed: {}, refused: {} }
  const refused: ContentSyncState['refused'] = {}
  if (isRecord(raw.refused)) {
    for (const field of MINTSOFT_CONTENT_FIELDS) {
      const entry = raw.refused[field]
      if (isRecord(entry) && typeof entry.hash === 'string' && typeof entry.count === 'number' && typeof entry.at === 'string') refused[field] = { hash: entry.hash, count: entry.count, at: entry.at }
    }
  }
  return { pushed: readHashes(raw.pushed), shadowed: readHashes(raw.shadowed), refused }
}

/** Whether the refusal record of a field holds for the value now projected: only the SAME value is held back; a changed value is offered at once. */
function refusalFor(state: ContentSyncState, field: MintsoftContentField, projection: MintsoftContentProjection): ContentRefusal | null {
  const refusal = state.refused[field]
  const value = projection[field]
  return refusal && value !== undefined && refusal.hash === contentValueHash(value) ? refusal : null
}

export function contentRefusalCapSpent(refusal: ContentRefusal | null): boolean {
  return refusal !== null && refusal.count >= CONTENT_REFUSAL_MAX_ATTEMPTS
}

function contentRefusalWaiting(refusal: ContentRefusal | null, now: Date): boolean {
  if (!refusal) return false
  if (contentRefusalCapSpent(refusal)) return true
  const waitMinutes = CONTENT_REFUSAL_BACKOFF_MINUTES[Math.min(refusal.count, CONTENT_REFUSAL_BACKOFF_MINUTES.length) - 1] ?? 0
  return now.getTime() < Date.parse(refusal.at) + waitMinutes * 60_000
}

/** The hub copy as the fields Mintsoft takes. Empty or missing content is absent from the result, never blank in it. */
export function projectContentForMintsoft(content: ProductContentSnapshot | null): MintsoftContentProjection {
  const projection: MintsoftContentProjection = {}
  if (!content) return projection
  // `.trim() !== ''`, not truthiness: the hub normalises on the way in, but this is the last place before the wire and
  // a whitespace-only value is as empty as ''.
  const present = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''
  if (present(content.longDescription)) projection.description = content.longDescription
  if (present(content.shortDescription)) projection.shortDescription = content.shortDescription
  const primary = content.images[0]?.url
  if (present(primary)) projection.imageUrl = primary
  return projection
}

/** Fields whose projected value differs from what was last accepted. Idempotent: an accepted value is never listed. */
export function changedContentFields(projection: MintsoftContentProjection, state: ContentSyncState): MintsoftContentField[] {
  return MINTSOFT_CONTENT_FIELDS.filter((field) => {
    const value = projection[field]
    return value !== undefined && contentValueHash(value) !== state.pushed[field]
  })
}

function labelList(fields: readonly MintsoftContentField[]): string {
  return fields.map((field) => FIELD_LABEL[field]).join(', ')
}

/**
 * The ONE source of the operator-facing words for a content outcome (sync-log reasons and the job message). It says
 * "not sent" only for the outcomes whose code path makes no connector call (shadow) or whose request the hold
 * refused before it left IMS (held); it never says a Mintsoft value was cleared, because none ever is.
 */
export function describeContentOutcome(
  kind: ContentOutcomeKind,
  fields: readonly MintsoftContentField[],
  detail?: string,
): string {
  switch (kind) {
    case 'no_content': return 'No content from WooCommerce to send yet.'
    case 'no_link': return 'The product is not in Mintsoft yet; its content is sent after the product exists there.'
    case 'unchanged': return 'Content already matches what Mintsoft last accepted.'
    case 'sent': return `Content sent to Mintsoft: ${labelList(fields)}. ${detail ?? ''}`.trim()
    case 'shadow': return `Content NOT sent (recorded only): ${labelList(fields)}. ${detail ?? ''}`.trim()
    case 'shadow_repeat': return `Content still not sent: ${labelList(fields)} (already recorded). ${detail ?? ''}`.trim()
    case 'refused': return `Content NOT accepted by Mintsoft (it answered Success:false): ${labelList(fields)}. ${detail ?? ''}`.trim()
    case 'refused_wait': return `Content not re-sent: Mintsoft refused ${labelList(fields)} and IMS is waiting before trying again, or has stopped trying. ${detail ?? ''}`.trim()
    case 'held': return `Content NOT sent: ${labelList(fields)}. The outbound-write hold refused the request before it left IMS. ${detail ?? ''}`.trim()
  }
}

function preview(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}...` : value
}

export type ContentSyncInput = {
  product: { id: string; sku: string }
  link: { id: string; externalProductId: string; contentSyncState: unknown } | null
  content: ProductContentSnapshot | null
  connector: Pick<WmsConnector, 'updateProductContent'>
  /** Environment and clock for the disposition; defaults to the process. Tests pass their own. */
  context?: ProducerDecisionContext
  /**
   * Where the per-field state is kept; defaults to the product link row. Tests pass a recorder. `context.previous` is the raw state this run read
   * and `context.sent` the fields it sent: the default saver writes only if the stored state is still `previous`.
   */
  saveState?: (linkId: string, state: ContentSyncState, context: { previous: unknown; sent: readonly MintsoftContentField[] }) => Promise<void>
  /** Which fields are verified on the wire; defaults to the connector's own contract. */
  wireContract?: Readonly<Record<MintsoftContentField, { verified: boolean }>>
  /** The clock for the refusal back-off; defaults to now. Tests pass their own. */
  now?: Date
}

/**
 * COMPARE-AND-SWAP SAVE. Two runs of the same product (the cron and a manual run) can both read the state, both send, and the slower save would
 * overwrite the other's hash with one Mintsoft no longer holds. The write therefore lands only if the stored state is still the one this run read.
 * When it is not, another run moved it: the fields this run sent have no trustworthy hash, so their `pushed` hash is DROPPED from the fresh state and the
 * next run offers (and sends) the current value again, which converges on what the hub holds.
 */
async function saveStateToLink(linkId: string, state: ContentSyncState, context: { previous: unknown; sent: readonly MintsoftContentField[] }): Promise<void> {
  const next = state as unknown as Prisma.InputJsonValue
  const swapped = await db.wmsProductLink.updateMany({
    where: { id: linkId, contentSyncState: context.previous === null || context.previous === undefined ? { equals: Prisma.DbNull } : { equals: context.previous as Prisma.InputJsonValue } },
    data: { contentSyncState: next },
  })
  if (swapped.count === 1) return
  const row = await db.wmsProductLink.findUnique({ where: { id: linkId }, select: { contentSyncState: true } })
  if (!row) return
  const fresh = readContentSyncState(row.contentSyncState)
  // Drop this run's hash only where the row does NOT already hold the same value: when both runs sent the same value, the other run's hash is right and
  // dropping it would cause one redundant send. Hashes this run computed that the row lacks (a shadow, a refusal) are merged in rather than thrown away.
  const mine = state
  for (const field of context.sent) {
    if (fresh.pushed[field] !== mine.pushed[field]) delete fresh.pushed[field]
  }
  for (const field of MINTSOFT_CONTENT_FIELDS) {
    if (fresh.shadowed[field] === undefined && mine.shadowed[field] !== undefined && !context.sent.includes(field)) fresh.shadowed[field] = mine.shadowed[field]
    const refusal = mine.refused[field]
    if (refusal && (fresh.refused[field]?.hash !== refusal.hash || fresh.refused[field]!.count < refusal.count)) fresh.refused[field] = refusal
  }
  // Conditional on the state just read: if a third run saved in between, this write misses and the next run converges from whatever is stored.
  await db.wmsProductLink.updateMany({
    where: { id: linkId, contentSyncState: row.contentSyncState === null ? { equals: Prisma.DbNull } : { equals: row.contentSyncState as Prisma.InputJsonValue } },
    data: { contentSyncState: fresh as unknown as Prisma.InputJsonValue },
  })
}

export async function syncMintsoftProductContent(input: ContentSyncInput): Promise<ContentLineResult> {
  const result = (kind: ContentOutcomeKind, fields: MintsoftContentField[], extra: Record<string, unknown> = {}, detail?: string): ContentLineResult => ({
    kind,
    fields,
    reason: describeContentOutcome(kind, fields, detail),
    payload: { kind, fields, ...extra } as Prisma.InputJsonValue,
    shadowedFields: [],
  })

  const projection = projectContentForMintsoft(input.content)
  if (Object.keys(projection).length === 0) return result('no_content', [])
  if (!input.link) return result('no_link', [])

  const state = readContentSyncState(input.link.contentSyncState)
  const now = input.now ?? new Date()
  // A refusal record holds only for the value it was recorded for. A field whose value moved (or that now matches what Mintsoft holds) drops its record.
  let refusalCleared = false
  for (const field of MINTSOFT_CONTENT_FIELDS) {
    if (state.refused[field] && refusalFor(state, field, projection) === null) { delete state.refused[field]; refusalCleared = true }
  }
  const changed = changedContentFields(projection, state)
  if (changed.length === 0) {
    const line = result('unchanged', [])
    if (refusalCleared) {
      await (input.saveState ?? saveStateToLink)(input.link.id, state, { previous: input.link.contentSyncState ?? null, sent: [] })
      line.refusalCleared = true
    }
    return line
  }
  // Fields Mintsoft refused (the same value) and that are backed off or past the cap: neither sent nor shadowed this run.
  const waiting = changed.filter((field) => contentRefusalWaiting(refusalFor(state, field, projection), now))
  const capReachedFields = changed.filter((field) => contentRefusalCapSpent(refusalFor(state, field, projection)))

  const decision = explainProducerDisposition('mintsoft', 'product.content', undefined, input.context ?? {})
  const contract = input.wireContract ?? MINTSOFT_CONTENT_WIRE
  // THE PRODUCER SEAM, asked only when this decision is LIVE and a field could really be sent: it yields the clearance the connector
  // write needs. It agrees with the decision above by construction (the seam adds only the enforcement switch), so it can only
  // withhold a write the decision allowed in the instant between the two reads, and then the fields are kept as a shadow.
  let cleared: { proceed: true; clearance: WmsWriteClearance<'product.content'> } | null = null
  if (decision.disposition === 'LIVE' && typeof input.connector.updateProductContent === 'function' && changed.some((field) => contract[field].verified && !waiting.includes(field))) {
    const seam = await mintsoftProducerSeam({
      operation: 'product.content',
      subjectType: 'Product',
      subjectId: input.product.id,
      payload: Object.fromEntries(changed.filter((field) => contract[field].verified && !waiting.includes(field)).map((field) => [field, projection[field]])),
      summary: { sku: input.product.sku },
      context: input.context,
    })
    if (seam.proceed) cleared = seam
  }
  const live = cleared !== null
  const sendable = live ? changed.filter((field) => contract[field].verified && !waiting.includes(field)) : []
  const toShadow = changed.filter((field) => !sendable.includes(field) && !waiting.includes(field))

  let sentFields: MintsoftContentField[] = []
  let held: { message: string } | null = null
  if (sendable.length > 0 && cleared !== null) {
    const update: Parameters<NonNullable<ContentSyncInput['connector']['updateProductContent']>>[0] = {
      externalProductId: input.link.externalProductId,
      sku: input.product.sku,
    }
    for (const field of sendable) update[field] = projection[field]
    let sent: Awaited<ReturnType<NonNullable<ContentSyncInput['connector']['updateProductContent']>>>
    try {
      sent = await input.connector.updateProductContent!(update, cleared.clearance)
    } catch (error) {
      if (!isMintsoftContentRefusal(error)) throw error
      // Mintsoft ANSWERED no. Record it against the value (a repeat of the same value counts up) so the next runs back off and then stop, and
      // surface the refusal as this run's content error exactly as before.
      for (const field of sendable) {
        const hash = contentValueHash(projection[field]!)
        const previous = state.refused[field]
        state.refused[field] = { hash, count: (previous?.hash === hash ? previous.count : 0) + 1, at: now.toISOString() }
      }
      await (input.saveState ?? saveStateToLink)(input.link.id, state, { previous: input.link.contentSyncState ?? null, sent: [] })
      return {
        ...result('refused', sendable, { refused: sendable, refusalCounts: Object.fromEntries(sendable.map((field) => [field, state.refused[field]!.count])) }, error instanceof Error ? error.message : undefined),
        shadowedFields: toShadow,
        capReachedFields: sendable.filter((field) => contentRefusalCapSpent(state.refused[field] ?? null)),
      }
    }
    if (sent.sent) {
      sentFields = sendable
      for (const field of sendable) {
        state.pushed[field] = contentValueHash(projection[field]!)
        delete state.shadowed[field]
        if (state.refused[field]) { delete state.refused[field]; refusalCleared = true }
      }
    } else {
      held = { message: sent.message }
    }
  }

  const heldFields = held ? sendable : []
  const newShadows = toShadow.filter((field) => state.shadowed[field] !== contentValueHash(projection[field]!))
  for (const field of newShadows) state.shadowed[field] = contentValueHash(projection[field]!)
  if (sentFields.length > 0 || newShadows.length > 0 || refusalCleared) await (input.saveState ?? saveStateToLink)(input.link.id, state, { previous: input.link.contentSyncState ?? null, sent: sentFields })

  const why = PRODUCER_REASON_TEXT[decision.reason]
  const shadowDetail = live
    ? 'The field name Mintsoft expects for it is not verified yet, so it is held back even though IMS may write.'
    : `IMS is not the live writer for this yet: ${why}.`

  // One result per product: a send beats a shadow beats a hold in what the line says; the payload carries all of it.
  const extra = {
    sent: sentFields,
    shadowed: toShadow,
    held: heldFields,
    disposition: decision.disposition,
    dispositionReason: decision.reason,
    wouldSend: Object.fromEntries(toShadow.concat(heldFields).map((field) => [MINTSOFT_CONTENT_WIRE[field].wire, preview(projection[field]!)])),
  }
  // A send never hides what was NOT sent: every field still a shadow is named on the line, whether or not it was recorded this run.
  const withShadow = (line: ContentLineResult): ContentLineResult => ({ ...line, shadowedFields: toShadow, capReachedFields, refusalCleared })
  if (sentFields.length > 0) {
    return withShadow(result('sent', sentFields, extra, toShadow.length > 0 ? describeContentOutcome('shadow', toShadow, shadowDetail) : undefined))
  }
  if (held) return withShadow(result('held', heldFields, extra, held.message))
  if (waiting.length > 0 && newShadows.length === 0 && toShadow.length === 0) return withShadow(result('refused_wait', waiting, { ...extra, waiting }))
  if (newShadows.length > 0) return withShadow(result('shadow', newShadows, extra, shadowDetail))
  return withShadow(result('shadow_repeat', toShadow, extra, shadowDetail))
}

export type ContentRunCounters = { sent: number; shadowed: number; held: number; errors: number }

/**
 * The one sentence that summarises a run's content step, for the job message and the activity log. It claims
 * "not sent" only for shadowed and held products, and says nothing about Mintsoft values being cleared.
 */
export function describeContentRun(counters: ContentRunCounters | undefined): string {
  if (!counters || counters.sent + counters.shadowed + counters.held + counters.errors === 0) {
    return 'Content: nothing to send.'
  }
  const parts: string[] = []
  if (counters.sent > 0) parts.push(`${counters.sent} field${counters.sent === 1 ? '' : 's'} sent`)
  if (counters.shadowed > 0) parts.push(`${counters.shadowed} product${counters.shadowed === 1 ? '' : 's'} recorded but NOT sent (IMS is not the live writer yet)`)
  if (counters.held > 0) parts.push(`${counters.held} product${counters.held === 1 ? '' : 's'} NOT sent (refused by the outbound-write hold)`)
  if (counters.errors > 0) parts.push(`${counters.errors} failed`)
  return `Content: ${parts.join(', ')}.`
}
