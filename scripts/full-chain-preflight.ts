/**
 * Report whether the full-chain rig is fit to run, without running it.
 *
 * A FILE, not the `node -e "import(...)"` one-liner this replaces. That one-liner never
 * worked: tsx transpiles the harness to CJS, so a dynamic import() hands back
 * `{ default: exports }` and `m.preflight` is undefined — every invocation died with
 * "m.preflight is not a function" instead of reporting anything. A check nobody can run is
 * not a check, and a shell string inside JSON is not a place to notice that.
 *
 * Usage:
 *   NODE_OPTIONS='--import tsx' node --env-file=.env scripts/full-chain-preflight.ts
 */
import { preflight } from '@/e2e/full-chain/harness/preflight'

async function main() {
  const r = await preflight()

  // Warnings are checks that could not RUN, not checks that passed. Print them either way.
  for (const w of r.warnings) console.warn(`PREFLIGHT WARNING: ${w}`)

  if (r.ok) {
    console.log('PREFLIGHT: OK')
    return
  }
  console.error(`PREFLIGHT: BLOCKED\n  - ${r.problems.join('\n  - ')}`)
  process.exitCode = 1
}

main().catch((e) => {
  console.error(`PREFLIGHT: ERRORED — ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
