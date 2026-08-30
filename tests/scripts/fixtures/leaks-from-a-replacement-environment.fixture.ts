/**
 * A HARNESS WHOSE *CHILD* LEAKS, UNDER AN ENVIRONMENT THAT NEVER MENTIONED /tmp (o3d-tmpleak).
 *
 * The sibling fixture leaks in the test process itself, where `process.env.TMPDIR` — which the
 * sentinel sets on import — is what redirects the directory into the private root. This one leaks
 * one step further out, in a grandchild launched with a REPLACEMENT environment: `{ PATH }` and
 * nothing else, which is how these harnesses run shell wrappers and probes. Such a child inherits
 * no TMPDIR at all, so before the sentinel redirected the environment where it is ASSEMBLED, this
 * directory landed in the SYSTEM /tmp — outside anything the sentinel could see, report, or
 * remove. That is the escape path this fixture exists to keep closed.
 *
 * The path the grandchild made is printed so the guard can assert it is GONE afterwards, which is
 * the half an exit code cannot fake.
 *
 * Not named `*.test.ts`, so `npm run test:unit`'s glob does not pick it up and fail every run.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

/** The prefix the guard greps the sentinel's report for. */
export const LEAKED_PREFIX = 'ims-fixture-envleak-'

/** Where the grandchild announces what it abandoned, so the guard can look for it by name. */
export const ANNOUNCEMENT = 'ENVLEAK_AT='

const PROGRAM = [
  "const { mkdtempSync } = require('node:fs')",
  "const { tmpdir } = require('node:os')",
  "const { join } = require('node:path')",
  `process.stdout.write('${ANNOUNCEMENT}' + mkdtempSync(join(tmpdir(), '${LEAKED_PREFIX}')) + '\\n')`,
].join('; ')

test('the assertion itself passes; only the grandchild\'s directory is wrong', () => {
  // A REPLACEMENT ENVIRONMENT, not a modified copy of ours: no TMPDIR reaches this child except
  // through the sentinel. `process.execPath` is used rather than a PATH lookup so that the empty
  // environment cannot make this fail for an unrelated reason.
  const child = spawnSync(process.execPath, ['-e', PROGRAM], {
    encoding: 'utf8',
    // The repo's ProcessEnv augmentation makes NODE_ENV required, which a REPLACEMENT environment
    // by definition does not have; the cast is the same one the deploy-order harnesses use.
    env: { PATH: '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv,
  })

  assert.equal(child.status, 0, `the grandchild must run: ${child.stderr}`)
  assert.ok(child.stdout.includes(LEAKED_PREFIX), `and make its directory: ${child.stdout}`)
  process.stdout.write(child.stdout)
  // And no removal. This is the defect it exists to reproduce.
})
