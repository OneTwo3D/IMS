/**
 * THE WRITTEN SKU-COVERAGE EXCLUSIONS R14 USES (owner decision D8): one exclusion is for one SKU in ONE system, it says who accepted
 * it, when and why, and it EXPIRES (at most 90 days after it was accepted).
 *
 * The trust is the R15 acceptance file's (lib/reconciliation-pack/acceptances.ts): used only if it is a regular file (a symlink is never
 * followed) owned by root or the running account, not writable by group or others, in a directory whose every ancestor only root or that
 * account can modify. Otherwise the WHOLE file is rejected and accepts nothing, so R14 reports every missing SKU: the safe side. The
 * format is closed: an unknown field, a version other than 1, a repeated (SKU, system) pair, a system that is not one of the four, or
 * more entries than the cap rejects the WHOLE file (which exclusion applies would be ambiguous); an entry that is incomplete (who, why,
 * when, a reason of at least 15 characters, an expiry after the acceptance and within 90 days) accepts nothing and the others stand.
 * Whether an entry is IN FORCE is decided against the run's clock: not before it was accepted, and not at or after its expiry.
 *
 * Nothing from the file reaches text except the SKU, and only through the identity-token sanitiser like every other SKU.
 */

import path from 'node:path'

import { ACCEPTANCE_REASON_MIN_LENGTH } from '@/lib/ops/readiness-gate-constants'
import { UntrustedPathError, readTrustedRegularFile } from '@/lib/ops/published-report'
import {
  MAX_SKU_EXCLUSION_BYTES,
  R14_SYSTEMS,
  SKU_EXCLUSION_DEFAULT_FILE,
  SKU_EXCLUSION_MAX_DAYS,
  SKU_EXCLUSION_MAX_ENTRIES,
  SKU_EXCLUSION_SCHEMA_VERSION,
  type R14System,
} from '@/lib/reconciliation-pack/constants'

export type SkuExclusion = { sku: string; system: R14System; acceptedBy: string; acceptedAt: string; reason: string; expiresAt: string }
export type SkuExclusionFile =
  | { status: 'absent'; entries: [] }
  | { status: 'rejected'; entries: [] }
  | { status: 'ok'; entries: SkuExclusion[]; incomplete: number }

const FILE_KEYS = ['schemaVersion', 'exclusions'] as const
const ENTRY_KEYS = ['sku', 'system', 'acceptedBy', 'acceptedAt', 'reason', 'expiresAt'] as const
const DAY_MS = 86_400_000
const ISO_ZONED_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/
/** A SKU as the pack compares it: the exact string, with nothing invisible in it. */
const FORBIDDEN_SKU = /[\u0000-\u001f\u007f ​-‍⁠﻿]/

function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_ZONED_RE.test(value)) return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : t
}

const REJECTED: SkuExclusionFile = { status: 'rejected', entries: [] }

/** The file's text, or null for "there is no file". Strict: see the header. */
export function parseSkuExclusionFile(text: string | null): SkuExclusionFile {
  if (text === null) return { status: 'absent', entries: [] }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return REJECTED }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return REJECTED
  const file = parsed as Record<string, unknown>
  if (Object.keys(file).some((key) => !(FILE_KEYS as readonly string[]).includes(key))) return REJECTED
  if (file.schemaVersion !== SKU_EXCLUSION_SCHEMA_VERSION) return REJECTED
  if (!Array.isArray(file.exclusions) || file.exclusions.length > SKU_EXCLUSION_MAX_ENTRIES) return REJECTED

  const entries: SkuExclusion[] = []
  const seen = new Set<string>()
  let incomplete = 0
  for (const raw of file.exclusions as unknown[]) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return REJECTED
    const entry = raw as Record<string, unknown>
    if (Object.keys(entry).some((key) => !(ENTRY_KEYS as readonly string[]).includes(key))) return REJECTED
    // The identity of an exclusion is the (SKU, system) pair; a repeated pair is ambiguous whatever else it says.
    if (typeof entry.sku === 'string' && typeof entry.system === 'string') {
      const pair = `${entry.system}\u0001${entry.sku}`
      if (seen.has(pair)) return REJECTED
      seen.add(pair)
    }
    const acceptedAt = instant(entry.acceptedAt)
    const expiresAt = instant(entry.expiresAt)
    const ok =
      typeof entry.sku === 'string' && entry.sku !== '' && entry.sku.length <= 64 && !FORBIDDEN_SKU.test(entry.sku) && entry.sku === entry.sku.normalize('NFC') && entry.sku === entry.sku.trim()
      && typeof entry.system === 'string' && (R14_SYSTEMS as readonly string[]).includes(entry.system)
      && typeof entry.acceptedBy === 'string' && entry.acceptedBy.trim() !== ''
      && typeof entry.reason === 'string' && entry.reason.trim().length >= ACCEPTANCE_REASON_MIN_LENGTH
      && acceptedAt !== null && expiresAt !== null && expiresAt > acceptedAt && expiresAt - acceptedAt <= SKU_EXCLUSION_MAX_DAYS * DAY_MS
    if (!ok) { incomplete += 1; continue }
    entries.push({ sku: entry.sku as string, system: entry.system as R14System, acceptedBy: (entry.acceptedBy as string).trim(), acceptedAt: entry.acceptedAt as string, reason: (entry.reason as string).trim(), expiresAt: entry.expiresAt as string })
  }
  return { status: 'ok', entries, incomplete }
}

/** The exclusions in force at `now`: accepted at or before it, and not yet expired. An untrusted or absent file has none. */
export function exclusionsInForce(file: SkuExclusionFile, now: Date): SkuExclusion[] {
  const current = now.getTime()
  if (!Number.isFinite(current) || file.status !== 'ok') return []
  return file.entries.filter((entry) => {
    const from = instant(entry.acceptedAt)
    const to = instant(entry.expiresAt)
    return from !== null && to !== null && from <= current && current < to
  })
}

/** A DEFAULT path that does not exist means none; a NAMED path that cannot be read is a refusal; an untrusted file accepts nothing. */
export function loadSkuExclusions(explicit: string | null, repoRoot: string): { file: SkuExclusionFile } | { refused: true } {
  const file = path.resolve(explicit !== null ? explicit : path.join(repoRoot, SKU_EXCLUSION_DEFAULT_FILE))
  try {
    return { file: parseSkuExclusionFile(readTrustedRegularFile(file, MAX_SKU_EXCLUSION_BYTES)) }
  } catch (error) {
    if (error instanceof UntrustedPathError) return { file: REJECTED }
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && explicit === null) return { file: parseSkuExclusionFile(null) }
    if (explicit !== null) return { refused: true }
    return { file: REJECTED }
  }
}
