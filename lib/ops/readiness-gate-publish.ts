/**
 * PUBLISHING THE GATE'S REPORT: Markdown first, the JSON last as the commit record.
 *
 * The same discipline as the fresh-install rehearsal (lib/ops/published-report.ts): the run's directory is
 * created exclusively (mode 700; anything already at that name, including a planted symlink, refuses the
 * publication), each file is created with O_EXCL|O_NOFOLLOW under a random temporary name, fsynced and
 * renamed, and the JSON names its Markdown by sha256 so a JSON whose Markdown is missing or different is
 * detectably not the pair that was published. Rename is atomic per file, not across the pair.
 */

import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'

import { fsyncDirectory, writeExclusive } from '@/lib/ops/published-report'
import { renderGateMarkdown, type GateReport } from '@/lib/ops/readiness-gate'

export const GATE_REPORT_JSON = 'readiness-gate.json'
export const GATE_REPORT_MARKDOWN = 'readiness-gate.md'

export type PublishResult =
  | { ok: true; json: string; markdown: string; record: GateReport & { companionMarkdownSha256: string }; markdownText: string }
  | { ok: false; error: string; markdownText: string }

export type PublishHooks = {
  /** A seam for tests: write one file. Defaults to writeExclusive. */
  writeFile?: (file: string, data: string) => void
}

export function publishGateReport(report: GateReport, reportDir: string, hooks: PublishHooks = {}): PublishResult {
  const markdownText = renderGateMarkdown(report)
  const outDir = path.join(reportDir, report.runId)
  const json = path.join(outDir, GATE_REPORT_JSON)
  const markdown = path.join(outDir, GATE_REPORT_MARKDOWN)
  const write = hooks.writeFile ?? writeExclusive
  const suffix = randomBytes(6).toString('hex')
  const tmpJson = path.join(outDir, `.${GATE_REPORT_JSON}.${suffix}.tmp`)
  const tmpMarkdown = path.join(outDir, `.${GATE_REPORT_MARKDOWN}.${suffix}.tmp`)
  const created: string[] = []
  let outDirCreated = false
  try {
    mkdirSync(outDir, { mode: 0o700 }) // not recursive: EEXIST is a refusal
    outDirCreated = true
    const id = lstatSync(outDir)
    if (id.isSymbolicLink() || !id.isDirectory()) throw new Error(`${outDir} is not a directory`)
    const record = { ...report, companionMarkdownSha256: createHash('sha256').update(markdownText).digest('hex') }
    created.push(tmpMarkdown)
    write(tmpMarkdown, markdownText)
    created.push(tmpJson)
    write(tmpJson, `${JSON.stringify(record, null, 2)}\n`)
    created.push(markdown)
    renameSync(tmpMarkdown, markdown)
    created.push(json)
    renameSync(tmpJson, json)
    fsyncDirectory(outDir)
    return { ok: true, json, markdown, record, markdownText }
  } catch (error) {
    // Remove only what THIS run created, so a failed publication leaves no JSON that could be mistaken for a report.
    for (const file of created.splice(0)) rmSync(file, { force: true })
    if (outDirCreated) {
      try { rmSync(outDir, { recursive: false, force: true }) } catch { /* not empty or already gone: leave it */ }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error), markdownText }
  }
}
