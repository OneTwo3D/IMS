/**
 * A HARNESS WHOSE CHILD IS HANDED A TMPDIR POINTING SOMEWHERE ELSE (o3d-tmpleak).
 *
 * The sibling fixture launches a child with `{ PATH }` and nothing else — no TMPDIR at all. This
 * one launches a child with `{ PATH, TMPDIR: '/tmp' }`, which the sentinel used to wave through:
 * the exemption asked only whether a TMPDIR was SET, not whether it pointed anywhere the sentinel
 * could see. An explicit `/tmp` therefore bought a child a documented, supported route straight
 * out of the private root — the exact escape the redirect exists to close, written down in the
 * child's own environment.
 *
 * WHAT THE EXEMPTION IS ACTUALLY FOR is the second child below. `fence-digest-and-first-install`
 * points its children at `<scratch>/tmp` and then asserts that nothing under `<scratch>` changed;
 * overriding that would break the assertion that made the choice. Because that scratch root is
 * itself made with `mkdtemp(tmpdir())` it is already INSIDE the private root, so containment — not
 * presence — is what tells the two cases apart. Both are measured here, in one process: the
 * external value must be replaced, and the contained value must survive untouched.
 *
 * Not named `*.test.ts`, so `npm run test:unit`'s glob does not pick it up and fail every run.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** The prefix the guard greps the sentinel's report for. */
export const LEAKED_PREFIX = 'ims-fixture-outside-'

/** Where the escaping child announces what it made. */
export const ESCAPED = 'OUTSIDE_AT='

/** What the contained child was ASKED for, and what it actually resolved. */
export const ASKED = 'CONTAINED_ASKED='
export const RESOLVED = 'CONTAINED_RESOLVED='

const MAKE = [
  "const { mkdtempSync } = require('node:fs')",
  "const { tmpdir } = require('node:os')",
  "const { join } = require('node:path')",
  `process.stdout.write('${ESCAPED}' + mkdtempSync(join(tmpdir(), '${LEAKED_PREFIX}')) + '\\n')`,
].join('; ')

const REPORT = [
  "const { tmpdir } = require('node:os')",
  `process.stdout.write('${RESOLVED}' + tmpdir() + '\\n')`,
].join('; ')

/** The repo's ProcessEnv augmentation makes NODE_ENV required; a REPLACEMENT environment has none. */
const replacement = (extra: Record<string, string>): NodeJS.ProcessEnv =>
  ({ PATH: '/usr/bin:/bin', ...extra }) as unknown as NodeJS.ProcessEnv

test("the assertion itself passes; only the child's directory is wrong", () => {
  // AN EXTERNAL TMPDIR, spelled out. Nothing about this child is unusual — it is the replacement
  // environment these harnesses build constantly, with one more variable in it.
  const escaping = spawnSync(process.execPath, ['-e', MAKE], {
    encoding: 'utf8',
    env: replacement({ TMPDIR: '/tmp' }),
  })
  assert.equal(escaping.status, 0, `the child must run: ${escaping.stderr}`)
  assert.ok(escaping.stdout.includes(LEAKED_PREFIX), `and make its directory: ${escaping.stdout}`)
  process.stdout.write(escaping.stdout)

  // AND THE CONTAINED CASE, which must NOT be rewritten. This is the shape the one deliberate
  // TMPDIR in this tree has: a directory the harness made inside its own scratch root, which is
  // inside the private root because the scratch root came from `tmpdir()`.
  const scratch = mkdtempSync(join(tmpdir(), 'ims-fixture-scratch-'))
  try {
    process.stdout.write(`${ASKED}${scratch}\n`)
    const contained = spawnSync(process.execPath, ['-e', REPORT], {
      encoding: 'utf8',
      env: replacement({ TMPDIR: scratch }),
    })
    assert.equal(contained.status, 0, `the second child must run: ${contained.stderr}`)
    process.stdout.write(contained.stdout)
  } finally {
    // The fixture's OWN scratch is cleaned up, so the only thing left for the sentinel to find is
    // the escape above and the report's count stays exactly one.
    rmSync(scratch, { recursive: true, force: true })
  }
})
