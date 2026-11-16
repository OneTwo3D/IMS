/**
 * THE LIVE PORTS OF THE EU VAT SHADOW REPORT (npm run eu-vat:shadow --live-read). Read only, end to end:
 *
 *   IMS         `shoppingOrderLink.findMany`, the stored Xero tax-rate list, the importer's `buildShadowWcSalesInvoice` (which reads and never writes) and the pure Xero payload builder.
 *   WooCommerce ONE `GET /orders/{id}` per order through `wcReadOnlyGetOrder` (eu-vat-shadow-http.ts: stored credentials read without migrate-on-read; no write path).
 *   Xero        the invoice-number lookup and ONE `GET /Invoices/{id}` through `xeroReadOnlyGet`, with the stored token ONLY IF IT HAS NOT EXPIRED: it never refreshes (a refresh is a POST and a database write), logs or notifies.
 *
 * Nothing here calls `pushSalesInvoice`, a queue function, `stampEuVatRegime`, `treatImportedSalesInvoice`, `logActivity`, `xeroPost`, `xeroPut`, `wcPost`, `wcPut`, `xeroGet`, `wcFetch` or `getAccessToken` (the clients that can refresh a token or re-encrypt a setting). What a vendor says is reduced to a closed code before
 * it leaves this file (an HTTP status or a fixed word): a response body, a header or an error text is never returned, so no credential or token that a vendor echoed can reach the output.
 */
import { db } from '@/lib/db'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { buildShadowWcSalesInvoice } from '@/lib/connectors/woocommerce/sync/order-import'
import { resolveWcAccountingInvoiceNumber } from '@/lib/connectors/woocommerce/sync/invoice-number'
import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'
import { buildSalesInvoicePayload, isXeroSalesDocumentTaxTypeError } from '@/lib/connectors/xero/invoices'
import { isXeroForeignCurrencyRateError } from '@/lib/connectors/xero/fx'
import { EU_VAT_TREATMENT_PAYLOAD_KEY } from '@/lib/domain/accounting/eu-vat-treatment'
import { comparableFromBuiltPayload } from '@/lib/domain/accounting/eu-vat-shadow-compare'
import { readStoredXeroList, type Client } from '@/lib/tax/purchase-tax-import'
import { loadStoredXeroRateOf } from '@/lib/connectors/xero/tax-rate-lookup'
import type { InvoiceData } from '@/lib/connectors/types'
import { readShadowWcCredentials, readShadowXeroGrant, wcReadOnlyGetOrder, xeroReadOnlyGet } from '@/lib/tax/eu-vat-shadow-http'
import type { ShadowImsBuild, ShadowOrderRef, ShadowPorts, ShadowSelection, ShadowXeroFetch } from '@/lib/tax/eu-vat-shadow-run'

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The effective rate of every type in the stored Xero list, or null when the list cannot be relied on (the tax of such lines is then not compared). */
async function loadRateTable(now: Date): Promise<(taxType: string) => number | null> {
  const token = await db.accountingToken.findUnique({ where: { connector: 'xero' }, select: { tenantId: true } })
  const read = await readStoredXeroList(db as unknown as Client, now, token?.tenantId ?? null)
  if (!read.ok) return () => null
  const rates = new Map<string, number>()
  for (const row of read.list.rows) {
    const rate = row.effectiveRate === null || row.effectiveRate === undefined ? Number.NaN : Number(row.effectiveRate)
    if (Number.isFinite(rate)) rates.set(row.taxType, rate)
  }
  return (taxType) => rates.get(taxType) ?? null
}

/** The Rounding account the real poster would use for a unitdp=4 difference (setting `xero_rounding_difference_account`): a plain read of the one setting, so the builder here sees what the poster sees. */
async function loadRoundingAccount(): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key: 'xero_rounding_difference_account' }, select: { value: true } })
  const account = row?.value?.trim() ?? ''
  return account === '' ? null : account
}

export async function createLiveShadowPorts(now: Date = new Date()): Promise<ShadowPorts> {
  const [rateOf, baseCurrency, roundingAccount, builderRates] = await Promise.all([loadRateTable(now), getBaseCurrencyCode(), loadRoundingAccount(), loadStoredXeroRateOf(now)])

  return {
    async listOrders(selection: ShadowSelection, limit: number) {
      if (selection.kind === 'orders') {
        const links = await db.shoppingOrderLink.findMany({
          where: { connector: 'woocommerce', OR: [{ orderId: { in: selection.refs } }, { externalOrderNumber: { in: selection.refs } }, { order: { externalOrderNumber: { in: selection.refs } } }] },
          select: { orderId: true, externalOrderId: true, externalOrderNumber: true, order: { select: { externalOrderNumber: true } } },
          orderBy: { createdAt: 'asc' },
          take: limit,
        })
        const refs: ShadowOrderRef[] = links.map((l) => ({ orderId: l.orderId, externalOrderId: l.externalOrderId, orderNumber: l.externalOrderNumber ?? l.order.externalOrderNumber ?? l.orderId }))
        const found = new Set(links.flatMap((l) => [l.orderId, l.externalOrderNumber ?? '', l.order.externalOrderNumber ?? '']))
        return { refs, unresolved: selection.refs.filter((ref) => !found.has(ref)) }
      }
      const links = await db.shoppingOrderLink.findMany({
        where: { connector: 'woocommerce', order: { createdAt: { gte: new Date(`${selection.from}T00:00:00Z`), lt: new Date(new Date(`${selection.to}T00:00:00Z`).getTime() + 24 * 3_600_000) } } },
        select: { orderId: true, externalOrderId: true, externalOrderNumber: true, order: { select: { externalOrderNumber: true } } },
        orderBy: { createdAt: 'asc' },
        take: limit,
      })
      return { refs: links.map((l) => ({ orderId: l.orderId, externalOrderId: l.externalOrderId, orderNumber: l.externalOrderNumber ?? l.order.externalOrderNumber ?? l.orderId })), unresolved: [] }
    },

    async loadWcOrder(ref) {
      const creds = await readShadowWcCredentials()
      if (!creds.ok) return { ok: false, code: creds.code }
      const result = await wcReadOnlyGetOrder(creds, ref.externalOrderId)
      if (!result.ok) return { ok: false, code: result.code }
      if (result.data === null || typeof result.data !== 'object') return { ok: false, code: 'unreadable' }
      const order = result.data as WcFullOrder
      const destination = (order.shipping?.country || order.billing?.country || '').trim() || null
      const number = resolveWcAccountingInvoiceNumber(order)
      return { ok: true, wc: { destination, invoiceNumber: number.ok ? number.invoiceNumber : null, order } }
    },

    async buildIms(ref, wc): Promise<ShadowImsBuild> {
      const shadow = await buildShadowWcSalesInvoice(ref.orderId, wc.order as WcFullOrder)
      if (shadow.kind === 'refused') return { kind: 'refused', code: shadow.code, ...(shadow.unmappedRateIds ? { unmappedRateIds: shadow.unmappedRateIds } : {}) }
      const payload = shadow.payload
      const lines = Array.isArray(payload.lines) ? (payload.lines as Array<{ noTaxKind?: unknown }>) : []
      let built: Record<string, unknown>
      try {
        // THE REAL BUILDER, the one every Xero sales invoice goes through. A contact id and a draft status stand in for the two things only a real post has; nothing is sent.
        // The builder never reads the contact (it takes a ContactID), and this report never holds one: the placeholder is a constant, not a customer's name.
        const contactName = 'shadow'
        built = buildSalesInvoicePayload({ ...(payload as unknown as InvoiceData), invoiceNumber: wc.invoiceNumber ?? 'SHADOW', contactName }, 'DRAFT', 'shadow-contact', new Set<string>(), baseCurrency, roundingAccount, builderRates.ok ? builderRates.rateOf : undefined)
      } catch (error) {
        // The builder's message can quote a line description: only its kind is reported.
        if (isXeroSalesDocumentTaxTypeError(error)) return { kind: 'refused', code: 'tax_type_missing' }
        if (isXeroForeignCurrencyRateError(error)) return { kind: 'refused', code: 'currency_rate_missing' }
        return { kind: 'refused', code: 'builder_failed' }
      }
      const comparable = comparableFromBuiltPayload(built, lines, rateOf, baseCurrency)
      if (!comparable.ok) return { kind: 'refused', code: 'not_comparable_built' }
      const marker = payload[EU_VAT_TREATMENT_PAYLOAD_KEY] as { route?: unknown; regime?: unknown } | undefined
      return {
        kind: 'built',
        invoice: comparable.invoice,
        warnings: shadow.warnings.map((w) => ({ code: w.code })),
        stampSource: shadow.stampSource,
        route: typeof marker?.route === 'string' ? marker.route : 'none',
        regime: typeof marker?.regime === 'string' ? marker.regime : null,
      }
    },

    async fetchXeroInvoice(invoiceNumber): Promise<ShadowXeroFetch> {
      // FAIL CLOSED: an expired, missing or blocked token is never refreshed here.
      const grant = await readShadowXeroGrant(new Date())
      if (!grant.ok) return { kind: 'error', code: grant.code }
      if (!/^[A-Za-z0-9._/# -]{1,64}$/.test(invoiceNumber)) return { kind: 'error', code: 'number_not_askable' }
      const listed = await xeroReadOnlyGet(grant, `Invoices?InvoiceNumbers=${encodeURIComponent(invoiceNumber)}&summaryOnly=true`)
      if (!listed.ok) return { kind: 'error', code: listed.code }
      const rows = (listed.data as { Invoices?: Array<{ InvoiceID?: unknown; Type?: unknown }> } | null)?.Invoices
      if (!Array.isArray(rows)) return { kind: 'error', code: 'unreadable' }
      const sales = rows.filter((row) => row.Type === 'ACCREC')
      if (sales.length === 0) return { kind: 'none' }
      if (sales.length > 1) return { kind: 'ambiguous', count: sales.length }
      const id = sales[0]!.InvoiceID
      if (typeof id !== 'string' || !GUID.test(id)) return { kind: 'error', code: 'bad_document_id' }
      const fetched = await xeroReadOnlyGet(grant, `Invoices/${id}`)
      if (!fetched.ok) return { kind: 'error', code: fetched.code }
      const invoice = (fetched.data as { Invoices?: unknown[] } | null)?.Invoices?.[0]
      return invoice === undefined ? { kind: 'none' } : { kind: 'found', invoice }
    },
  }
}
