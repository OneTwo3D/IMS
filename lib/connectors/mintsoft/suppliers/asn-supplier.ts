import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { recordRefusedAction, resolveRefusedActions } from '@/lib/domain/refused-actions'
import { readMintsoftAsnSupplierRequired, readMintsoftTransferSupplierId } from './settings'

/**
 * WHICH MINTSOFT SUPPLIER AN ASN CARRIES, AND WHEN IT IS REFUSED FOR LACKING ONE.
 *
 *   mapped                                   -> send its Mintsoft id on the ASN (whatever the required setting says).
 *   not mapped, `mintsoft_asn_supplier_required` OFF -> create the ASN as before, no supplier field (nothing changes until the mapping work is done).
 *   not mapped, required ON                   -> REFUSE, raise an operator task (a refused action naming the supplier), create nothing. Never a
 *                                                supplier-less ASN once the setting is on.
 *
 * A PO carries its own supplier. A transfer carries the IMS supplier named by `mintsoft_transfer_supplier_id` (owner decision 2026-11-19: "One
 * Two Enterprises Ltd"), mapped on the same screen; with none chosen, a required transfer ASN is refused like an unmapped PO.
 */

export const ASN_SUPPLIER_ACTION = 'WMS_ASN_SUPPLIER' as const
export const ASN_SUPPLIER_GATE = 'WMS_SUPPLIER_UNMAPPED'

export type AsnSupplierSubject =
  | { kind: 'PurchaseOrder'; id: string }
  | { kind: 'Transfer'; id: string }

export type AsnSupplierResolution =
  | { kind: 'send'; externalSupplierId: string; supplierName: string }
  | { kind: 'none' }
  | { kind: 'refuse'; error: string }

type Client = Pick<Prisma.TransactionClient, 'purchaseOrder' | 'stockTransfer' | 'supplier' | 'mintsoftSupplierLink' | 'mintsoftSupplier' | 'setting' | 'refusedAction' | '$queryRaw'>

const ENTITY_TYPE = { PurchaseOrder: 'PURCHASE_ORDER', Transfer: 'STOCK_TRANSFER' } as const

export function unmappedSupplierText(supplierName: string | null, why: 'unmapped' | 'missing-in-mintsoft' | 'no-transfer-supplier'): string {
  if (why === 'no-transfer-supplier') {
    return 'No supplier is chosen for transfer ASNs. Choose it in Settings > Mintsoft suppliers, map it to its Mintsoft supplier, then retry. Nothing was sent.'
  }
  if (why === 'missing-in-mintsoft') {
    return `The Mintsoft supplier mapped to "${supplierName}" is no longer in Mintsoft. Re-map supplier "${supplierName}" in Settings > Mintsoft suppliers, then retry. Nothing was sent.`
  }
  return `Map supplier "${supplierName}" in Settings > Mintsoft suppliers, then retry. An ASN is not created without a Mintsoft supplier. Nothing was sent.`
}

export async function resolveAsnSupplier(subject: AsnSupplierSubject, client: Client = db as unknown as Client): Promise<AsnSupplierResolution> {
  const required = await readMintsoftAsnSupplierRequired(client)

  let reference: string | null = null
  let imsSupplierId: string | null = null
  if (subject.kind === 'PurchaseOrder') {
    const po = await client.purchaseOrder.findUnique({ where: { id: subject.id }, select: { reference: true, supplierId: true } })
    reference = po?.reference ?? null
    imsSupplierId = po?.supplierId ?? null
  } else {
    const transfer = await client.stockTransfer.findUnique({ where: { id: subject.id }, select: { reference: true } })
    reference = transfer?.reference ?? null
    imsSupplierId = await readMintsoftTransferSupplierId(client)
  }

  const refuse = async (supplierName: string | null, why: Parameters<typeof unmappedSupplierText>[1]): Promise<AsnSupplierResolution> => {
    const error = unmappedSupplierText(supplierName, why)
    await recordRefusedAction(client, {
      entityType: ENTITY_TYPE[subject.kind],
      entityId: subject.id,
      action: ASN_SUPPLIER_ACTION,
      gate: ASN_SUPPLIER_GATE,
      permanence: 'PERMANENT',
      severity: 'MEDIUM',
      intent: { orderNumber: reference, imsSupplierId, supplier: supplierName },
      detail: error,
    })
    return { kind: 'refuse', error }
  }

  if (!imsSupplierId) return required ? refuse(null, subject.kind === 'Transfer' ? 'no-transfer-supplier' : 'unmapped') : { kind: 'none' }

  const supplier = await client.supplier.findUnique({ where: { id: imsSupplierId }, select: { name: true } })
  const name = supplier?.name ?? null
  const link = await client.mintsoftSupplierLink.findUnique({ where: { supplierId: imsSupplierId }, select: { state: true, externalSupplierId: true } })
  if (!link || link.state !== 'MAPPED' || !link.externalSupplierId) return required ? refuse(name, 'unmapped') : { kind: 'none' }

  const cached = await client.mintsoftSupplier.findUnique({ where: { externalId: link.externalSupplierId }, select: { missingSince: true } })
  if (cached?.missingSince) return required ? refuse(name, 'missing-in-mintsoft') : { kind: 'none' }

  await resolveRefusedActions(client, { entityType: ENTITY_TYPE[subject.kind], entityId: subject.id, action: ASN_SUPPLIER_ACTION }, 'ACTION_SUCCEEDED')
  return { kind: 'send', externalSupplierId: link.externalSupplierId, supplierName: name ?? '' }
}
