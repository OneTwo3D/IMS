/**
 * Delete a sales invoice (ACCREC) or supplier bill (ACCPAY) that IMS pushed to Xero, in the order Xero requires and that frees the
 * document's number for a replacement (o3d-ngmt.21).
 *
 * WHY TWO WRITES. Xero keeps the number of a VOIDED or DELETED document reserved: a replacement posted under the same number is refused
 * (or, on `POST /Invoices`, lands on the dead document, which cannot be modified). The reference the operator wants back is therefore
 * freed FIRST, by changing the live document's number to `<number>-DEL-<random>`, and only then is the document removed: DELETED for a
 * DRAFT or SUBMITTED one, VOIDED for an AUTHORISED one that carries no payment, credit note or allocation (Xero refuses a void
 * otherwise). That is the suffix trick the bead names; it is copied as it stands.
 *
 * RESUMABLE, WITH NO SECOND SUFFIX. The suffixed number is chosen once, when the delete is queued, and travels in the payload. This module
 * reads the document first and decides from what the ledger holds: a document already carrying the released number has had the first
 * write, so only the status write is made. A retry after a failed void therefore cannot append another suffix. A document already
 * VOIDED or DELETED is the finished state and is reported as success without writing anything.
 *
 * THE LEDGER IS ASKED, NOT TRUSTED. The plan refuses when the document the id names is not the kind of document IMS thinks it is, does not
 * carry the number IMS recorded (it is someone else's, or was renumbered by hand), or has money or credit attached. Each refusal is in
 * the operator's words and names the remedy: remove the blocking items in the accounting system first.
 *
 * Reads and writes go through the ordinary Xero transport (`xeroGet` / `xeroPost`), which is where the outbound-write hold is applied; this
 * module adds no second path to the wire.
 */

import { randomInt } from 'node:crypto'
import { xeroGet, xeroPost, type XeroResponse } from './api'
import { xeroDocumentRevisionAt } from './document-revision'
import { readSingleXeroDocument } from './single-document'

export type XeroDeletableDocumentType = 'ACCREC' | 'ACCPAY'

/** The part of a Xero invoice this module reads. */
export type XeroDocumentForDelete = {
  InvoiceID: string
  Type?: string
  Status?: string
  InvoiceNumber?: string | null
  Reference?: string | null
  AmountPaid?: number
  Payments?: unknown[]
  CreditNotes?: unknown[]
  Prepayments?: unknown[]
  Overpayments?: unknown[]
  UpdatedDateUTC?: string
}

type XeroInvoicesResponse = { Invoices?: XeroDocumentForDelete[] }

/** The characters of the random suffix: upper-case letters and digits, so it survives Xero's case-insensitive number matching and is easy to read out. */
const SUFFIX_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const SUFFIX_LENGTH = 6

/** A fresh random suffix token. Called once, when the delete is queued. */
export function newDeleteSuffixToken(random: (max: number) => number = (max) => randomInt(max)): string {
  let token = ''
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) token += SUFFIX_ALPHABET[random(SUFFIX_ALPHABET.length)]
  return token
}

/** `<original>-DEL-<token>`. Pure; the token is decided by the caller so a retry reuses it. */
export function releasedDocumentNumber(original: string, token: string): string {
  return `${original}-DEL-${token}`
}

export type XeroDeleteTarget = {
  /** The document id IMS recorded from the create's own response. */
  invoiceId: string
  expectedType: XeroDeletableDocumentType
  /** The number IMS holds for the document; '' when the document carries none (a bill may have none). */
  originalNumber: string
  /** The number it is changed to; '' exactly when `originalNumber` is. */
  releasedNumber: string
  /** The Reference IMS sent, '' when none; the released Reference carries the same suffix. */
  originalReference: string
  releasedReference: string
}

export type XeroDeletePlan =
  | { kind: 'refuse'; reason: string }
  | { kind: 'already-done'; status: string }
  | { kind: 'steps'; renumber: boolean; targetStatus: 'DELETED' | 'VOIDED' }

const BLOCKERS_FIRST = 'Remove the blocking items in Xero first (delete or unapply the payments, credit notes and allocations on it), then delete it again.'

function sameText(a: string | null | undefined, b: string): boolean {
  return (a ?? '').trim().toLowerCase() === b.trim().toLowerCase()
}

function nonEmpty(list: unknown): boolean {
  return Array.isArray(list) && list.length > 0
}

/**
 * What to do with the document the ledger holds. Pure.
 *
 * The number check accepts either the original or the released number: the first is the state before any write, the second is the state a
 * previous attempt left behind. Anything else means the document is not the one IMS recorded.
 */
export function planXeroDocumentDelete(doc: XeroDocumentForDelete, target: XeroDeleteTarget): XeroDeletePlan {
  const label = target.originalNumber || target.invoiceId
  const status = String(doc.Status ?? '').toUpperCase()
  if (status === 'VOIDED' || status === 'DELETED') return { kind: 'already-done', status }
  if (doc.Type !== undefined && doc.Type !== target.expectedType) {
    return {
      kind: 'refuse',
      reason: `Xero holds ${label} as a ${doc.Type} document, not the ${target.expectedType === 'ACCREC' ? 'sales invoice' : 'supplier bill'} IMS recorded. Nothing was changed. Check the document in Xero before deleting anything.`,
    }
  }
  const numberMatches = target.originalNumber === ''
    ? true
    : sameText(doc.InvoiceNumber, target.originalNumber) || sameText(doc.InvoiceNumber, target.releasedNumber)
  if (!numberMatches) {
    return {
      kind: 'refuse',
      reason: `Xero holds document ${target.invoiceId} under the number "${doc.InvoiceNumber ?? ''}", not ${label}, so it is not safe to treat it as the document IMS raised. Nothing was changed. Check the number in Xero, or relink the document, before deleting it.`,
    }
  }
  if (status === 'PAID' || (typeof doc.AmountPaid === 'number' && doc.AmountPaid > 0) || nonEmpty(doc.Payments)) {
    return { kind: 'refuse', reason: `${label} has a payment applied in Xero, which Xero will not void or delete. Nothing was changed. ${BLOCKERS_FIRST}` }
  }
  if (nonEmpty(doc.CreditNotes) || nonEmpty(doc.Prepayments) || nonEmpty(doc.Overpayments)) {
    return { kind: 'refuse', reason: `In Xero, ${label} has credit notes or allocations applied, which Xero will not void or delete. Nothing was changed. ${BLOCKERS_FIRST}` }
  }
  let targetStatus: 'DELETED' | 'VOIDED'
  if (status === 'DRAFT' || status === 'SUBMITTED') targetStatus = 'DELETED'
  else if (status === 'AUTHORISED') targetStatus = 'VOIDED'
  else {
    return { kind: 'refuse', reason: `${label} is ${status || 'in an unknown state'} in Xero, which IMS does not delete or void. Nothing was changed. Resolve it in Xero first.` }
  }
  // The renumber is ONE write that changes the number and the Reference together, so the number alone says whether it has landed. A document
  // with no number of its own (a bill may have none) is judged by its Reference; one with neither has nothing to free.
  const renumbered = target.originalNumber !== ''
    ? sameText(doc.InvoiceNumber, target.releasedNumber)
    : target.originalReference === '' || sameText(doc.Reference, target.releasedReference)
  return { kind: 'steps', renumber: !renumbered, targetStatus }
}

export type XeroDocumentRead =
  | { ok: true; document: XeroDocumentForDelete }
  | { ok: false; error: string; notSent?: XeroResponse['notSent'] }

/** Read the document, bound to the id that was asked for. An unreadable answer is unknown, never absence. */
export async function readXeroDocumentForDelete(invoiceId: string): Promise<XeroDocumentRead> {
  const res = await xeroGet<XeroInvoicesResponse>(`Invoices/${encodeURIComponent(invoiceId)}`)
  if (!res.ok) return { ok: false, error: res.error ?? `Could not read the document from Xero (status ${res.status})`, notSent: res.notSent }
  const read = readSingleXeroDocument<XeroDocumentForDelete>(res.data, 'Invoices', 'InvoiceID', invoiceId)
  if (read.status !== 'found') return { ok: false, error: `Could not read the document from Xero: ${read.reason}` }
  return { ok: true, document: read.document }
}

export type XeroDeleteWriteResult = { success: true; externalRevisionAt: Date | null } | { success: false; error: string }

type WriteBody = { invoiceId: string; body: Record<string, unknown>; idempotencyKey: string | undefined; failure: string }

function writeResult(res: XeroResponse<XeroInvoicesResponse>, failure: string): XeroDeleteWriteResult {
  if (!res.ok || !res.data?.Invoices?.length) return { success: false, error: res.error ?? failure }
  return { success: true, externalRevisionAt: xeroDocumentRevisionAt(res.data.Invoices[0]) }
}

// One transport call per operation the ownership map names (the producer census declares each): the sales invoice delete and the bill delete.
async function writeSalesInvoice({ invoiceId, body, idempotencyKey, failure }: WriteBody): Promise<XeroDeleteWriteResult> {
  const res = await xeroPost<XeroInvoicesResponse>(`Invoices/${encodeURIComponent(invoiceId)}`, { Invoices: [{ InvoiceID: invoiceId, ...body }] }, { idempotencyKey })
  return writeResult(res, failure)
}

async function writePurchaseBill({ invoiceId, body, idempotencyKey, failure }: WriteBody): Promise<XeroDeleteWriteResult> {
  const res = await xeroPost<XeroInvoicesResponse>(`Invoices/${encodeURIComponent(invoiceId)}`, { Invoices: [{ InvoiceID: invoiceId, ...body }] }, { idempotencyKey })
  return writeResult(res, failure)
}

function writeDocument(type: XeroDeletableDocumentType, write: WriteBody): Promise<XeroDeleteWriteResult> {
  return type === 'ACCREC' ? writeSalesInvoice(write) : writePurchaseBill(write)
}

/** Write 1: the released number (and Reference, when the document carries one), so the original is free. */
export function renumberXeroDocument(target: XeroDeleteTarget, idempotencyKey?: string): Promise<XeroDeleteWriteResult> {
  const body: Record<string, unknown> = {}
  if (target.originalNumber !== '') body.InvoiceNumber = target.releasedNumber
  if (target.originalReference !== '') body.Reference = target.releasedReference
  return writeDocument(target.expectedType, { invoiceId: target.invoiceId, body, idempotencyKey, failure: 'Failed to renumber the document before deleting it' })
}

/** Write 2: DELETED for a draft or submitted document, VOIDED for an authorised one. */
export function setXeroDocumentStatus(type: XeroDeletableDocumentType, invoiceId: string, status: 'DELETED' | 'VOIDED', idempotencyKey?: string): Promise<XeroDeleteWriteResult> {
  return writeDocument(type, { invoiceId, body: { Status: status }, idempotencyKey, failure: `Failed to set the document to ${status}` })
}

/**
 * The target a queued delete names, read out of its payload. A payload missing the document id or the released number is refused here, before
 * anything is read or sent: the released number is what makes the delete resumable, and a row without it would have to invent one.
 */
export function parseXeroDeleteTarget(
  type: 'SALES_INVOICE_DELETE' | 'PURCHASE_INVOICE_DELETE',
  payload: Record<string, unknown>,
): { ok: true; target: XeroDeleteTarget } | { ok: false; error: string } {
  const text = (key: string): string => (typeof payload[key] === 'string' ? (payload[key] as string).trim() : '')
  const invoiceId = text('accountingInvoiceId')
  if (invoiceId === '') return { ok: false, error: `Missing accountingInvoiceId for ${type}` }
  const originalNumber = text('invoiceNumber')
  const releasedNumber = text('releasedNumber')
  const originalReference = text('reference')
  const releasedReference = text('releasedReference')
  if ((originalNumber !== '' && releasedNumber === '') || (originalReference !== '' && releasedReference === '')) {
    return { ok: false, error: `${type} for ${invoiceId} carries no released number, so the original number cannot be freed. Nothing was sent.` }
  }
  return {
    ok: true,
    target: {
      invoiceId,
      expectedType: type === 'SALES_INVOICE_DELETE' ? 'ACCREC' : 'ACCPAY',
      originalNumber,
      releasedNumber,
      originalReference,
      releasedReference,
    },
  }
}

/** What running a delete did. `fenced` hands the caller's own refusal back untouched (the processor's lease lost, a hold, ...). */
export type XeroDeleteRun<R> =
  | { kind: 'done'; status: string; externalRevisionAt: Date | null }
  | { kind: 'failed'; error: string }
  | { kind: 'fenced'; result: R }

/**
 * Run the delete: read the document, decide, then make the two writes in order (renumber, then the status), each one preceded by the
 * caller's fence. Nothing is written when the plan refuses or the document is already gone; a document that already carries the
 * released number is not renumbered again, so a retry after a failed status write adds no second suffix.
 */
export async function runXeroDocumentDelete<R>(
  target: XeroDeleteTarget,
  hooks: {
    /** Asked immediately before each remote write; `ok: false` carries the caller's refusal, and nothing is sent. */
    fence: (step: 'document-delete-renumber' | 'document-delete-status') => Promise<{ ok: true } | { ok: false; result: R }>
    idempotencyKey: (step: 'document-renumber' | 'document-status') => string | undefined
  },
): Promise<XeroDeleteRun<R>> {
  const read = await readXeroDocumentForDelete(target.invoiceId)
  if (!read.ok) return { kind: 'failed', error: read.error }
  const plan = planXeroDocumentDelete(read.document, target)
  if (plan.kind === 'refuse') return { kind: 'failed', error: plan.reason }
  if (plan.kind === 'already-done') return { kind: 'done', status: plan.status, externalRevisionAt: null }
  if (plan.renumber) {
    const fence = await hooks.fence('document-delete-renumber')
    if (!fence.ok) return { kind: 'fenced', result: fence.result }
    const renumbered = await renumberXeroDocument(target, hooks.idempotencyKey('document-renumber'))
    if (!renumbered.success) return { kind: 'failed', error: renumbered.error }
  }
  const fence = await hooks.fence('document-delete-status')
  if (!fence.ok) return { kind: 'fenced', result: fence.result }
  const removed = await setXeroDocumentStatus(target.expectedType, target.invoiceId, plan.targetStatus, hooks.idempotencyKey('document-status'))
  if (!removed.success) return { kind: 'failed', error: removed.error }
  return { kind: 'done', status: plan.targetStatus, externalRevisionAt: removed.externalRevisionAt }
}
