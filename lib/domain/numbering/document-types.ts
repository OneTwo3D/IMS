/**
 * THE DOCUMENT TYPES IMS NUMBERS ITSELF, AND WHAT EACH ONE STARTS WITH.
 *
 * Only documents IMS mints are here. Sales INVOICE numbers are deliberately NOT: while the incumbent (Xeroom) owns
 * them (lib/security/writer-ownership-map.ts, `xero.sales.invoice`), IMS does not change how they are numbered, and
 * a WooCommerce order's invoice number is the storefront's own. Order numbers of orders imported from WooCommerce
 * are never minted here either: they are the storefront's number with a prefix.
 *
 * `defaultSegments` is the pattern a type uses until an operator sets one. It reproduces, byte for byte, what the
 * code minted before patterns existed, including the prefix configured under Settings > Company > Numbering, so
 * nothing changes unless a pattern is edited.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import type { DateBasis, PatternSegment } from './pattern'

export const NUMBERED_DOCUMENT_TYPES = ['sales_order', 'purchase_order', 'credit_note', 'shipment'] as const
export type NumberedDocumentType = (typeof NUMBERED_DOCUMENT_TYPES)[number]

export function isNumberedDocumentType(value: unknown): value is NumberedDocumentType {
  return typeof value === 'string' && (NUMBERED_DOCUMENT_TYPES as readonly string[]).includes(value)
}

type Tx = Prisma.TransactionClient

export type DocumentTypeSpec = {
  label: string
  description: string
  /** The clock the date tokens read. Unchanged from the code each type replaced, so a default stays byte-identical. */
  basis: DateBasis
  /** Which prefix of Settings > Company > Numbering the default pattern starts with; null: the type has no default number. */
  prefixKey: 'so_prefix' | 'po_prefix' | 'cn_prefix' | null
  /** The pattern of a type with no number of its own until an operator sets one: null. */
  defaultSegments: (prefix: string) => PatternSegment[] | null
  /** What guarantees two documents never share a number. */
  uniqueness: 'database' | 'application'
  /** A document of this type already carries this exact number. */
  exists: (tx: Tx, value: string) => Promise<boolean>
  /** Every number of this type that starts with the text, to find the highest counter in use. */
  listStartingWith: (tx: Tx, prefix: string) => Promise<string[]>
  /** The counter key the code before patterns kept, so a counter that already ran is carried over. */
  legacyCounterKey?: (scopeKey: string) => string
}

const lit = (text: string): PatternSegment[] => (text === '' ? [] : [{ kind: 'lit', text }])

/** `<prefix><YYYYMMDD>-<4 random characters>`: the shape of a manual sales order and of a purchase order. */
function datedRandom(prefix: string): PatternSegment[] {
  return [...lit(prefix), { kind: 'year4' }, { kind: 'month' }, { kind: 'day' }, { kind: 'lit', text: '-' }, { kind: 'rand', len: 4 }]
}

export const DOCUMENT_TYPE_SPECS: Readonly<Record<NumberedDocumentType, DocumentTypeSpec>> = {
  sales_order: {
    label: 'Sales order',
    description: 'Orders entered by hand in IMS. Orders imported from WooCommerce keep the storefront order number and are never renumbered.',
    basis: 'utc',
    prefixKey: 'so_prefix',
    defaultSegments: datedRandom,
    uniqueness: 'application',
    exists: async (tx, value) => (await tx.salesOrder.findFirst({ where: { orderNumber: value }, select: { id: true } })) !== null,
    listStartingWith: async (tx, prefix) => (await tx.salesOrder.findMany({ where: { orderNumber: { startsWith: prefix } }, select: { orderNumber: true } }))
      .map((r) => r.orderNumber ?? ''),
  },
  purchase_order: {
    label: 'Purchase order',
    description: 'Purchase orders and freight orders that IMS numbers. A reference typed in by a person is kept as typed.',
    basis: 'utc',
    prefixKey: 'po_prefix',
    defaultSegments: datedRandom,
    uniqueness: 'database',
    exists: async (tx, value) => (await tx.purchaseOrder.findUnique({ where: { reference: value }, select: { id: true } })) !== null,
    listStartingWith: async (tx, prefix) => (await tx.purchaseOrder.findMany({ where: { reference: { startsWith: prefix } }, select: { reference: true } }))
      .map((r) => r.reference),
  },
  credit_note: {
    label: 'Credit note',
    description: 'Credit notes IMS numbers for refunds. The number IMS records is the one it sends to the accounting system.',
    basis: 'local',
    prefixKey: 'cn_prefix',
    defaultSegments: (prefix) => [...lit(prefix), { kind: 'year4' }, { kind: 'lit', text: '-' }, { kind: 'seq', pad: 5 }],
    uniqueness: 'application',
    // soft-delete exception: numbering counts deleted refunds so a credit note number is never reused.
    // soft-delete exception (identity check): includes soft-deleted refunds on purpose, so a credit note number is never reused.
    exists: async (tx, value) => (await tx.salesOrderRefund.findFirst({ where: { creditNoteNumber: value }, select: { id: true } })) !== null,
    // soft-delete exception (identity check): includes soft-deleted refunds on purpose, so a credit note number is never reused.
    listStartingWith: async (tx, prefix) => (await tx.salesOrderRefund.findMany({ where: { creditNoteNumber: { startsWith: prefix } }, select: { creditNoteNumber: true } }))
      .map((r) => r.creditNoteNumber ?? ''),
    legacyCounterKey: (scopeKey) => `document_counter:credit_note:${scopeKey}`,
  },
  shipment: {
    label: 'Shipment',
    description: 'A reference for each shipment IMS creates. Shipments carry no number until a pattern is set here.',
    basis: 'utc',
    prefixKey: null,
    defaultSegments: () => null,
    uniqueness: 'database',
    exists: async (tx, value) => (await tx.shipment.findUnique({ where: { reference: value }, select: { id: true } })) !== null,
    listStartingWith: async (tx, prefix) => (await tx.shipment.findMany({ where: { reference: { startsWith: prefix } }, select: { reference: true } }))
      .map((r) => r.reference ?? ''),
  },
}
