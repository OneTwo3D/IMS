// A child process for the concurrency test: publish N reports, retrying while the run lock is held.
import { publishSyntheticRun } from '../../lib/reconciliation-pack/harness.ts'

const [reportDir, count] = [process.argv[2]!, Number(process.argv[3])]
let published = 0
let refusals = 0
for (let i = 0; i < count; i += 1) {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    const result = publishSyntheticRun({ reportDir, phase: 'P1', asOf: '2026-10-19', now: new Date(Date.now()) })
    if (result.ok) { published += 1; break }
    if (result.code !== 'LOCK_HELD' && result.code !== 'LOCK_STALE_CONTENDED') { console.log(JSON.stringify({ error: result.code })); process.exit(1) }
    refusals += 1
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
  }
}
console.log(JSON.stringify({ published, refusals }))
process.exit(published === count ? 0 : 1)
