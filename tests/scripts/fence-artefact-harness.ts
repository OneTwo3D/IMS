/**
 * THE FAKE APPLICATION CHECKOUT THE PROTECTED-ARTEFACT TESTS RUN AGAINST (o3d-2sm1.5 r32).
 *
 * scripts/lib/db-fence-protected.sh no longer publishes one file into the root-owned mirror and
 * symlinks `node_modules` back into the application checkout. It VENDORS the fence helper's
 * resolved dependency closure, which means every harness that lets a fence run for real now needs
 * a checkout with the shipped LAYOUT — `<app>/scripts/fence-db-connections.mjs` beside
 * `<app>/node_modules/` — because that is what node's resolver walks and what the library copies.
 *
 * It is one module rather than a copy in each test file on purpose: the previous three rounds of
 * findings were all "one rule, several readers", and a harness that describes the artefact layout
 * is a reader of that rule.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTempDirSync } from './temp-dir.ts'

/** Where the fake checkout's helper lives, relative to a scratch root. */
export function checkoutHelper(root: string): string {
  return join(root, 'app', 'scripts', 'fence-db-connections.mjs')
}

/** The file inside the fake `pg` that a substitution test replaces. */
export function checkoutPgEntry(root: string): string {
  return join(root, 'app', 'node_modules', 'pg', 'lib', 'index.js')
}

/**
 * A `pg` that is a real resolvable package and nothing more. `body` is the module body: the
 * shipped one is inert, and a substitution test passes one that writes the credential out.
 */
export function pgPackage(body: string): { manifest: string; entry: string } {
  return {
    manifest: JSON.stringify({ name: 'pg', version: '0.0.0', main: './lib/index.js', dependencies: { 'pg-protocol': '*' } }),
    entry: body,
  }
}

/**
 * Lay out `<root>/app` as a checkout: the helper at the shipped path, and a `pg` with one
 * transitive dependency so the closure walk has something to recurse through — a one-package
 * closure would pass a resolver that never recursed.
 */
export function writeFenceCheckout(
  root: string,
  helperSource: string,
  pgBody = SHIPPED_PG_BODY,
): string {
  const app = join(root, 'app')
  mkdirSync(join(app, 'scripts'), { recursive: true })
  writeFileSync(checkoutHelper(root), helperSource)
  writeCheckoutPg(app, pgBody)
  return checkoutHelper(root)
}

export const SHIPPED_PG_BODY = "module.exports = { Client: class {}, FLAVOUR: 'SHIPPED-PG' }\n"

/**
 * TAKE GROUP AND OTHER WRITE OFF A FAKE CHECKOUT (r33).
 *
 * Since r33 the library refuses to publish an artefact whose dependency closure was assembled
 * from a source that anybody but the publishing account can write. Left to the harness's ambient
 * umask, whether a test exercised the TRUSTED or the UNTRUSTED path would be a property of the
 * machine rather than of the test — so it is stated here, and the tests that want the untrusted
 * path put a mode back deliberately and assert on the message that names it.
 */

/**
 * Put the fake `pg` into an application directory that already exists. Split out of
 * writeFenceCheckout() because several harnesses build their own `<app>/scripts` first and only
 * need the dependency half — and because every one of them needs it: publishing the protected
 * artefact VENDORS this closure, and a checkout with nothing to vendor cannot be published from.
 */
export function sealCheckoutModes(appDir: string): void {
  execFileSync('chmod', ['-R', 'go-w', appDir])
}

export function writeCheckoutPg(appDir: string, pgBody: string = SHIPPED_PG_BODY): void {
  mkdirSync(join(appDir, 'node_modules', 'pg', 'lib'), { recursive: true })
  mkdirSync(join(appDir, 'node_modules', 'pg-protocol'), { recursive: true })
  const pg = pgPackage(pgBody)
  writeFileSync(join(appDir, 'node_modules', 'pg', 'package.json'), `${pg.manifest}\n`)
  writeFileSync(join(appDir, 'node_modules', 'pg', 'lib', 'index.js'), `require('pg-protocol')\n${pg.entry}`)
  writeFileSync(
    join(appDir, 'node_modules', 'pg-protocol', 'package.json'),
    `${JSON.stringify({ name: 'pg-protocol', version: '0.0.0', main: 'index.js' })}\n`,
  )
  writeFileSync(join(appDir, 'node_modules', 'pg-protocol', 'index.js'), 'module.exports = {}\n')
  sealCheckoutModes(appDir)
}

/**
 * THE SHIPPED LIBRARY, POINTED AT A SCRATCH DIRECTORY WITHOUT DISARMING IT (o3d-secops r2).
 *
 * These harnesses used to `source scripts/lib/db-fence-protected.sh` and then REASSIGN its ten
 * /etc paths, after the source, so the harness's values won. Since those declarations are
 * `readonly` — which is the whole point of this round; they name the recovery root, the protected
 * tree and the file root EXECUTES — bash now refuses those assignments, and the previous round
 * cited exactly that as the reason not to protect them.
 *
 * IT IS NOT A REASON, IT IS A HARNESS THAT SUBSTITUTES IN THE WRONG PLACE. What a harness needs is
 * for the library's TRUST ROOT to be somewhere a test can write; it never needed the protection
 * off. So the ONE literal is substituted in the shipped TEXT before it is sourced, `readonly` and
 * all, and the nine paths composed from it are composed BY THE LIBRARY exactly as they ship.
 *
 * That is strictly stronger than what it replaces, in two ways worth stating:
 *
 *   * the old override block RESTATED the composition — `<recovery>/app/scripts/…` written out in
 *     TypeScript — so a harness could keep passing while the library composed something else. It
 *     was a second reader of the rule, the defect this library exists to prevent, in the tests.
 *   * every path that is NOT the recovery root is now exercised as the library computes it, and
 *     the `readonly` under test is the one the shipped file carries.
 *
 * The substitution is REQUIRED to match exactly one line and to be the protected declaration, so a
 * rename that made this a no-op fails here instead of silently letting a test run against /etc.
 */
const LIBRARY_RELATIVE_PATH = 'scripts/lib/db-fence-protected.sh'

/** The declaration the substitution replaces — the protected form, `readonly` included. */
const RECOVERY_ROOT_DECLARATION = /^readonly DB_FENCE_RECOVERY_DIR="\/etc\/[^"$]*"$/

/** A path as one bash word, proof against `$`, spaces and the rest. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** The shipped library text with its trust root pointed at `recovery`, and nothing else changed. */
export function protectedLibraryTextAt(recovery: string): string {
  const source = readFileSync(join(process.cwd(), LIBRARY_RELATIVE_PATH), 'utf8')
  const lines = source.split('\n')
  const at = lines.reduce<number[]>((found, line, index) => {
    if (RECOVERY_ROOT_DECLARATION.test(line)) found.push(index)
    return found
  }, [])
  if (at.length !== 1) {
    throw new Error(
      `${LIBRARY_RELATIVE_PATH}: the harness must find exactly one \`readonly DB_FENCE_RECOVERY_DIR="/etc/…"\` `
      + `declaration to point at a scratch directory; it found ${at.length}. Until this is fixed every fence `
      + 'harness would either run against /etc or run against a library it did not redirect.',
    )
  }
  lines[at[0]] = `readonly DB_FENCE_RECOVERY_DIR=${shellSingleQuote(recovery)}`
  return lines.join('\n')
}

/**
 * The same as a `source` line — the redirected text is written to a throwaway file and sourced
 * from it, and this REPLACES the `source` of the shipped path these harnesses used to carry.
 *
 * WHY A FILE AND NOT THE TEXT ITSELF. Splicing 94KB of library into the program string was the
 * obvious form and it does not work: `runShell` hands the whole program to `bash -c` as ONE
 * argument, and Linux caps a single argv entry at MAX_ARG_STRLEN (128KB). The library alone is
 * 94KB, so the harnesses that also lift entrypoint functions — fenceRecoveryHarness is 10 of them
 * — went over the cap and `execFileSync` failed with E2BIG before bash ran at all: no status, no
 * output, ten tests failing with an empty diagnostic. Measured, not guessed: 130,000 bytes runs
 * and 200,000 does not.
 *
 * The directory comes from createTempDirSync(), so its removal is registered at the moment it is
 * created and tests/temp-dir-sentinel.ts stays green. One directory per process, one file per
 * redirected root.
 */
let redirectedLibraryDir: string | undefined
let redirectedLibraryCount = 0

export function protectedLibraryLinesAt(recovery: string): string[] {
  redirectedLibraryDir ??= createTempDirSync('ims-fence-library-')
  redirectedLibraryCount += 1
  const file = join(redirectedLibraryDir, `db-fence-protected.${redirectedLibraryCount}.sh`)
  writeFileSync(file, protectedLibraryTextAt(recovery))
  return [`source ${JSON.stringify(file)}`]
}

/** For harnesses whose recovery directory is `<root>/recovery`. */
export function protectedLibraryLines(root: string): string[] {
  return protectedLibraryLinesAt(join(root, 'recovery'))
}

/** Where the published artefact and its record end up, for assertions. */
export function protectedPaths(root: string): {
  recovery: string
  app: string
  helper: string
  pgEntry: string
  artefactFile: string
  manifestFile: string
  releaseWrapper: string
  refenceWrapper: string
} {
  const recovery = join(root, 'recovery')
  return {
    recovery,
    app: join(recovery, 'app'),
    helper: join(recovery, 'app', 'scripts', 'fence-db-connections.mjs'),
    pgEntry: join(recovery, 'app', 'node_modules', 'pg', 'lib', 'index.js'),
    artefactFile: join(recovery, 'db-fence-artefact.sha256'),
    manifestFile: join(recovery, 'db-fence-artefact.manifest'),
    releaseWrapper: join(recovery, 'release-db-fence'),
    refenceWrapper: join(recovery, 'refence-db'),
  }
}
