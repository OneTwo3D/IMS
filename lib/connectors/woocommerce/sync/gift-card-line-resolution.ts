/**
 * AN OPERATOR'S GIFT-CARD ANSWER FOR ONE ORDER LINE.
 *
 * The storefront plugin writes `_o3d_is_voucher` yes/no on every order line, but `unknown` on a custom line and on a line whose product was deleted, and IMS holds no product-level gift-card marker to settle it.
 * Once the cut-in is set such a line refuses its order for good (`gift_card_flag_missing`): re-importing re-reads the same `unknown`. This is the way out: an operator with the sync permission, freshly
 * authenticated, marks the line as a gift card or not, and the regime builder uses that answer for that line.
 *
 * WHAT AN ANSWER IS. One row per (connector, WooCommerce order id, WooCommerce line item id), carrying the answer, who gave it and when. It is keyed by the store's own ids, so it survives a re-import and needs no
 * local line. A changed answer overwrites the row (the activity log keeps every answer with its author).
 *
 * WHAT AN ANSWER IS NOT. It never overrides a readable `yes` or `no` from the plugin: it fills a gap, nothing more. An `unknown` line with no answer stays `unknown` and keeps refusing; there is no default.
 * An order whose regime is already stamped is decided for good, so no answer is taken for it (the stamp is write-once).
 */
import type { Prisma } from '@/app/generated/prisma/client'
import type { GoodsLineFact } from '@/lib/domain/accounting/eu-vat-regime'
import { EU_VAT_TREATMENT_PAYLOAD_KEY } from '@/lib/domain/accounting/eu-vat-treatment'
import { getSettingValues } from '@/lib/settings-store'
import { heldSalesInvoiceQueueWhere } from './held-sales-invoice'
import { normaliseStoreIdentity } from '../tax-rate-plan'

export const GIFT_CARD_RESOLUTION_CONNECTOR = 'woocommerce'

export type GiftCardResolutionClient = Pick<Prisma.TransactionClient, 'euVatGiftCardLineResolution'>

/**
 * THE STORE AN ANSWER BELONGS TO: the normalised URL of the WooCommerce store configured now (`normaliseStoreIdentity`, the same identity the tax-rate mappings and the tax-rate writer bind their rows to, `store_identity`).
 * A WooCommerce order id and line item id mean something only inside one store, so an answer is written with this identity, read only under it, and deleted when the store is rebound or the data is reset. Null (no usable
 * store URL, or the setting cannot be read) means no answer can be written or read: the lines stay unsettled and keep refusing.
 */
export async function currentGiftCardStoreIdentity(): Promise<string | null> {
  try {
    const values = await getSettingValues(['wc_url'])
    return normaliseStoreIdentity(values.get('wc_url') ?? '')
  } catch {
    return null
  }
}

/** The answers recorded for one order in one store, by WooCommerce line item id. */
export async function loadGiftCardLineResolutions(client: Partial<GiftCardResolutionClient>, storeIdentity: string | null, externalOrderId: string): Promise<Map<number, boolean>> {
  const delegate = client.euVatGiftCardLineResolution
  // A client that cannot read answers, or no known store, has none: the lines stay unknown and keep refusing (fail closed).
  if (!delegate || storeIdentity === null) return new Map()
  const rows = await delegate.findMany({ where: { connector: GIFT_CARD_RESOLUTION_CONNECTOR, storeIdentity, externalOrderId }, select: { externalLineItemId: true, isGiftCard: true } })
  return new Map(rows.map((row) => [row.externalLineItemId, row.isGiftCard]))
}

/** What a regime input was built from, so the stamp can prove under the order lock that nothing it rested on has changed. */
export type GiftCardAnswersUsed = { storeIdentity: string | null; unknownLineIds: number[]; answers: Map<number, boolean> }

/** The answers for the unknown lines only (the only ones that can change a decision). */
function forUnknownLines(answers: ReadonlyMap<number, boolean>, unknownLineIds: readonly number[]): Map<number, boolean> {
  return new Map(unknownLineIds.flatMap((id) => (answers.has(id) ? [[id, answers.get(id)!] as [number, boolean]] : [])))
}

export function giftCardAnswersUsed(storeIdentity: string | null, lines: readonly GoodsLineFact[], answers: ReadonlyMap<number, boolean>): GiftCardAnswersUsed {
  const unknownLineIds = lines.flatMap((line) => (line.lineId !== undefined && (line.voucherStrict ?? 'unknown') === 'unknown' ? [line.lineId] : []))
  return { storeIdentity, unknownLineIds, answers: forUnknownLines(answers, unknownLineIds) }
}

/**
 * Called INSIDE the order-locked stamp transaction: reads the answers again through the transaction and says whether they, or the store they are read under, differ from what the regime input was built from. The answer
 * action takes the same order row lock (`lockSalesOrder`) before it writes, so an answer cannot change between this read and the stamp's commit; one that changed before it is seen here and the stamp is not written.
 */
export async function giftCardAnswersChanged(client: Partial<GiftCardResolutionClient>, externalOrderId: string, used: GiftCardAnswersUsed): Promise<boolean> {
  if (used.unknownLineIds.length === 0) return false
  const storeNow = await currentGiftCardStoreIdentity()
  if (storeNow !== used.storeIdentity) return true
  const fresh = forUnknownLines(await loadGiftCardLineResolutions(client, storeNow, externalOrderId), used.unknownLineIds)
  if (fresh.size !== used.answers.size) return true
  for (const [id, answer] of fresh) if (used.answers.get(id) !== answer) return true
  return false
}

/** Thrown from inside the stamp transaction when an answer changed after the regime input was built: nothing is stamped (the transaction rolls back) and the next import decides with the current answer. */
export class GiftCardAnswersChangedError extends Error {
  constructor() { super('a gift-card answer for this order changed while its EU VAT regime was being decided') }
}

/** Pure: a line whose flag the plugin did not settle takes the operator's answer for it; every other line is returned as it is. */
export function applyGiftCardLineResolutions(lines: readonly GoodsLineFact[], answers: ReadonlyMap<number, boolean>): GoodsLineFact[] {
  if (answers.size === 0) return [...lines]
  return lines.map((line) => {
    if (line.lineId === undefined || (line.voucherStrict ?? 'unknown') !== 'unknown') return line
    const answer = answers.get(line.lineId)
    if (answer === undefined) return line
    const flag = answer ? 'yes' : 'no'
    return { ...line, voucher: flag, voucherStrict: flag }
  })
}

/**
 * The held invoices an operator can answer for: a PENDING hold whose parked marker says the treatment refused it AND flags unsettled gift-card lines (`giftCardUnsettled`, written with `giftCardLineIds` when the refusal is
 * `gift_card_flag_missing`). Decided in the database, so a page or a count over it is never diluted by other refusals.
 */
export function giftCardUnsettledHoldWhere(): Prisma.ShoppingSyncLogWhereInput {
  const at = (key: string) => ['accountingPayload', EU_VAT_TREATMENT_PAYLOAD_KEY, key]
  return {
    AND: [
      heldSalesInvoiceQueueWhere(),
      { payload: { path: at('reason'), equals: 'treatment_refused' } },
      { payload: { path: at('giftCardUnsettled'), equals: true } },
    ],
  }
}
