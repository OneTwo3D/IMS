/**
 * PUBLISHING A PACK REPORT: lock, read the chain, assign the sequence, write the triple, commit with the JSON last.
 *
 * Order, and why:
 *   1. The report directory is created (0700) if absent, then it and every ancestor must be ones only root or this
 *      account can modify. Otherwise REFUSED, nothing written.
 *   2. The run lock is taken (lib/reconciliation-pack/lock.ts) BEFORE the chain is read, so the sequence number a run
 *      assigns cannot also be assigned to a run that started later. It is held until after the read-back below.
 *   3. The whole chain is verified (trend.ts). A broken chain REFUSES the run: new reports are never appended to a
 *      history that cannot be proven.
 *   4. The run directory is created exclusively (0700; anything already at the name, including a symlink, refuses).
 *      evidence.jsonl, the Markdown and the JSON are each created with O_EXCL|O_NOFOLLOW under a temporary name and
 *      fsynced; evidence and Markdown are renamed into place; then the lock is verified AGAIN (inode and token), and
 *      only then is the JSON renamed into place: the JSON is the commit record. A lock that is no longer ours at that
 *      moment means nothing is published (exit 3).
 *   5. The chain is read back and the new report must be its head. Anything else is not-published.
 *
 * A failed publication removes only what this run created, so no JSON ever sits beside a failed write.
 */

import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import { checkAncestors, fsyncDirectory, writeExclusive } from '@/lib/ops/published-report'
import { PACK_EVIDENCE_FILE, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN, packExitCode, type PackChainCode } from '@/lib/reconciliation-pack/constants'
import { acquireRunLock, type LockHooks } from '@/lib/reconciliation-pack/lock'
import { buildReport, sha256Hex, type ReportInput, type ReportRecord } from '@/lib/reconciliation-pack/report'
import { readPackChain } from '@/lib/reconciliation-pack/trend'

export type PublishHooks = {
  /** Test seam: write one file. Defaults to writeExclusive. */
  writeFile?: (file: string, data: string) => void
  /** Test seam: runs after the evidence and Markdown are in place and before the lock is re-verified. */
  beforeCommit?: () => void
  /** Test seam: runs after the JSON is in place and before the read-back verifies it. */
  afterCommit?: () => void
  /** Test seam: called as each phase begins, so the order lock, chain read, commit can be asserted. */
  onStep?: (step: 'locked' | 'chain-read') => void
  lock?: LockHooks
}

export type PublishResult =
  | { ok: true; exitCode: number; record: ReportRecord; json: string; markdown: string; evidence: string; jsonSha256: string }
  | { ok: false; exitCode: number; kind: 'refused' | 'not-published'; code: PackChainCode }

const refused = (code: PackChainCode): PublishResult => ({ ok: false, exitCode: packExitCode('refused'), kind: 'refused', code })
const notPublished = (code: PackChainCode): PublishResult => ({ ok: false, exitCode: packExitCode('report-not-published'), kind: 'not-published', code })

export function publishPackReport(reportDir: string, input: ReportInput, hooks: PublishHooks = {}): PublishResult {
  try {
    mkdirSync(reportDir, { recursive: true, mode: 0o700 })
  } catch { return refused('DIR_UNREADABLE') }
  if (checkAncestors(reportDir, 'report directory') !== null) return refused('DIR_UNTRUSTED')

  const lock = acquireRunLock(reportDir, hooks.lock)
  if (!lock.ok) return refused(lock.code)
  hooks.onStep?.('locked')
  const created: string[] = []
  let outDir: string | null = null
  try {
    const chain = readPackChain(reportDir)
    hooks.onStep?.('chain-read')
    if (!chain.ok) return refused(chain.code)
    if (chain.head && chain.head.record.systemIdentifier !== input.systemIdentifier) return refused('SYSTEM_MISMATCH')
    const sequence = chain.head ? chain.head.sequence + 1 : 1
    const { body, evidenceText, markdown: markdownText } = buildReport(input, sequence, chain.head ? chain.head.sha256 : null)
    const record: ReportRecord = { ...body, companionMarkdownSha256: sha256Hex(markdownText) }
    const jsonText = `${JSON.stringify(record, null, 2)}\n`

    outDir = path.join(reportDir, input.runId)
    const jsonFile = path.join(outDir, PACK_REPORT_JSON)
    const markdownFile = path.join(outDir, PACK_REPORT_MARKDOWN)
    const evidenceFile = path.join(outDir, PACK_EVIDENCE_FILE)
    const write = hooks.writeFile ?? writeExclusive
    const suffix = randomBytes(6).toString('hex')
    const tmp = (name: string) => path.join(outDir!, `.${name}.${suffix}.tmp`)

    try {
      mkdirSync(outDir, { mode: 0o700 }) // not recursive: EEXIST is a refusal
    } catch { outDir = null; return notPublished('WRITE_FAILED') }
    const id = lstatSync(outDir)
    if (id.isSymbolicLink() || !id.isDirectory()) return notPublished('WRITE_FAILED')
    try {
      created.push(tmp(PACK_EVIDENCE_FILE)); write(tmp(PACK_EVIDENCE_FILE), evidenceText)
      created.push(tmp(PACK_REPORT_MARKDOWN)); write(tmp(PACK_REPORT_MARKDOWN), markdownText)
      created.push(tmp(PACK_REPORT_JSON)); write(tmp(PACK_REPORT_JSON), jsonText)
      created.push(evidenceFile); renameSync(tmp(PACK_EVIDENCE_FILE), evidenceFile)
      created.push(markdownFile); renameSync(tmp(PACK_REPORT_MARKDOWN), markdownFile)
      hooks.beforeCommit?.()
      if (!lock.handle.verify()) return notPublished('LOCK_LOST')
      created.push(jsonFile); renameSync(tmp(PACK_REPORT_JSON), jsonFile)
      fsyncDirectory(outDir)
      fsyncDirectory(reportDir)
    } catch { return notPublished('WRITE_FAILED') }

    hooks.afterCommit?.()
    const after = readPackChain(reportDir)
    if (!after.ok || !after.head || after.head.runId !== input.runId || after.head.sha256 !== sha256Hex(jsonText)) {
      return notPublished(after.ok ? 'PAIR_INVALID' : after.code)
    }
    created.length = 0 // committed: nothing to undo
    outDir = null
    return { ok: true, exitCode: record.exitCode, record, json: jsonFile, markdown: markdownFile, evidence: evidenceFile, jsonSha256: after.head.sha256 }
  } finally {
    for (const file of created.splice(0)) rmSync(file, { force: true })
    if (outDir !== null) { try { rmdirSync(outDir) } catch { /* not empty or already gone: leave it */ } }
    lock.handle.release()
  }
}
