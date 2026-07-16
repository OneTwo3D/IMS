/**
 * Push purchase invoices as bills (ACCPAY) to Xero.
 */

import { xeroPost, xeroPut } from './api'
import { findOrCreateContact } from './contacts'
import { imsRateToXeroCurrencyRate } from './fx'
import type { BillData, InvoiceLine } from '../types'

type XeroInvoiceResponse = {
  Invoices: Array<{
    InvoiceID: string
    InvoiceNumber: string
    Status: string
  }>
}

function buildPurchaseBillPayload(
  data: BillData,
  status: string,
  contactId: string,
): Record<string, unknown> {
  // Xero mandates TaxType on every line; "NONE" is the no-tax fallback.
  const DEFAULT_TAX_TYPE = 'NONE'

  // Build line items. Xero ACCPAY (bills) does NOT support DiscountRate at
  // the line level — so we apply any generic per-line `discountAmount` by
  // reducing `UnitAmount`. Keeping the Xero-specific handling inside the
  // connector means callers can pass the same generic `discountAmount` field
  // regardless of whether the target system is Xero or (future) QuickBooks.
  const lineItems = data.lines.map((line: InvoiceLine) => {
    let effectiveUnitAmount = line.unitAmount
    if (line.discountAmount && line.discountAmount > 0 && line.quantity > 0) {
      const perUnitDiscount = line.discountAmount / line.quantity
      effectiveUnitAmount = Math.round((line.unitAmount - perUnitDiscount) * 10000) / 10000
      if (effectiveUnitAmount < 0) effectiveUnitAmount = 0
    }
    const xeroLine: Record<string, unknown> = {
      Description: line.description,
      Quantity: line.quantity,
      UnitAmount: effectiveUnitAmount,
      AccountCode: line.accountCode,
      TaxType: line.taxType || DEFAULT_TAX_TYPE,
    }
    if (line.itemCode) xeroLine.ItemCode = line.itemCode
    return xeroLine
  })

  // DueDate is mandatory for AUTHORISED bills — fall back to the bill date.
  const dueDate = data.dueDate || data.date

  const invoice: Record<string, unknown> = {
    Type: 'ACCPAY',
    Contact: { ContactID: contactId },
    LineItems: lineItems,
    Status: status,
    CurrencyCode: data.currency,
    Date: data.date,
    DueDate: dueDate,
  }
  // Stamp the IMS rate so Xero doesn't apply its own daily XE rate.
  const xeroCurrencyRate = imsRateToXeroCurrencyRate(data.currencyRateToBase)
  if (xeroCurrencyRate != null) invoice.CurrencyRate = xeroCurrencyRate
  if (data.invoiceNumber) invoice.InvoiceNumber = data.invoiceNumber
  if (data.reference) invoice.Reference = data.reference

  return invoice
}

async function preparePurchaseBillPayload(
  data: BillData,
  status: string,
  opts?: { supplierId?: string; supplierEmail?: string },
): Promise<{ success: true; invoice: Record<string, unknown> } | { success: false; error: string }> {
  // Find or create the supplier contact
  const contactResult = await findOrCreateContact(data.contactName, opts?.supplierEmail, true, { supplierId: opts?.supplierId })
  if (!contactResult.success || !contactResult.contactId) {
    return { success: false, error: `Contact error: ${contactResult.error}` }
  }

  // Validate account codes up front — Xero rejects the whole bill otherwise.
  for (const line of data.lines) {
    if (!line.accountCode) {
      return {
        success: false,
        error: `Line "${line.description}" is missing an account code. Configure Account Mapping → Stock in Transit in the Xero integration settings.`,
      }
    }
  }

  return {
    success: true,
    invoice: buildPurchaseBillPayload(data, status, contactResult.contactId),
  }
}

/**
 * Create a purchase bill (ACCPAY) in Xero.
 *
 * PUT, NOT POST — this is where the safety actually lives (o3d-6l3).
 *
 * Xero's `POST /Invoices` is UPDATE-OR-CREATE: given an InvoiceNumber it already holds for this
 * contact it silently REPLACES that invoice and returns its InvoiceID. `PUT /Invoices` is
 * create-only. Creating via POST therefore made every ACCPAY a potential overwrite of an
 * existing one, keyed on a value Xero does not require to be unique — ACCPAY InvoiceNumber is
 * explicitly non-unique, because suppliers number their own documents.
 *
 * Not theoretical: while InvoiceNumber carried our PO reference (identical for every bill against
 * a PO), the second instalment overwrote the first in the live ledger. Two GBP 25 bills became
 * one, payables understated, no error anywhere.
 *
 * Sending the SUPPLIER's number instead makes that collision rare — suppliers rarely reuse a
 * number — but NOT impossible: one who legitimately reuses "123", or a buyer who types the same
 * number twice, resurrects the identical silent overwrite. So the field mapping fixes the
 * SEMANTICS and PUT fixes the FAILURE MODE. With create-only, a duplicate number is refused
 * loudly instead of destroying a payable quietly, which is the right way round: a rejected bill
 * is a five-minute conversation, an overwritten one is a discrepancy nobody finds until the
 * supplier chases payment.
 */
export async function pushPurchaseBill(
  data: BillData,
  status: string = 'AUTHORISED',
  opts?: { idempotencyKey?: string; supplierId?: string; supplierEmail?: string },
): Promise<{ success: boolean; invoiceId?: string; error?: string }> {
  const prepared = await preparePurchaseBillPayload(data, status, opts)
  if (!prepared.success) return prepared

  const res = await xeroPut<XeroInvoiceResponse>('Invoices', prepared.invoice, opts)
  if (!res.ok || !res.data?.Invoices?.length) {
    return { success: false, error: res.error ?? 'Failed to create bill' }
  }

  return { success: true, invoiceId: res.data.Invoices[0].InvoiceID }
}

export async function updatePurchaseBill(
  accountingInvoiceId: string,
  data: BillData,
  status: string = 'AUTHORISED',
  opts?: { idempotencyKey?: string; supplierId?: string; supplierEmail?: string },
): Promise<{ success: boolean; invoiceId?: string; error?: string }> {
  const prepared = await preparePurchaseBillPayload(data, status, opts)
  if (!prepared.success) return prepared

  const res = await xeroPost<XeroInvoiceResponse>(`Invoices/${accountingInvoiceId}`, prepared.invoice, opts)
  if (!res.ok || !res.data?.Invoices?.length) {
    return { success: false, error: res.error ?? 'Failed to update bill' }
  }

  return { success: true, invoiceId: res.data.Invoices[0].InvoiceID }
}
