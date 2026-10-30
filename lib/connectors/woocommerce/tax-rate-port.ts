/**
 * THE WRITE PORT OF THE TAX-RATE WRITER OVER THE WOOCOMMERCE REST API (lib/connectors/woocommerce/tax-rate-writer.ts). It adds no transport of its own: every call goes through wcPost or wcPut,
 * whose last barrier (wooEgressHold) refuses to send while the producer hold stands. The writer asks the producer seam before it calls any of these.
 *
 *   create   POST /taxes
 *   update   PUT  /taxes/{id}        (only the changed fields)
 *   remove   POST /taxes/batch       { delete: [id] }  (the REST API has no DELETE primitive here; a tax rate has no trash, so the batch delete is a hard delete)
 *
 * The store's answer is validated, never trusted: a created rate must come back with a whole-number id, a batch delete must name the id it deleted and carry no error.
 */

import { wcPost, wcPut } from './api'
import type { WooTaxPortResult, WooTaxRateWritePort } from './tax-rate-writer'
import type { WooTaxRateFields } from './tax-rate-plan'

const ID_RE = /^[1-9][0-9]{0,17}$/

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const failure = (answer: { error?: string; held?: true }): WooTaxPortResult =>
  answer.held === true ? { ok: false, error: answer.error ?? 'held', held: true } : { ok: false, error: answer.error ?? 'WooCommerce did not answer' }

export function createWooTaxRateWritePort(): WooTaxRateWritePort {
  return {
    async create(fields: WooTaxRateFields): Promise<WooTaxPortResult> {
      const answer = await wcPost('/taxes', fields)
      if (answer.error !== undefined) return failure(answer)
      const id = record(answer.data)?.id
      const text = typeof id === 'number' || typeof id === 'string' ? String(id) : ''
      return ID_RE.test(text) ? { ok: true, id: text } : { ok: false, error: 'WooCommerce answered a created tax rate without a usable id' }
    },
    async update(wooId: string, changed: Readonly<Partial<WooTaxRateFields>>): Promise<WooTaxPortResult> {
      if (!ID_RE.test(wooId)) return { ok: false, error: 'not a WooCommerce tax rate id' }
      const answer = await wcPut(`/taxes/${wooId}`, changed)
      if (answer.error !== undefined) return failure(answer)
      return record(answer.data) === null ? { ok: false, error: 'WooCommerce answered an update without a rate' } : { ok: true, id: wooId }
    },
    async remove(wooId: string): Promise<WooTaxPortResult> {
      if (!ID_RE.test(wooId)) return { ok: false, error: 'not a WooCommerce tax rate id' }
      const answer = await wcPost('/taxes/batch', { delete: [Number(wooId)] })
      if (answer.error !== undefined) return failure(answer)
      const deleted = record(answer.data)?.delete
      const first = Array.isArray(deleted) && deleted.length === 1 ? record(deleted[0]) : null
      if (first === null || String(first.id) !== wooId || first.error !== undefined) return { ok: false, error: 'WooCommerce did not confirm the deletion of the tax rate' }
      return { ok: true, id: wooId }
    },
  }
}
