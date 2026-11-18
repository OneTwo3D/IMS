/**
 * ALIGN-UP NEEDS EVIDENCE THAT THE WAREHOUSE RECEIVED AGAINST THE ASN (o3d-hqvrp.121).
 *
 * Align-up lands a rise in Mintsoft stock (Mintsoft above IMS) as a receipt against open ASN capacity. Nothing tells a booked-in increase
 * from any other increase, so a customer return restocked in Mintsoft, a stock-take find or a mis-booking was booked in IMS as PO goods
 * (cost layer at PO cost, goods-in-transit journal drained early), and the real delivery was later "covered by snapshot". A return
 * restocked from the returns inbox then added the unit a second time.
 *
 * THE EVIDENCE USED. An ASN the warehouse has not touched (status OPEN, no callback ever recorded) cannot be what raised stock: Mintsoft
 * books goods in against an ASN through its booked-in status or its callback, and IMS records both. So with the switch ON, align-up may
 * only use an ASN whose status is PARTIALLY_BOOKED_IN or BOOKED_IN, or that has had a callback. A rise with no such ASN is left as a
 * stock discrepancy for the operator to explain (return, stock-take, mis-booking) instead of being invented into a receipt.
 *
 * BEHIND A SWITCH, default OFF: it narrows what align-up books on a LIVE warehouse, and an ASN whose status IMS has not yet refreshed
 * would wait for the booked-in recheck. `mintsoft_align_up_requires_receipt_evidence` reads ON only for the exact string 'true'.
 */
export const MINTSOFT_ALIGN_UP_RECEIPT_EVIDENCE_SETTING = 'mintsoft_align_up_requires_receipt_evidence'

export function alignUpReceiptEvidenceEnabledValue(value: string | null | undefined): boolean {
  return value === 'true'
}

export function asnHasReceiptEvidence(asn: { status: string; lastCallbackAt: Date | null }): boolean {
  return asn.status === 'PARTIALLY_BOOKED_IN' || asn.status === 'BOOKED_IN' || asn.lastCallbackAt !== null
}

type SettingReader = {
  setting: { findUnique: (args: { where: { key: string } }) => Promise<{ value: string } | null> }
}

/** A read failure propagates: an unreadable switch is neither consent nor a silent "off" for a write to live stock. */
export async function readAlignUpReceiptEvidenceEnabled(reader: SettingReader): Promise<boolean> {
  const row = await reader.setting.findUnique({ where: { key: MINTSOFT_ALIGN_UP_RECEIPT_EVIDENCE_SETTING } })
  return alignUpReceiptEvidenceEnabledValue(row?.value)
}
