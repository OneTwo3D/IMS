/**
 * npm 11 (bundled with Node 26) runs a dependency's install script only when package.json's
 * `allowScripts` covers it. An uncovered @prisma/engines or esbuild means a host with no schema
 * engine, found at the migration. This pins the allowlist, requires every install-script package in
 * the lockfile to be covered one way or the other, and requires every npm install path IMS ships to
 * carry that policy or to check its result.
 *
 * Mutations that turn it red: drop `prisma` or `@prisma/engines` from allowScripts; add a
 * dependency with an install script without deciding it; delete the allowScripts line from the
 * Dockerfile migrate-deps stage; delete the schema-engine check from install.sh or update.sh.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { shippedFunction } from './real-postgres-cluster.ts'

const REPO = process.cwd()
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const pkg = JSON.parse(read('package.json')) as { allowScripts?: Record<string, boolean> }
const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { hasInstallScript?: boolean }> }

const ALLOWED = ['@prisma/engines', 'esbuild', 'prisma', 'ssh2', 'unrs-resolver']
const DENIED = ['cpu-features', 'fsevents', 'msw']

test('allowScripts allows exactly the packages IMS needs and denies the optional ones', () => {
  const policy = pkg.allowScripts ?? {}
  assert.deepEqual(Object.keys(policy).filter((k) => policy[k] === true).sort(), [...ALLOWED].sort())
  assert.deepEqual(Object.keys(policy).filter((k) => policy[k] === false).sort(), [...DENIED].sort())
  assert.deepEqual(Object.keys(policy).sort(), [...ALLOWED, ...DENIED].sort(), 'only booleans, only these names')
})

test('every lockfile package with an install script is decided in allowScripts', () => {
  const policy = pkg.allowScripts ?? {}
  const names = new Set<string>()
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (entry.hasInstallScript) names.add(path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length))
  }
  const undecided = [...names].filter((n) => !(n in policy)).sort()
  assert.deepEqual(undecided, [], `decide these in package.json allowScripts (npm install-scripts approve|deny): ${undecided.join(', ')}`)
  assert.ok(names.has('prisma') && names.has('@prisma/engines'), 'the lockfile still shows the Prisma install scripts')
})

test('the Dockerfile migrate-deps stage, whose package.json is generated, carries the Prisma allowlist', () => {
  const docker = read('Dockerfile')
  const stage = docker.slice(docker.indexOf('FROM base AS migrate-deps'), docker.indexOf('FROM base AS migrate\n'))
  assert.match(stage, /npm pkg set --json allowScripts='\{[^']*"prisma":true[^']*"@prisma\/engines":true[^']*\}'/)
  assert.ok(stage.indexOf('allowScripts') < stage.indexOf('npm install'), 'the policy is written before the install')
  // The `deps` stage installs from the repo's own package.json, so the policy travels with it.
  assert.match(docker, /COPY package\.json package-lock\.json \.npmrc \.\/\nRUN [^\n]*npm ci/)
})

test('install.sh and update.sh stop when npm ci left no Prisma schema engine, and install.sh keeps the npm warning', () => {
  for (const file of ['scripts/install.sh', 'scripts/update.sh']) {
    const text = read(file)
    assert.match(text, /compgen -G "\$\{APP_DIR\}\/node_modules\/@prisma\/engines\/schema-engine-\*"/, file)
  }
  const install = read('scripts/install.sh')
  const ci = install.slice(install.indexOf('npm ci --include=dev --prefix "${APP_DIR}" 2>&1'))
  const filter = ci.slice(0, ci.indexOf('\n', ci.indexOf('grep ')))
  assert.doesNotMatch(filter, /grep -v "\^npm warn"/, 'the blanket filter hid the install-scripts report')
  assert.match(filter, /grep -Ev "\^npm warn \(deprecated\|/, 'only named noise is filtered')
  assert.doesNotMatch(filter, /install-scripts/, 'install-scripts warnings are not filtered')
})

test('every GitHub workflow that runs npm ci does so on Node 26 in a tree whose package.json carries allowScripts', () => {
  for (const f of readdirSync(join(REPO, '.github/workflows'))) {
    const text = read(`.github/workflows/${f}`)
    if (!/run: npm ci/.test(text)) continue
    assert.match(text, /node-version: 26/, f)
  }
  assert.ok(pkg.allowScripts, 'workflows read package.json allowScripts from the checkout')
})

// ---- o3d-rb9l4: the installer creates the database as UTF8 ----

test('install.sh creates the IMS database ENCODING UTF8 from template0 with an explicit locale', () => {
  const install = read('scripts/install.sh')
  assert.match(install, /CREATE DATABASE :"dbname" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE :'lc_collate' LC_CTYPE :'lc_ctype';/)
  assert.doesNotMatch(install, /CREATE DATABASE :"dbname";/, 'a bare CREATE DATABASE inherits template1 (SQL_ASCII on stage)')
})

function localeFor(row: string): { out: string; rc: number } {
  const script = [
    `pg_local_psql() { printf '%s\\n' ${JSON.stringify(row)}; }`,
    shippedFunction(read('scripts/install.sh'), 'database_create_locale'),
    'c=; t=; database_create_locale c t; echo "$c/$t"',
  ].join('\n')
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  return { out: r.stdout.trim(), rc: r.status ?? -1 }
}

test('the locale follows template1 when it fits UTF8 and falls back to C.UTF-8 when it does not', () => {
  assert.equal(localeFor('C|C').out, 'C/C')
  assert.equal(localeFor('en_GB.UTF-8|en_GB.UTF-8').out, 'en_GB.UTF-8/en_GB.UTF-8')
  assert.equal(localeFor('en_GB.utf8|en_GB.utf8').out, 'en_GB.utf8/en_GB.utf8')
  assert.equal(localeFor('en_GB.ISO-8859-1|en_GB.ISO-8859-1').out, 'C.UTF-8/C.UTF-8')
  assert.equal(localeFor('de_DE|C').out, 'C.UTF-8/C')
  assert.equal(localeFor('').out, 'C.UTF-8/C.UTF-8', 'an unreadable template1 gives C.UTF-8, and the CREATE reports the real problem')
})

test('update.sh warns (never refuses) on a non-UTF8 database, before the build', () => {
  const update = read('scripts/update.sh')
  const at = update.indexOf('scripts/db-encoding-check.mjs" 2>&1')
  assert.ok(at > 0 && at < update.indexOf('header "Building the application"'))
  const block = update.slice(at, update.indexOf('header "Building the application"'))
  assert.match(block, /NOT_UTF8\\ \*\) warn "THE DATABASE IS ENCODED/)
  assert.doesNotMatch(block.slice(block.indexOf('case ')), /\bdie\b/, 'the verdict itself is never fatal')
})
