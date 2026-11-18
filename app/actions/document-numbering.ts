'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import {
  DOCUMENT_TYPE_SPECS,
  NUMBERED_DOCUMENT_TYPES,
  isNumberedDocumentType,
  type NumberedDocumentType,
} from '@/lib/domain/numbering/document-types'
import { parsePattern } from '@/lib/domain/numbering/pattern'
import { describeSalesInvoiceNumberOwner, type SalesInvoiceNumberOwner } from '@/lib/domain/numbering/invoice-number-owner'
import {
  DocumentNumberingError,
  describeNumbering,
  patternText,
  resetDocumentCounter,
  setDocumentPattern,
  type NumberingState,
} from '@/lib/domain/numbering/mint'

// ---------------------------------------------------------------------------
// Settings → Company → Numbering: the pattern and counter of each document IMS numbers itself.
// Every action needs `settings.company`. Sales invoice numbers have no action here: the incumbent owns them.
// ---------------------------------------------------------------------------

export type DocumentNumberingRow = NumberingState & {
  label: string
  description: string
  /** What stops two documents sharing a number: a database constraint, or a check made under the counter lock. */
  uniqueness: 'database' | 'application'
  /** The prefix of the Numbering table above, which the default pattern starts with. */
  defaultPatternText: string | null
}

export type DocumentNumberingOverview = {
  rows: DocumentNumberingRow[]
  salesInvoice: SalesInvoiceNumberOwner
}

async function corePrefixes(): Promise<Record<'so_prefix' | 'po_prefix' | 'cn_prefix', string>> {
  const { getNumberingFormats } = await import('./company')
  const formats = await getNumberingFormats()
  return { so_prefix: formats.so_prefix, po_prefix: formats.po_prefix, cn_prefix: formats.cn_prefix }
}

function prefixFor(type: NumberedDocumentType, prefixes: Awaited<ReturnType<typeof corePrefixes>>): string {
  const key = DOCUMENT_TYPE_SPECS[type].prefixKey
  return key === null ? '' : prefixes[key]
}

async function rowFor(type: NumberedDocumentType, prefixes: Awaited<ReturnType<typeof corePrefixes>>, pattern?: string | null): Promise<DocumentNumberingRow> {
  const spec = DOCUMENT_TYPE_SPECS[type]
  const state = await db.$transaction((tx) => describeNumbering(tx, type, { fallbackPrefix: prefixFor(type, prefixes), pattern }))
  const defaults = spec.defaultSegments(prefixFor(type, prefixes))
  return {
    ...state,
    label: spec.label,
    description: spec.description,
    uniqueness: spec.uniqueness,
    defaultPatternText: defaults === null ? null : patternText(defaults),
  }
}

export async function getDocumentNumbering(): Promise<DocumentNumberingOverview> {
  await requirePermission('settings.company')
  const prefixes = await corePrefixes()
  const rows: DocumentNumberingRow[] = []
  for (const type of NUMBERED_DOCUMENT_TYPES) rows.push(await rowFor(type, prefixes))
  return { rows, salesInvoice: describeSalesInvoiceNumberOwner() }
}

/** What a pattern would give next, without saving it. */
export async function previewDocumentPattern(input: { type: string; pattern: string }): Promise<{ success: boolean; nextPreview?: string | null; usesCounter?: boolean; error?: string }> {
  await requirePermission('settings.company')
  if (!isNumberedDocumentType(input.type)) return { success: false, error: unknownTypeMessage(input.type) }
  if (input.pattern.trim() !== '') {
    const parsed = parsePattern(input.pattern.trim())
    if (!parsed.ok) return { success: false, error: parsed.error }
  }
  const prefixes = await corePrefixes()
  const row = await rowFor(input.type, prefixes, input.pattern.trim() === '' ? null : input.pattern.trim())
  return { success: true, nextPreview: row.nextPreview, usesCounter: row.usesCounter }
}

function unknownTypeMessage(type: string): string {
  return type === 'sales_invoice' || type === 'invoice'
    ? describeSalesInvoiceNumberOwner().message
    : `"${type}" is not a document type IMS numbers.`
}

function failure(e: unknown): { success: false; error: string } {
  if (e instanceof DocumentNumberingError) return { success: false, error: e.message }
  throw e
}

/** Set the pattern of a document type; the empty string returns it to its default. Existing documents are never renumbered. */
export async function saveDocumentNumberPattern(input: { type: string; pattern: string }): Promise<{ success: boolean; error?: string }> {
  const session = await requirePermission('settings.company')
  if (!isNumberedDocumentType(input.type)) return { success: false, error: unknownTypeMessage(String(input.type)) }
  const type = input.type
  try {
    const result = await db.$transaction((tx) => setDocumentPattern(tx, type, String(input.pattern ?? ''), session.user.id ?? null))
    await logActivity({
      entityType: 'SETTING',
      tag: 'settings',
      action: 'updated',
      description: `Set the ${DOCUMENT_TYPE_SPECS[type].label.toLowerCase()} numbering pattern to ${result.pattern ?? 'the default'}. Existing documents keep their numbers.`,
      metadata: { documentType: type, pattern: result.pattern },
    })
    revalidatePath('/settings/company')
    return { success: true }
  } catch (e) {
    return failure(e)
  }
}

/** Make `nextNumber` the next number of a document type. Refused when it would reuse a number already in use. */
export async function resetDocumentNumberCounter(input: { type: string; nextNumber: number }): Promise<{ success: boolean; error?: string }> {
  const session = await requirePermission('settings.company')
  if (!isNumberedDocumentType(input.type)) return { success: false, error: unknownTypeMessage(String(input.type)) }
  const type = input.type
  try {
    const prefixes = await corePrefixes()
    const result = await db.$transaction((tx) => resetDocumentCounter(tx, type, Number(input.nextNumber), { fallbackPrefix: prefixFor(type, prefixes), updatedBy: session.user.id ?? null }))
    await logActivity({
      entityType: 'SETTING',
      tag: 'settings',
      action: 'updated',
      description: `Set the next ${DOCUMENT_TYPE_SPECS[type].label.toLowerCase()} number to ${result.counter + 1}`,
      metadata: { documentType: type, nextNumber: result.counter + 1, highestUsed: result.highestUsed },
    })
    revalidatePath('/settings/company')
    return { success: true }
  } catch (e) {
    return failure(e)
  }
}
