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
import type { WmsConnector } from '@/lib/connectors/wms/types'
import { contentValueHash, type ProductContentSnapshot } from '@/lib/domain/product-content/snapshot'
import { explainProducerDisposition, type ProducerDecisionContext } from '@/lib/security/producer-disposition'
import { PRODUCER_REASON_TEXT } from '@/lib/security/producer-disposition-constants'
import { MINTSOFT_CONTENT_FIELDS, MINTSOFT_CONTENT_WIRE, type MintsoftContentField } from '../api/product-content'

export type ContentSyncState = {
  /** Field -> hash of the value Mintsoft last accepted. */
  pushed: Partial<Record<MintsoftContentField, string>>
  /** Field -> hash of the value last recorded as a shadow, so an unchanged shadow is not recorded again every run. */
  shadowed: Partial<Record<MintsoftContentField, string>>
}

export type MintsoftContentProjection = Partial<Record<MintsoftContentField, string>>

export type ContentOutcomeKind =
  | 'no_content'
  | 'no_link'
  | 'unchanged'
  | 'sent'
  | 'shadow'
  | 'shadow_repeat'
  | 'held'

export type ContentLineResult = {
  kind: ContentOutcomeKind
  fields: MintsoftContentField[]
  /** Operator text, from `describeContentOutcome` only. */
  reason: string
  payload: Prisma.InputJsonValue
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
  if (!isRecord(raw)) return { pushed: {}, shadowed: {} }
  return { pushed: readHashes(raw.pushed), shadowed: readHashes(raw.shadowed) }
}

/** The hub copy as the fields Mintsoft takes. Empty or missing content is absent from the result, never blank in it. */
export function projectContentForMintsoft(content: ProductContentSnapshot | null): MintsoftContentProjection {
  const projection: MintsoftContentProjection = {}
  if (!content) return projection
  if (content.longDescription) projection.description = content.longDescription
  if (content.shortDescription) projection.shortDescription = content.shortDescription
  const primary = content.images[0]?.url
  if (primary) projection.imageUrl = primary
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
}

async function saveState(linkId: string, state: ContentSyncState): Promise<void> {
  await db.wmsProductLink.update({
    where: { id: linkId },
    data: { contentSyncState: state as unknown as Prisma.InputJsonValue },
  })
}

export async function syncMintsoftProductContent(input: ContentSyncInput): Promise<ContentLineResult> {
  const result = (kind: ContentOutcomeKind, fields: MintsoftContentField[], extra: Record<string, unknown> = {}, detail?: string): ContentLineResult => ({
    kind,
    fields,
    reason: describeContentOutcome(kind, fields, detail),
    payload: { kind, fields, ...extra } as Prisma.InputJsonValue,
  })

  const projection = projectContentForMintsoft(input.content)
  if (Object.keys(projection).length === 0) return result('no_content', [])
  if (!input.link) return result('no_link', [])

  const state = readContentSyncState(input.link.contentSyncState)
  const changed = changedContentFields(projection, state)
  if (changed.length === 0) return result('unchanged', [])

  const decision = explainProducerDisposition('mintsoft', 'product.content', undefined, input.context ?? {})
  const live = decision.disposition === 'LIVE' && typeof input.connector.updateProductContent === 'function'
  const sendable = live ? changed.filter((field) => MINTSOFT_CONTENT_WIRE[field].verified) : []
  const toShadow = changed.filter((field) => !sendable.includes(field))

  let sentFields: MintsoftContentField[] = []
  let held: { message: string } | null = null
  if (sendable.length > 0) {
    const update: Parameters<NonNullable<ContentSyncInput['connector']['updateProductContent']>>[0] = {
      externalProductId: input.link.externalProductId,
      sku: input.product.sku,
    }
    for (const field of sendable) update[field] = projection[field]
    const sent = await input.connector.updateProductContent!(update)
    if (sent.sent) {
      sentFields = sendable
      for (const field of sendable) {
        state.pushed[field] = contentValueHash(projection[field]!)
        delete state.shadowed[field]
      }
    } else {
      held = { message: sent.message }
    }
  }

  const heldFields = held ? sendable : []
  const newShadows = toShadow.filter((field) => state.shadowed[field] !== contentValueHash(projection[field]!))
  for (const field of newShadows) state.shadowed[field] = contentValueHash(projection[field]!)
  if (sentFields.length > 0 || newShadows.length > 0) await saveState(input.link.id, state)

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
  if (sentFields.length > 0) {
    return result('sent', sentFields, extra, newShadows.length > 0 ? describeContentOutcome('shadow', newShadows, shadowDetail) : undefined)
  }
  if (held) return result('held', heldFields, extra, held.message)
  if (newShadows.length > 0) return result('shadow', newShadows, extra, shadowDetail)
  return result('shadow_repeat', toShadow, extra, shadowDetail)
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
