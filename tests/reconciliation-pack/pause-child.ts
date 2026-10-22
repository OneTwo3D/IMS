// A child process that publishes and PAUSES between "evidence and Markdown in place" and the commit, until a go file appears.
import { existsSync } from 'node:fs'

import { publishSyntheticRun } from '../../lib/reconciliation-pack/harness.ts'

const [reportDir, goFile] = [process.argv[2]!, process.argv[3]!]
const result = publishSyntheticRun({
  reportDir, phase: 'P1', asOf: '2026-10-19', now: new Date(),
  hooks: { beforeCommit: () => { console.log('paused'); while (!existsSync(goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20) } },
})
console.log(JSON.stringify({ ok: result.ok, code: result.ok ? null : result.code }))
process.exit(result.ok ? 0 : 1)
