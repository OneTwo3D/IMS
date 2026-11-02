import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { checkAncestors } from './published-report'

/**
 * TEST-ONLY opt-in that lets the rehearsal commands' own tests keep their throwaway clusters on a RAM-backed scratch disk.
 *
 * A real rehearsal refuses a RAM-backed parent, because a cluster held in RAM is not a faithful rehearsal of a disk-backed install.
 * That refusal stays exactly as it is. The tests of the rehearsal commands are not rehearsals of anything: they only need a place
 * that is cheap to write, so (and only so) a test run may name one parent directory here and the RAM refusal is waived for runs
 * that sit inside it.
 *
 * Production never sets this variable and no production entry point forwards it (the rehearsal's children get a fixed
 * allow-list of variables, the deploy files do not mention it, and tests/ops/rehearsal-test-scratch.test.ts greps for it).
 *
 * The named directory is accepted only if ALL of these hold; anything else is refused with the reason:
 *   - IMS_SCRATCH_ROOT is set and names a directory, and the named directory is that directory or lies inside it;
 *   - it is a real directory (not a symlink), owned by root, with the sticky bit (like /var/tmp and /tmp);
 *   - every ancestor passes the same trust rules the rehearsal applies to its own --root;
 *   - the rehearsal's --root is that directory or lies inside it.
 */
export const TEST_SCRATCH_PARENT_ENV = 'IMS_REHEARSAL_TEST_SCRATCH_PARENT'
const SCRATCH_ROOT_ENV = 'IMS_SCRATCH_ROOT'
const STICKY = 0o1000

export type TestScratchOptIn =
  | { requested: false }
  | { requested: true; accepted: true }
  | { requested: true; accepted: false; reason: string }

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Whether the opt-in lets a RAM-backed `parentDir` through. `requested: false` means the variable is unset or empty: the production refusal applies untouched. */
export function testScratchParentOptIn(parentDir: string, env: Readonly<Record<string, string | undefined>> = process.env): TestScratchOptIn {
  const named = env[TEST_SCRATCH_PARENT_ENV]
  if (named === undefined || named === '') return { requested: false }
  const refuse = (reason: string): TestScratchOptIn => ({ requested: true, accepted: false, reason: `${TEST_SCRATCH_PARENT_ENV} is refused: ${reason}` })

  if (!path.isAbsolute(named)) return refuse('it is not an absolute path')
  let optedReal: string
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(named)
    optedReal = realpathSync(named)
  } catch {
    return refuse(`${named} cannot be inspected`)
  }
  if (info.isSymbolicLink()) return refuse(`${named} is a symlink`)
  if (!info.isDirectory()) return refuse(`${named} is not a directory`)
  if (info.uid !== 0) return refuse(`${named} is owned by uid ${info.uid}, not root`)
  if ((info.mode & STICKY) === 0) return refuse(`${named} is not sticky (mode ${(info.mode & 0o7777).toString(8)})`)

  const configured = env[SCRATCH_ROOT_ENV]
  if (configured === undefined || configured === '') return refuse(`${SCRATCH_ROOT_ENV} is not set`)
  let rootReal: string
  try {
    rootReal = realpathSync(configured)
  } catch {
    return refuse(`${SCRATCH_ROOT_ENV} ${configured} cannot be inspected`)
  }
  if (!within(optedReal, rootReal)) return refuse(`${named} is not inside ${SCRATCH_ROOT_ENV} (${rootReal})`)

  const ancestors = checkAncestors(optedReal, TEST_SCRATCH_PARENT_ENV)
  if (ancestors !== null) return refuse(ancestors)

  let parentReal: string
  try {
    parentReal = realpathSync(parentDir)
  } catch {
    return refuse(`the rehearsal --root ${parentDir} cannot be inspected`)
  }
  if (!within(parentReal, optedReal)) return refuse(`the rehearsal --root ${parentDir} is not inside ${named}`)
  return { requested: true, accepted: true }
}
