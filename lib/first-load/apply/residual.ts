/**
 * THE RESIDUAL: given what the database holds for a step right now, which prepared rows still have to be loaded.
 *
 * Correctness never depends on a journal. Every step, on the first run and on every resume, reads the database and sorts each prepared
 * unit (a product, a supplier, an opening-stock pair, a whole purchase order) into exactly one state:
 *
 *   absent               the key is not there: load it;
 *   present-matching     the key is there with the fingerprint of the file: skip it (the importer would refuse or rewrite it);
 *   present-conflicting  the key is there with other data, or a look-alike or foreign row is there: STOP, nothing more is written.
 *
 * A crash between two per-row transactions leaves a database the next run reads correctly. The residual file is the header plus the
 * absent units' rows, in their original order, one file per prepared chunk that still has work.
 */
import { serializeCsv } from '../csv'
import { canonicalJson, sha256Hex } from '../snapshot'
import { RESIDUAL_FILE_PREFIX, type ConflictCode, type UnitState } from './constants'
import type { KeyedUnit, StepRows } from './keys'
import type { ApplyStepId } from './constants'

/** One row of a step as the database holds it, already reduced to the runner's key and fingerprint strings. */
export interface ObservedEntry {
  key: string
  collisionKey: string
  fingerprint: string
  recipe: string | null
}

export interface StepObservation {
  /** Everything the database holds of this step's kind that could matter: one entry per database row. */
  entries: ObservedEntry[]
  /** Opening stock only: keys ("UPPERSKU|UPPERWAREHOUSE") that have stock, a cost layer or a movement that is not an opening layer of this run. */
  foreignHistoryKeys?: string[]
}

export interface ClassifiedUnit {
  unit: KeyedUnit
  state: UnitState
  conflict?: { code: ConflictCode; detail: string }
}

export interface ClassifiedStep {
  step: ApplyStepId
  units: ClassifiedUnit[]
  /** Database rows nobody in this run emitted. Any of them is a conflict. */
  foreign: ObservedEntry[]
  counts: { emitted: number; absent: number; presentMatching: number; presentConflicting: number; foreign: number }
}

export class ObservationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ObservationError'
  }
}

export function classifyStep(step: ApplyStepId, units: readonly KeyedUnit[], observation: StepObservation): ClassifiedStep {
  const byKey = new Map<string, ObservedEntry[]>()
  const byCollision = new Map<string, ObservedEntry[]>()
  for (const entry of observation.entries) {
    ;(byKey.get(entry.key) ?? byKey.set(entry.key, []).get(entry.key)!).push(entry)
    ;(byCollision.get(entry.collisionKey) ?? byCollision.set(entry.collisionKey, []).get(entry.collisionKey)!).push(entry)
  }
  const history = new Set(observation.foreignHistoryKeys ?? [])
  const emitted = new Set(units.map((u) => u.key))
  const classified: ClassifiedUnit[] = units.map((unit) => {
    const same = byKey.get(unit.key) ?? []
    if (history.has(unit.key)) return { unit, state: 'present-conflicting', conflict: { code: 'FOREIGN_HISTORY', detail: 'history exists that is not an opening layer' } }
    if (same.length > 1) return { unit, state: 'present-conflicting', conflict: { code: 'DUPLICATE_IN_DATABASE', detail: `${same.length} rows share the key` } }
    if (same.length === 1) {
      const found = same[0]
      if (found.fingerprint !== unit.fingerprint) return { unit, state: 'present-conflicting', conflict: { code: 'FIELDS_DIFFER', detail: 'the stored fields differ from the file' } }
      if (found.recipe !== unit.recipe) return { unit, state: 'present-conflicting', conflict: { code: 'RECIPE_DIFFERS', detail: found.recipe === null ? 'the recipe is missing' : 'the recipe differs from the file' } }
      return { unit, state: 'present-matching' }
    }
    const lookalike = (byCollision.get(unit.collisionKey) ?? []).find((e) => e.key !== unit.key)
    if (lookalike) return { unit, state: 'present-conflicting', conflict: { code: 'CASE_COLLISION', detail: 'a different key equal in upper case exists' } }
    return { unit, state: 'absent' }
  })
  const foreign = observation.entries.filter((e) => !emitted.has(e.key))
  const count = (state: UnitState) => classified.filter((c) => c.state === state).length
  return {
    step,
    units: classified,
    foreign,
    counts: { emitted: units.length, absent: count('absent'), presentMatching: count('present-matching'), presentConflicting: count('present-conflicting'), foreign: foreign.length },
  }
}

/** True when the step may proceed: nothing conflicts and nothing foreign is there. */
export function hasConflict(classified: ClassifiedStep): boolean {
  return classified.counts.presentConflicting > 0 || classified.counts.foreign > 0
}

export interface ConflictReport {
  key: string
  code: ConflictCode
  detail: string
}

/** Every conflict of a step, sorted by key so the report is deterministic. Foreign rows are reported under FOREIGN_ROW. */
export function listConflicts(classified: ClassifiedStep): ConflictReport[] {
  const list: ConflictReport[] = []
  for (const c of classified.units) if (c.conflict) list.push({ key: c.unit.key, ...c.conflict })
  for (const f of classified.foreign) list.push({ key: f.key, code: 'FOREIGN_ROW', detail: CONFLICT_DETAIL_FOREIGN })
  return list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

const CONFLICT_DETAIL_FOREIGN = 'the database holds a row this run did not emit'

export interface ResidualFile {
  /** `residual-<step>-<chunk>.csv`. */
  name: string
  chunk: number
  rows: number
  bytes: Uint8Array
  sha256: string
}

/** The header plus the absent units' rows, original order, one file per chunk with work left. Empty array when everything is present. */
export function buildResidual(step: ApplyStepId, data: StepRows, classified: ClassifiedStep): ResidualFile[] {
  const absentRows = new Set<number>()
  for (const c of classified.units) if (c.state === 'absent') for (const index of c.unit.rowIndexes) absentRows.add(index)
  const chunks = new Map<number, string[][]>()
  data.rows.forEach((row, index) => {
    if (!absentRows.has(index)) return
    ;(chunks.get(row.chunk) ?? chunks.set(row.chunk, []).get(row.chunk)!).push(row.cells)
  })
  return [...chunks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([chunk, rows]) => {
      const bytes = new TextEncoder().encode(serializeCsv(data.header, rows))
      return { name: `${RESIDUAL_FILE_PREFIX}${step}-${String(chunk).padStart(3, '0')}.csv`, chunk, rows: rows.length, bytes, sha256: sha256Hex(bytes) }
    })
}

/** A short deterministic digest of a classification, for the journal and the report. */
export function classificationDigest(classified: ClassifiedStep): string {
  return sha256Hex(canonicalJson(classified.units.map((c) => [c.unit.key, c.state, c.conflict?.code ?? null])))
}
