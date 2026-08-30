/**
 * A HARNESS WHOSE LEFTOVERS ARE BEING REWRITTEN WHILE THE SENTINEL REPAIRS THEM (o3d-tmpleak).
 *
 * The repair walk used to read `if (entry.isDirectory()) chmodSync(join(path, entry.name), 0o700)`.
 * The comment above it said the walk never follows a symlink, and that was true of the CHECK and
 * false of the OPERATION: `readdirSync` snapshots every name and type in one call, and the chmods
 * that follow are separate lookups made one at a time afterwards. Anything able to write in the
 * directory in between — a child of a harness that is still shutting down, another test process,
 * and this root is deliberately 1777 — could replace a reported directory with a symlink, and the
 * chmod then followed it and set an unrelated target to 0700, as whatever uid runs the tests.
 *
 * SO THE RACE IS BUILT RATHER THAN ARGUED ABOUT. This fixture abandons a directory the sentinel
 * cannot remove without repairing it first (a 0-mode child, which is what forces the repair to run
 * at all), fills it with directories, and leaves a detached process flipping each of those names
 * between a real directory and a symlink pointing at a VICTIM directory outside the private root.
 * The victim's mode is the measurement: `IMS_SWAP_VICTIM` is created 0755 by the guard, and if any
 * pathname chmod in the repair follows one of those links it becomes 0700.
 *
 * The window is real but it is a window, so the guard states what it measured rather than claiming
 * the race is deterministic — see the test that drives this.
 *
 * Only meaningful as a non-root uid: root removes a 0-mode tree without repairing anything, so the
 * repair never runs and there is nothing to race.
 *
 * Not named `*.test.ts`, so `npm run test:unit`'s glob does not pick it up and fail every run.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** The prefix the guard greps the sentinel's report for. */
export const LEAKED_PREFIX = 'ims-fixture-swap-'

/** Where the fixture announces the tree it abandoned. */
export const ANNOUNCEMENT = 'SWAP_AT='

/** How many names the swapper cycles. More names is a wider window, not a different mechanism. */
const TARGETS = 64

/**
 * Rename the directory aside, put a symlink in its place, take the symlink away, put the directory
 * back — as fast as the filesystem allows, for as long as the deadline lasts. Each name therefore
 * spends a large fraction of the run as a symlink, and the repair's chmods arrive whenever they
 * arrive. Every operation is guarded: once the sentinel has removed the tree these all fail with
 * ENOENT, and the loop stops rather than resurrecting anything it has just removed.
 */
const SWAPPER = [
  "const { existsSync, renameSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs')",
  "const dir = process.env.IMS_SWAP_DIR, victim = process.env.IMS_SWAP_VICTIM",
  "const deadline = Date.now() + Number(process.env.IMS_SWAP_MS)",
  "const names = []",
  `for (let i = 0; i < ${TARGETS}; i += 1) names.push(dir + '/d' + String(i).padStart(3, '0'))`,
  "while (Date.now() < deadline && existsSync(dir)) {",
  "  for (const name of names) {",
  "    try { renameSync(name, name + '.held'); symlinkSync(victim, name) } catch { continue }",
  "    try { unlinkSync(name); renameSync(name + '.held', name) } catch { /* removed under us */ }",
  "  }",
  "}",
  "writeFileSync(process.env.IMS_SWAP_DONE, 'done')",
].join('\n')

test('the assertion itself passes; only the abandoned tree is being rewritten', () => {
  const victim = process.env.IMS_SWAP_VICTIM
  const done = process.env.IMS_SWAP_DONE
  assert.ok(victim !== undefined && done !== undefined, 'the guard must supply a victim and a marker')

  const abandoned = mkdtempSync(join(tmpdir(), LEAKED_PREFIX))
  // THE REASON THE REPAIR RUNS AT ALL: `rmSync` cannot recurse into this, so the sentinel's first
  // removal fails and the repair walk — the thing under measurement — is what it does next.
  mkdirSync(join(abandoned, 'blocked', 'inner'), { recursive: true })
  writeFileSync(join(abandoned, 'blocked', 'inner', 'held'), 'x')
  chmodSync(join(abandoned, 'blocked'), 0o000)
  for (let index = 0; index < TARGETS; index += 1) {
    mkdirSync(join(abandoned, `d${String(index).padStart(3, '0')}`))
  }
  process.stdout.write(`${ANNOUNCEMENT}${abandoned}\n`)

  const swapper = spawn(process.execPath, ['-e', SWAPPER], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, IMS_SWAP_DIR: abandoned, IMS_SWAP_MS: '4000' },
  })
  swapper.unref()

  // And no removal, and no mode restored. This is the defect it exists to reproduce.
})
