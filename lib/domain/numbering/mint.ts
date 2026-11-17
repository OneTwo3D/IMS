/**
 * MINTING THE NEXT DOCUMENT NUMBER, UNDER A ROW LOCK.
 *
 * One row per document type (`document_number_sequences`) holds the operator's pattern (NULL: the type's default)
 * and the counter. A pattern with {SEQ} takes that row FOR UPDATE inside the caller's transaction, reads the
 * counter, advances it and writes the document, so two creates can never be handed the same number and a create
 * that rolls back hands its number back. A pattern with no counter ({RAND:n} only, the default for sales and
 * purchase orders) takes no lock at all: it reads the pattern and draws random text.
 *
 * THE COUNTER RESTARTS WITH ITS PERIOD. A pattern carrying {YYYY} counts per year, {MM} per month, {DD} per day,
 * and none per ever (see `scopeKeyFor`). When the period has changed, the counter is seeded from the highest number
 * already issued in the new period (and, for credit notes, the counter the code kept before patterns existed), so a
 * period that already holds documents carries on after them instead of colliding with them.
 *
 * UNIQUENESS. Purchase order and shipment references are UNIQUE in the database. Sales order numbers and credit note
 * numbers have no database constraint, so the same check is made in the application, under the lock. Either way a
 * number that is already taken is SKIPPED: the counter moves on to the next free one. Skipping is bounded: after
 * MAX_SKIPS taken numbers in a row the mint REFUSES with an error naming the pattern, rather than loop; the usual cause
 * is a pattern that now matches a block of numbers issued under another scheme, and the fix is to reset the counter
 * past them (Settings > Company > Numbering).
 *
 * A pattern change NEVER renumbers a document: nothing here writes to an existing document, and the counter simply
 * continues in the new pattern (when the period is the same).
 *
 * THE ONE MINTED VALUE IS THE VALUE EVERYTHING ELSE READS. Callers store the returned string in the document's own
 * column and every later reader (PDFs, the accounting payload, the warehouse push) takes it from there; none of them
 * formats a second copy.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import {
  DOCUMENT_TYPE_SPECS,
  type NumberedDocumentType,
} from './document-types'
import {
  literalPrefixFor,
  parsePattern,
  renderPattern,
  scopeKeyFor,
  seqMatcherFor,
  summarise,
  type ParsedPattern,
  type PatternSegment,
} from './pattern'

type Tx = Prisma.TransactionClient

export const MAX_SKIPS = 1000
const MAX_RANDOM_TRIES = 25
/** The counter is a 32-bit integer in the database. */
export const COUNTER_MAX = 2_147_483_647

export class DocumentNumberingError extends Error {
  readonly code: 'PATTERN_INVALID' | 'PATTERN_EXHAUSTED' | 'COUNTER_BELOW_USED' | 'NO_COUNTER' | 'COUNTER_RANGE'
  constructor(code: DocumentNumberingError['code'], message: string) {
    super(message)
    this.name = 'DocumentNumberingError'
    this.code = code
  }
}

type SequenceRow = { pattern: string | null; scope_key: string | null; counter: number }

/** The pattern a type uses now: the operator's, or the type's default built on the configured prefix. */
export function effectiveParsedPattern(
  type: NumberedDocumentType,
  storedPattern: string | null,
  fallbackPrefix: string,
): ParsedPattern | null {
  if (storedPattern !== null && storedPattern !== '') {
    const parsed = parsePattern(storedPattern)
    if (!parsed.ok) throw new DocumentNumberingError('PATTERN_INVALID', `The stored ${DOCUMENT_TYPE_SPECS[type].label.toLowerCase()} numbering pattern is not valid: ${parsed.error}`)
    return parsed.parsed
  }
  const segments = DOCUMENT_TYPE_SPECS[type].defaultSegments(fallbackPrefix)
  return segments === null ? null : summarise(segments)
}

/** The default pattern written out, as the settings screen shows it. */
export function patternText(segments: PatternSegment[]): string {
  // wms-connector-boundary-ok: 2026-11-18: glues numbering tokens and operator-chosen literal text; it names no connector.
  return segments.map((s) => {
    switch (s.kind) {
      case 'lit': return s.text
      case 'year4': return '{YYYY}'
      case 'year2': return '{YY}'
      case 'month': return '{MM}'
      case 'day': return '{DD}'
      case 'seq': return s.pad > 0 ? `{SEQ:${s.pad}}` : '{SEQ}'
      case 'rand': return `{RAND:${s.len}}`
    }
  }).join('')
}

async function readSequence(tx: Tx, type: NumberedDocumentType, lock: boolean): Promise<SequenceRow | null> {
  const rows = lock
    ? await tx.$queryRaw<SequenceRow[]>`SELECT pattern, scope_key, counter FROM document_number_sequences WHERE document_type = ${type} FOR UPDATE`
    : await tx.$queryRaw<SequenceRow[]>`SELECT pattern, scope_key, counter FROM document_number_sequences WHERE document_type = ${type}`
  return rows[0] ?? null
}

async function ensureSequenceRow(tx: Tx, type: NumberedDocumentType): Promise<void> {
  await tx.$executeRaw`INSERT INTO document_number_sequences (document_type, updated_at) VALUES (${type}, now()) ON CONFLICT (document_type) DO NOTHING`
}

/** Read the row with the lock held, creating it first when this type has never been touched. */
async function lockSequence(tx: Tx, type: NumberedDocumentType): Promise<SequenceRow> {
  await ensureSequenceRow(tx, type)
  const row = await readSequence(tx, type, true)
  if (!row) throw new Error('The numbering counter could not be locked.')
  return row
}

/** The highest counter already used by a document of this type in the period, 0 when there is none. */
export async function highestUsedCounter(
  tx: Tx,
  type: NumberedDocumentType,
  parsed: ParsedPattern,
  scopeKey: string,
): Promise<number> {
  const matcher = seqMatcherFor(parsed, scopeKey)
  if (!matcher) return 0
  const values = await DOCUMENT_TYPE_SPECS[type].listStartingWith(tx, literalPrefixFor(parsed, scopeKey))
  let highest = 0
  for (const value of values) {
    const m = matcher.exec(value)
    if (!m) continue
    const n = Number.parseInt(m[1]!, 10)
    if (Number.isSafeInteger(n) && n > highest) highest = n
  }
  return highest
}

async function legacyCounter(tx: Tx, type: NumberedDocumentType, scopeKey: string): Promise<number> {
  const key = DOCUMENT_TYPE_SPECS[type].legacyCounterKey?.(scopeKey)
  if (!key) return 0
  const row = await tx.setting.findUnique({ where: { key }, select: { value: true } })
  const n = row?.value ? Number.parseInt(row.value, 10) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** The counter to start a period from: everything already issued in it, and the counter the earlier code kept. */
async function seedFor(tx: Tx, type: NumberedDocumentType, parsed: ParsedPattern, scopeKey: string): Promise<number> {
  return Math.max(await highestUsedCounter(tx, type, parsed, scopeKey), await legacyCounter(tx, type, scopeKey))
}

export type MintOptions = {
  /** The prefix of Settings > Company > Numbering that the type's default pattern starts with. */
  fallbackPrefix?: string
  date?: Date
  /** For tests: a fixed source of the random text. */
  rng?: () => number
}

/**
 * The next number for `type`, or null when the type has no pattern (a shipment before an operator sets one).
 * Must run inside the transaction that writes the document: the lock is held until it ends.
 */
export async function mintDocumentNumber(tx: Tx, type: NumberedDocumentType, options: MintOptions = {}): Promise<string | null> {
  const spec = DOCUMENT_TYPE_SPECS[type]
  const date = options.date ?? new Date()
  const prefix = options.fallbackPrefix ?? ''
  const unlocked = await readSequence(tx, type, false)
  let parsed = effectiveParsedPattern(type, unlocked?.pattern ?? null, prefix)
  if (parsed === null) return null

  if (!parsed.usesSeq) {
    for (let attempt = 0; attempt < MAX_RANDOM_TRIES; attempt++) {
      const candidate = renderPattern(parsed, { date, basis: spec.basis, rng: options.rng })
      if (!(await spec.exists(tx, candidate))) return candidate
    }
    throw new DocumentNumberingError('PATTERN_EXHAUSTED', `Could not find a free ${spec.label.toLowerCase()} number: the pattern's random part is too short for the numbers already issued. Add a counter, {SEQ}, to the pattern.`)
  }

  // A counter: the row is locked from here to the end of the caller's transaction. The pattern is read AGAIN under the
  // lock, because a save of the pattern takes the same lock and may have landed since the unlocked read.
  const row = await lockSequence(tx, type)
  parsed = effectiveParsedPattern(type, row.pattern, prefix)
  if (parsed === null) return null
  if (!parsed.usesSeq) return mintDocumentNumber(tx, type, options)
  const scopeKey = scopeKeyFor(parsed, date, spec.basis)
  let counter = row.scope_key === scopeKey ? row.counter : await seedFor(tx, type, parsed, scopeKey)

  for (let skipped = 0; skipped <= MAX_SKIPS; skipped++) {
    counter += 1
    if (counter > COUNTER_MAX) throw new DocumentNumberingError('COUNTER_RANGE', `The ${spec.label.toLowerCase()} counter has reached its largest value.`)
    const candidate = renderPattern(parsed, { date, basis: spec.basis, seq: counter, rng: options.rng })
    if (await spec.exists(tx, candidate)) continue
    await tx.$executeRaw`UPDATE document_number_sequences SET counter = ${counter}, scope_key = ${scopeKey}, updated_at = now() WHERE document_type = ${type}`
    return candidate
  }
  throw new DocumentNumberingError('PATTERN_EXHAUSTED', `Refused to number this ${spec.label.toLowerCase()}: the next ${MAX_SKIPS + 1} numbers of the pattern are all taken already. Reset the counter past the numbers in use (Settings > Company > Numbering).`)
}

/** `mintDocumentNumber` for a type that always has a number (every type but a shipment). */
export async function mintRequiredDocumentNumber(tx: Tx, type: NumberedDocumentType, options: MintOptions = {}): Promise<string> {
  const value = await mintDocumentNumber(tx, type, options)
  if (value === null) throw new DocumentNumberingError('PATTERN_INVALID', `The ${DOCUMENT_TYPE_SPECS[type].label.toLowerCase()} has no numbering pattern.`)
  return value
}

export type NumberingState = {
  type: NumberedDocumentType
  /** The operator's pattern; null while the type uses its default. */
  storedPattern: string | null
  /** The pattern in force, as text; null when the type is not numbered. */
  effectivePattern: string | null
  isDefault: boolean
  /** The last counter issued in the current period (0 when none, or when the pattern has no counter). */
  counter: number
  /** The highest counter among documents already numbered in the current period. */
  highestUsed: number
  usesCounter: boolean
  /** The period the counter belongs to ('' for one counter for ever). */
  scopeKey: string
  scope: ParsedPattern['scope']
  /** The number the next document would get, as far as can be known now (a random part is a sample). */
  nextPreview: string | null
}

/** Read-only: what the settings screen shows. Takes no lock and changes nothing. */
export async function describeNumbering(
  tx: Tx,
  type: NumberedDocumentType,
  options: { fallbackPrefix?: string; date?: Date; pattern?: string | null } = {},
): Promise<NumberingState> {
  const spec = DOCUMENT_TYPE_SPECS[type]
  const date = options.date ?? new Date()
  const row = await readSequence(tx, type, false)
  const stored = options.pattern !== undefined ? options.pattern : row?.pattern ?? null
  const parsed = effectiveParsedPattern(type, stored, options.fallbackPrefix ?? '')
  const isDefault = stored === null || stored === ''
  if (parsed === null) {
    return { type, storedPattern: null, effectivePattern: null, isDefault: true, counter: 0, highestUsed: 0, usesCounter: false, scopeKey: '', scope: 'none', nextPreview: null }
  }
  const scopeKey = scopeKeyFor(parsed, date, spec.basis)
  const highestUsed = await highestUsedCounter(tx, type, parsed, scopeKey)
  const counter = !parsed.usesSeq ? 0 : row?.scope_key === scopeKey ? row.counter : Math.max(highestUsed, await legacyCounter(tx, type, scopeKey))
  const nextPreview = renderPattern(parsed, { date, basis: spec.basis, seq: counter + 1 })
  return {
    type,
    storedPattern: isDefault ? null : stored,
    effectivePattern: patternText(parsed.segments),
    isDefault,
    counter,
    highestUsed,
    usesCounter: parsed.usesSeq,
    scopeKey,
    scope: parsed.scope,
    nextPreview,
  }
}

/**
 * Set the pattern of a type. The empty string returns the type to its default. Takes the row lock, so it waits for a
 * create in flight and a create after it sees the new pattern. Existing documents are never touched.
 */
export async function setDocumentPattern(
  tx: Tx,
  type: NumberedDocumentType,
  pattern: string,
  updatedBy: string | null,
): Promise<{ pattern: string | null }> {
  let value: string | null = null
  if (pattern.trim() !== '') {
    const parsed = parsePattern(pattern.trim())
    if (!parsed.ok) throw new DocumentNumberingError('PATTERN_INVALID', parsed.error)
    value = pattern.trim()
  }
  await lockSequence(tx, type)
  await tx.$executeRaw`UPDATE document_number_sequences SET pattern = ${value}, updated_at = now(), updated_by = ${updatedBy} WHERE document_type = ${type}`
  return { pattern: value }
}

/**
 * Move the counter so that the NEXT number is `nextNumber`. Refused when that would go back to, or below, a number
 * already used in the current period: the counter can be moved forward freely and back only as far as the highest
 * number in use.
 */
export async function resetDocumentCounter(
  tx: Tx,
  type: NumberedDocumentType,
  nextNumber: number,
  options: { fallbackPrefix?: string; date?: Date; updatedBy: string | null },
): Promise<{ counter: number; highestUsed: number }> {
  const spec = DOCUMENT_TYPE_SPECS[type]
  if (!Number.isInteger(nextNumber) || nextNumber < 1 || nextNumber > COUNTER_MAX) {
    throw new DocumentNumberingError('COUNTER_RANGE', `The next number must be a whole number from 1 to ${COUNTER_MAX}.`)
  }
  const row = await lockSequence(tx, type)
  const parsed = effectiveParsedPattern(type, row.pattern, options.fallbackPrefix ?? '')
  if (parsed === null || !parsed.usesSeq) {
    throw new DocumentNumberingError('NO_COUNTER', `The ${spec.label.toLowerCase()} pattern has no counter, so there is nothing to reset. Add {SEQ} to the pattern first.`)
  }
  const scopeKey = scopeKeyFor(parsed, options.date ?? new Date(), spec.basis)
  const highestUsed = await highestUsedCounter(tx, type, parsed, scopeKey)
  if (nextNumber - 1 < highestUsed) {
    throw new DocumentNumberingError('COUNTER_BELOW_USED', `The next number cannot be ${nextNumber}: ${spec.label.toLowerCase()} number ${highestUsed} is already in use. Choose ${highestUsed + 1} or higher.`)
  }
  const counter = nextNumber - 1
  await tx.$executeRaw`UPDATE document_number_sequences SET counter = ${counter}, scope_key = ${scopeKey}, updated_at = now(), updated_by = ${options.updatedBy} WHERE document_type = ${type}`
  return { counter, highestUsed }
}
