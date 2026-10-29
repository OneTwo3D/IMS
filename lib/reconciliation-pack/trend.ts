/**
 * THE TREND READER: every published pair, verified, and the chain between them.
 *
 * It trusts nothing it finds. The report directory and every ancestor must be ones only root or this account can
 * modify; every run directory is a real 0700-class directory; every file is opened once with O_NOFOLLOW and
 * digested over the very bytes that are then parsed (`readTrustedRegularFileBytes`). A pair is accepted only if
 * the JSON parses strictly, names its Markdown and its evidence by sha256 and those match, and every derived
 * value (summary, exit code, per-item counts) equals what the evidence and items imply. Then the chain: reports
 * are ordered by `sequence`, never by time, and must be exactly 1..n with each `previousReportSha256` equal to the
 * digest of the previous JSON. A gap, a fork (two reports with one sequence or one predecessor), a broken link or
 * a change of system identifier REFUSES; there is no best-effort partial chain.
 *
 * NOT DETECTABLE: removal of the newest report or reports leaves a shorter, valid chain. A run directory with no
 * JSON (a publication that died before its commit) is counted as unpublished and skipped; it is not a report.
 */

import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { checkAncestors, readTrustedRegularFileBytes } from '@/lib/ops/published-report'
import { MAX_EVIDENCE_BYTES, MAX_REPORTS_READ, MAX_REPORT_JSON_BYTES, PACK_EVIDENCE_FILE, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN, type PackChainCode, type PackItemId, type PackOutcome } from '@/lib/reconciliation-pack/constants'
import { RUN_ID_RE, ReportInvalid, extractSettlingLines, parseReport, sha256Hex, verifyEvidence, type ReportRecord, type SettlingLine } from '@/lib/reconciliation-pack/report'

/** `settling` is the verified evidence's entries that carry settling state (the only part of the evidence a later run reads). */
export type ChainEntry = { sequence: number; runId: string; sha256: string; record: ReportRecord; settling: SettlingLine[] }
export type ChainResult =
  | { ok: true; reports: ChainEntry[]; head: ChainEntry | null; unpublishedRuns: number }
  | { ok: false; code: PackChainCode; runId: string | null }

function refuse(code: PackChainCode, runId: string | null = null): ChainResult {
  return { ok: false, code, runId }
}

function runDirProblem(dir: string): boolean {
  try {
    const info = lstatSync(dir)
    const me = typeof process.getuid === 'function' ? process.getuid() : 0
    return info.isSymbolicLink() || !info.isDirectory() || (info.uid !== 0 && info.uid !== me) || (info.mode & 0o077) !== 0
  } catch { return true }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export function readPackChain(reportDir: string): ChainResult {
  if (checkAncestors(reportDir, 'report directory') !== null) return refuse('DIR_UNTRUSTED')
  let names: string[]
  try { names = readdirSync(reportDir) } catch { return refuse('DIR_UNREADABLE') }
  const candidates = names.filter((name) => RUN_ID_RE.test(name)).sort()
  if (candidates.length > MAX_REPORTS_READ) return refuse('TOO_MANY')

  const found: ChainEntry[] = []
  let unpublished = 0
  for (const runId of candidates) {
    const dir = path.join(reportDir, runId)
    if (runDirProblem(dir)) return refuse('PAIR_INVALID', runId)
    let jsonBytes: Buffer
    try { jsonBytes = readTrustedRegularFileBytes(path.join(dir, PACK_REPORT_JSON), MAX_REPORT_JSON_BYTES) } catch (error) {
      if (isMissing(error)) { unpublished += 1; continue }
      return refuse('PAIR_INVALID', runId)
    }
    try {
      const record = parseReport(jsonBytes.toString('utf8'))
      if (record.runId !== runId) throw new ReportInvalid('the run id is not the directory name')
      const markdown = readTrustedRegularFileBytes(path.join(dir, PACK_REPORT_MARKDOWN), MAX_REPORT_JSON_BYTES)
      if (sha256Hex(markdown) !== record.companionMarkdownSha256) throw new ReportInvalid('the Markdown does not match the digest the JSON records')
      const evidence = readTrustedRegularFileBytes(path.join(dir, PACK_EVIDENCE_FILE), MAX_EVIDENCE_BYTES)
      verifyEvidence(evidence.toString('utf8'), record)
      if (sha256Hex(evidence) !== record.evidence.sha256) throw new ReportInvalid('the evidence bytes are not valid UTF-8 text')
      found.push({ sequence: record.sequence, runId, sha256: sha256Hex(jsonBytes), record, settling: extractSettlingLines(evidence.toString('utf8')) })
    } catch {
      return refuse('PAIR_INVALID', runId)
    }
  }

  found.sort((a, b) => a.sequence - b.sequence)
  const seenSequence = new Set<number>()
  const seenPrevious = new Set<string | null>()
  for (const entry of found) {
    if (seenSequence.has(entry.sequence)) return refuse('FORK', entry.runId)
    seenSequence.add(entry.sequence)
    if (entry.record.previousReportSha256 !== null) {
      if (seenPrevious.has(entry.record.previousReportSha256)) return refuse('FORK', entry.runId)
      seenPrevious.add(entry.record.previousReportSha256)
    }
  }
  for (const [index, entry] of found.entries()) {
    if (entry.sequence !== index + 1) return refuse('GAP', entry.runId)
    if (index > 0 && entry.record.previousReportSha256 !== found[index - 1]!.sha256) return refuse('LINK_BROKEN', entry.runId)
    if (entry.record.systemIdentifier !== found[0]!.record.systemIdentifier) return refuse('SYSTEM_MISMATCH', entry.runId)
  }
  return { ok: true, reports: found, head: found.length ? found[found.length - 1]! : null, unpublishedRuns: unpublished }
}

/** One item's outcome over the chain, in sequence order. */
export function itemSeries(reports: readonly ChainEntry[], id: PackItemId): Array<{ sequence: number; outcome: PackOutcome }> {
  // A report published before an item existed does not carry it: it has no outcome for it, which is not a missing value to guess at.
  return reports.flatMap((entry) => {
    const item = entry.record.items.find((candidate) => candidate.id === id)
    return item === undefined ? [] : [{ sequence: entry.sequence, outcome: item.outcome }]
  })
}
