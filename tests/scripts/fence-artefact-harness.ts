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
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
 * Put the fake `pg` into an application directory that already exists. Split out of
 * writeFenceCheckout() because several harnesses build their own `<app>/scripts` first and only
 * need the dependency half — and because every one of them needs it: publishing the protected
 * artefact VENDORS this closure, and a checkout with nothing to vendor cannot be published from.
 */
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
}

/**
 * The shell assignments that point the library's /etc literals at a scratch directory. They go
 * AFTER the `source`, so they win over the library's own; everything else about it runs unchanged,
 * including the vendoring, the seal check and the artefact digest.
 */
export function protectedLibraryLines(root: string): string[] {
  return protectedLibraryLinesAt(join(root, 'recovery'))
}

/** The same, for harnesses whose recovery directory is not `<root>/recovery`. */
export function protectedLibraryLinesAt(recovery: string): string[] {
  return [
    `DB_FENCE_RECOVERY_DIR=${JSON.stringify(recovery)}`,
    `DB_FENCE_IDENTITY_FILE=${JSON.stringify(join(recovery, 'db-fence-identity.env'))}`,
    `DB_FENCE_PROTECTED_APP_DIR=${JSON.stringify(join(recovery, 'app'))}`,
    `DB_FENCE_SCRIPT_COPY=${JSON.stringify(join(recovery, 'app', 'scripts', 'fence-db-connections.mjs'))}`,
    `DB_FENCE_STAGED_APP_DIR=${JSON.stringify(join(recovery, '.app.staged'))}`,
    `DB_FENCE_RETIRED_APP_DIR=${JSON.stringify(join(recovery, '.app.retired'))}`,
    `DB_FENCE_ARTEFACT_FILE=${JSON.stringify(join(recovery, 'db-fence-artefact.sha256'))}`,
    `DB_FENCE_MANIFEST_FILE=${JSON.stringify(join(recovery, 'db-fence-artefact.manifest'))}`,
    `DB_FENCE_RELEASE_WRAPPER=${JSON.stringify(join(recovery, 'release-db-fence'))}`,
    `DB_FENCE_REFENCE_WRAPPER=${JSON.stringify(join(recovery, 'refence-db'))}`,
  ]
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
