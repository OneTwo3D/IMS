/**
 * THE EU VAT REGIME STAMP: decide once, write once, never re-derive.
 *
 * `stampEuVatRegime` runs the pure resolver (eu-vat-regime.ts) on the facts it is given and records the answer on the sales order, in one row-locked transaction. From then on the
 * order's regime and VAT account are READ from the order: a credit note must not decide again, because the exchange rate on the day chose the regime and a later rate could choose
 * the other. This is the IMS counterpart of the storefront plugin's `_o3d_ioss_vat_account` order meta, in the same form (the account code), so a credit note on an order the plugin
 * handled before cut-over can use either.
 *
 * WHAT IS STAMPED. A SCHEME decision stamps `euVatRegime`, `euVatLineAccount`, `euVatRegimeStampedAt` and `euVatRegimeBasis`. A SKIP stamps `euVatRegimeStampedAt` and the basis only (regime and
 * account stay NULL: "decided, not on the scheme"). A REFUSAL stamps NOTHING: the order stays undecided and is decided afresh when whatever it lacked (a mapping, an exchange rate) is supplied.
 *
 * THE WRITE IS A COMPARE-AND-SET on an unstamped order, under the order's row lock. Two builders racing agree on whichever wrote first; neither overwrites. A stamped order returns the stamp as
 * it is and does not even look at the facts it was handed. The database refuses a regime without an account and a marker (sales_orders_eu_vat_regime_stamp_shape).
 *
 * NOT WIRED YET. Nothing in the invoice or credit-note builders calls this, and no posted payload reads the stamp: the call site is the invoice treatment that follows.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { resolveEuVatRegime, type EuVatRegimeDecision, type EuVatRegimeInput, type EuVatRegimeName, type RegimeWarning, type SchemeBasis, type SkipReason, type RefusalCode } from './eu-vat-regime'

export type StampedRegime = {
  /** NULL when the order was decided to be outside the scheme. */
  regime: EuVatRegimeName | null
  vatAccount: string | null
  stampedAt: Date
}

export type StampOutcome =
  /** This call decided and wrote the stamp. */
  | { kind: 'stamped'; stamp: StampedRegime; warnings: RegimeWarning[]; skipReason: SkipReason | null }
  /** The order was already stamped (by an earlier call or a racing one): the stamp as it is, nothing re-derived. */
  | { kind: 'already_stamped'; stamp: StampedRegime }
  /** The order cannot be classified: nothing was written. */
  | { kind: 'refused'; code: RefusalCode; reason: string }
  | { kind: 'order_not_found' }

const REGIMES: readonly string[] = ['IOSS', 'VOEC', 'DDP']

export type StoredEuVatRegimeBasis = {
  version: 1
  outcome: 'SCHEME' | 'SKIP'
  skipReason?: SkipReason
  vatExemptB2b?: boolean
  scheme?: SchemeBasis
  warnings: RegimeWarning[]
}

function toStored(decision: Exclude<EuVatRegimeDecision, { kind: 'REFUSE' }>): StoredEuVatRegimeBasis {
  if (decision.kind === 'SKIP') return { version: 1, outcome: 'SKIP', skipReason: decision.reason, vatExemptB2b: decision.vatExemptB2b, warnings: decision.warnings }
  return { version: 1, outcome: 'SCHEME', scheme: decision.basis, warnings: decision.warnings }
}

/** The stamp on an order, or null when it has none (never decided). Reads only; takes no lock. */
export async function readEuVatRegimeStamp(
  client: Pick<Prisma.TransactionClient, 'salesOrder'>,
  orderId: string,
): Promise<StampedRegime | null> {
  const row = await client.salesOrder.findUnique({
    where: { id: orderId },
    select: { euVatRegime: true, euVatLineAccount: true, euVatRegimeStampedAt: true },
  })
  if (!row || row.euVatRegimeStampedAt === null) return null
  return { regime: row.euVatRegime, vatAccount: row.euVatLineAccount, stampedAt: row.euVatRegimeStampedAt }
}

/**
 * Decide and stamp, once. Must run inside a transaction; it takes the order's row lock first.
 * `buildInput` is called only for an UNSTAMPED order, so a stamped order costs no fact gathering and cannot be re-decided by a later rate.
 */
export async function stampEuVatRegime(
  tx: Prisma.TransactionClient,
  orderId: string,
  buildInput: () => EuVatRegimeInput | Promise<EuVatRegimeInput>,
  now: Date,
): Promise<StampOutcome> {
  await lockSalesOrder(tx, orderId)
  const row = await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: { euVatRegime: true, euVatLineAccount: true, euVatRegimeStampedAt: true },
  })
  if (!row) return { kind: 'order_not_found' }
  if (row.euVatRegimeStampedAt !== null) {
    return { kind: 'already_stamped', stamp: { regime: row.euVatRegime, vatAccount: row.euVatLineAccount, stampedAt: row.euVatRegimeStampedAt } }
  }

  const decision = resolveEuVatRegime(await buildInput())
  if (decision.kind === 'REFUSE') return { kind: 'refused', code: decision.code, reason: decision.reason }

  const regime = decision.kind === 'SCHEME' ? decision.regime : null
  const vatAccount = decision.kind === 'SCHEME' ? decision.vatAccount : null
  if (regime !== null && !REGIMES.includes(regime)) throw new Error(`unknown EU VAT regime ${String(regime)}`)
  // Compare-and-set: matches only an order nobody has stamped. The row lock above already serialises writers; this keeps the guarantee if a caller ever skips it.
  const written = await tx.salesOrder.updateMany({
    where: { id: orderId, euVatRegimeStampedAt: null },
    data: {
      euVatRegime: regime,
      euVatLineAccount: vatAccount,
      euVatRegimeStampedAt: now,
      euVatRegimeBasis: toStored(decision) as unknown as Prisma.InputJsonValue,
    },
  })
  if (written.count !== 1) {
    const current = await readEuVatRegimeStamp(tx, orderId)
    if (current === null) return { kind: 'order_not_found' }
    return { kind: 'already_stamped', stamp: current }
  }
  return {
    kind: 'stamped',
    stamp: { regime, vatAccount, stampedAt: now },
    warnings: decision.warnings,
    skipReason: decision.kind === 'SKIP' ? decision.reason : null,
  }
}
