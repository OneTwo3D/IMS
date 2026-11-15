/**
 * THE LIVE PORTS OF THE EU VAT SHADOW REPORT (npm run eu-vat:shadow --live-read). Read only, end to end:
 *
 *   IMS         `shoppingOrderLink.findMany`, the stored Xero tax-rate list, the importer's `buildShadowWcSalesInvoice` (which reads and never writes) and the pure Xero payload builder.
 *   WooCommerce ONE `GET /orders/{id}` per order through `wcFetch` (which has no write verb).
 *   Xero        the invoice-number lookup (`lookupInvoiceDocumentClaims`, a GET) and ONE `GET /Invoices/{id}` through `xeroGet`.
 *
 * Nothing here calls `pushSalesInvoice`, a queue function, `stampEuVatRegime`, `treatImportedSalesInvoice`, `logActivity`, `xeroPost`, `xeroPut`, `wcPost` or `wcPut`. What a vendor says is reduced to a closed code before
 * it leaves this file (an HTTP status or a fixed word): a response body, a header or an error text is never returned, so no credential or token that a vendor echoed can reach the output.
 */
import { db } from '@/lib/db'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { wcFetch } from '@/lib/connectors/woocommerce/api'
import { buildShadowWcSalesInvoice } from '@/lib/connectors/woocommerce/sync/order-import'
import { resolveWcAccountingInvoiceNumber } from '@/lib/connectors/woocommerce/sync/invoice-number'
import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'
import { xeroGet } from '@/lib/connectors/xero/api'
import { lookupInvoiceDocumentClaims } from '@/lib/connectors/xero/invoice-document-source'
import { buildSalesInvoicePayload, isXeroSalesDocumentTaxTypeError } from '@/lib/connectors/xero/invoices'
import { isXeroForeignCurrencyRateError } from '@/lib/connectors/xero/fx'
import { EU_VAT_TREATMENT_PAYLOAD_KEY } from '@/lib/domain/accounting/eu-vat-treatment'
import { comparableFromBuiltPayload } from '@/lib/domain/accounting/eu-vat-shadow-compare'
import { readStoredXeroList, type Client } from '@/lib/tax/purchase-tax-import'
import type { InvoiceData } from '@/lib/connectors/types'
import type { ShadowImsBuild, ShadowOrderRef, ShadowPorts, ShadowSelection, ShadowXeroFetch } from '@/lib/tax/eu-vat-shadow-run'

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** An HTTP status out of the connectors' error strings (`WC API error: 404 ...`, `Xero ... 404`), or a fixed word. Never the text. */
export function closedCodeOf(error: string | undefined, fallback: string): string {
  const status = /\b([1-5]\d{2})\b/.exec(error ?? '')
  return status ? `http_${status[1]}` : fallback
}

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

export async function createLiveShadowPorts(now: Date = new Date()): Promise<ShadowPorts> {
  const [rateOf, baseCurrency] = await Promise.all([loadRateTable(now), getBaseCurrencyCode()])

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
      if (!/^\d{1,12}$/.test(ref.externalOrderId)) return { ok: false, code: 'bad_external_id' }
      const result = await wcFetch(`/orders/${ref.externalOrderId}`)
      if (result.error || result.data === null || typeof result.data !== 'object') return { ok: false, code: closedCodeOf(result.error, 'unreadable') }
      const order = result.data as WcFullOrder
      const destination = (order.shipping?.country || order.billing?.country || '').trim() || null
      const number = resolveWcAccountingInvoiceNumber(order)
      return { ok: true, wc: { destination, invoiceNumber: number.ok ? number.invoiceNumber : null, order } }
    },

    async buildIms(ref, wc): Promise<ShadowImsBuild> {
      const shadow = await buildShadowWcSalesInvoice(ref.orderId, wc.order as WcFullOrder)
      if (shadow.kind === 'refused') return { kind: 'refused', reason: shadow.reason }
      const payload = shadow.payload
      const lines = Array.isArray(payload.lines) ? (payload.lines as Array<{ noTaxKind?: unknown }>) : []
      let built: Record<string, unknown>
      try {
        // THE REAL BUILDER, the one every Xero sales invoice goes through. A contact id and a draft status stand in for the two things only a real post has; nothing is sent.
        built = buildSalesInvoicePayload({ ...(payload as unknown as InvoiceData), invoiceNumber: wc.invoiceNumber ?? 'SHADOW', contactName: 'shadow' }, 'DRAFT', 'shadow-contact', new Set<string>(), baseCurrency)
      } catch (error) {
        if (isXeroForeignCurrencyRateError(error) || isXeroSalesDocumentTaxTypeError(error)) return { kind: 'refused', reason: error.message }
        return { kind: 'refused', reason: 'the invoice builder failed on this order' }
      }
      const comparable = comparableFromBuiltPayload(built, lines, rateOf)
      if (!comparable.ok) return { kind: 'refused', reason: comparable.reason }
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
      const claims = await lookupInvoiceDocumentClaims(invoiceNumber)
      if (!claims.ok) return { kind: 'error', code: claims.stop ? 'ledger_unavailable' : claims.unaskable ? 'number_not_askable' : 'lookup_failed' }
      if (claims.claims.length === 0) return { kind: 'none' }
      if (claims.claims.length > 1) return { kind: 'ambiguous', count: claims.claims.length }
      const id = claims.claims[0]!.documentId
      if (!GUID.test(id)) return { kind: 'error', code: 'bad_document_id' }
      const response = await xeroGet<{ Invoices?: unknown[] }>(`/Invoices/${id}`)
      if (!response.ok) return { kind: 'error', code: closedCodeOf(response.error, `http_${response.status}`) }
      const invoice = response.data?.Invoices?.[0]
      return invoice === undefined ? { kind: 'none' } : { kind: 'found', invoice }
    },
  }
}
