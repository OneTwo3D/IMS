#!/usr/bin/env tsx
/**
 * THE REHEARSAL'S OWN ENTRYPOINT. Not a command an operator runs: `scripts/lib/first-load-rehearse.ts` starts it on the throwaway copy it made. It is a separate file so that the public
 * command (scripts/first-load-apply.ts) has no way to reach child mode at all: the child flags are unknown arguments there. Even here, the process is the rehearsal only if it presents
 * the single-use token whose hash the parent recorded in the throwaway cluster's directory, on the cluster the parent recorded, which is not the real target (docs/first-load-apply.md,
 * "The rehearsal"). Anything else is refused with REHEARSAL_CHILD_UNAUTHENTICATED and nothing is relaxed.
 */
import process from 'node:process'
import { runCli } from './first-load-apply'

runCli(process.argv.slice(2), { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }, process.env, { child: true }).then(
  (code) => { process.stderr.write('', () => process.stdout.write('', () => process.exit(code))) },
  (error: unknown) => {
    process.stderr.write(`first-load-apply: internal error: ${error instanceof Error ? error.name : 'Error'}\n`)
    process.exit(6)
  },
)
