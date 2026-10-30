import type { TaxRateRow } from '../../lib/reconciliation-pack/ims-readers.ts'
import type { WooTaxRateDetail } from '../../lib/reconciliation-pack/woo-source.ts'
import type { WooTaxMappingRow, WooTaxRateFields } from '../../lib/connectors/woocommerce/tax-rate-plan.ts'
import type { WooTaxPortResult, WooTaxRateWritePort } from '../../lib/connectors/woocommerce/tax-rate-writer.ts'

/** Fixtures for the WooCommerce tax-rate writer tests. No network, no database. */

export const woo = (id: string, over: Partial<WooTaxRateDetail> = {}): WooTaxRateDetail => ({ id, name: 'GB VAT', rate: '20.0000', country: 'GB', state: '', postcode: '', city: '', class: 'standard', shipping: true, compound: false, ...over })
export const ims = (id: string, over: Partial<TaxRateRow> = {}): TaxRateRow => ({ id, name: 'GB VAT', rate: '0.2000', usedFor: 'SALES', reverseCharge: false, active: true, accountingTaxType: null, countryCode: 'GB', reportingCategory: 'DOMESTIC', isCompound: false, taxCategory: 'STANDARD', ...over })
/** The store the fixtures stand in (the normalised URL ownership is bound to). */
export const STORE = 'https://store.example'
export const OTHER_STORE = 'https://other-store.example'

/** A mapping row that describes `w` exactly as the store states it. */
export const mapOf = (w: WooTaxRateDetail, taxRateId: string, over: Partial<WooTaxMappingRow> = {}): WooTaxMappingRow => ({
  externalTaxRateId: w.id, taxRateId, externalName: w.name, externalCountry: w.country === '' ? null : w.country, externalRatePct: w.rate, externalClass: w.class, storeIdentity: STORE, ...over,
})

/** A consistent set: UK 20, German 19, Canary Islands 0 (Spain, region CN), Madeira 22 (Portugal, PT-30). */
export function consistent(): { woo: WooTaxRateDetail[]; rates: TaxRateRow[]; mappings: WooTaxMappingRow[] } {
  const w = [
    woo('1', { name: 'GB VAT' }),
    woo('2', { name: 'DE VAT', country: 'DE', rate: '19.0000' }),
    woo('3', { name: 'ES-CN VAT', country: 'ES', state: 'CN', rate: '0.0000', class: 'zero-rate', shipping: false }),
    woo('4', { name: 'PT-30 VAT', country: 'PT', state: '30', rate: '22.0000' }),
  ]
  const rates = [
    ims('rGB'),
    ims('rDE', { name: 'DE VAT', rate: '0.1900', countryCode: 'DE', reportingCategory: 'OSS' }),
    ims('rCAN', { name: 'ES-CN VAT', rate: '0.0000', countryCode: 'ES', reportingCategory: 'OSS', taxCategory: 'ZERO' }),
    ims('rPT30', { name: 'PT-30 VAT', rate: '0.2200', countryCode: 'PT', reportingCategory: 'OSS' }),
  ]
  return { woo: w, rates, mappings: [mapOf(w[0]!, 'rGB'), mapOf(w[1]!, 'rDE'), mapOf(w[2]!, 'rCAN'), mapOf(w[3]!, 'rPT30')] }
}

export type FakeCall = { op: 'create' | 'update' | 'remove'; id: string | null; body: unknown }

/** An in-memory WooCommerce tax-rate store that is also the write port: every send is counted, and the store changes as the real one would. */
export class FakeWooStore implements WooTaxRateWritePort {
  rates = new Map<string, WooTaxRateDetail>()
  calls: FakeCall[] = []
  private next: number
  /** Answer a refusal for the n-th call (1-based), or null to accept. */
  refuse: ((n: number, call: FakeCall) => string | null) | null = null

  constructor(initial: readonly WooTaxRateDetail[] = [], nextId = 1000) {
    for (const rate of initial) this.rates.set(rate.id, { ...rate })
    this.next = nextId
  }

  /** Every single-rate re-read (the check made before each send), in order. */
  rateReads: string[] = []
  /** Test seam: runs when a single rate is read, before it answers (to change the store between the plan and the send). */
  onRateRead: ((id: string) => void | Promise<void>) | null = null
  readWooRate = async (id: string): Promise<{ ok: true; rate: WooTaxRateDetail } | { ok: false }> => {
    this.rateReads.push(id)
    await this.onRateRead?.(id)
    const rate = this.rates.get(id)
    return rate === undefined ? { ok: false } : { ok: true, rate: { ...rate } }
  }

  list(): WooTaxRateDetail[] { return [...this.rates.values()].sort((a, b) => Number(BigInt(a.id) - BigInt(b.id))) }
  readWoo = async (): Promise<{ ok: true; rates: WooTaxRateDetail[] }> => ({ ok: true, rates: this.list().map((rate) => ({ ...rate })) })

  private gate(call: FakeCall): string | null {
    this.calls.push(call)
    return this.refuse === null ? null : this.refuse(this.calls.length, call)
  }

  async create(fields: WooTaxRateFields): Promise<WooTaxPortResult> {
    const error = this.gate({ op: 'create', id: null, body: fields })
    if (error !== null) return { ok: false, error }
    const id = String(this.next++)
    this.rates.set(id, { id, name: fields.name, rate: fields.rate, country: fields.country, state: fields.state, postcode: '', city: '', class: fields.class, shipping: fields.shipping, compound: fields.compound })
    return { ok: true, id }
  }

  async update(wooId: string, changed: Readonly<Partial<WooTaxRateFields>>): Promise<WooTaxPortResult> {
    const error = this.gate({ op: 'update', id: wooId, body: changed })
    if (error !== null) return { ok: false, error }
    const current = this.rates.get(wooId)
    if (current === undefined) return { ok: false, error: 'no such rate' }
    this.rates.set(wooId, { ...current, ...changed })
    return { ok: true, id: wooId }
  }

  async remove(wooId: string): Promise<WooTaxPortResult> {
    const error = this.gate({ op: 'remove', id: wooId, body: null })
    if (error !== null) return { ok: false, error }
    if (!this.rates.delete(wooId)) return { ok: false, error: 'no such rate' }
    return { ok: true, id: wooId }
  }
}
