/**
 * update.sh and deploy.sh refuse to deploy onto a Node major below package.json engines.node,
 * before anything is stopped, built or migrated. Nothing here runs the entrypoints: the shipped
 * node_engine_preflight() is lifted into a bash of its own and driven with real package.json files,
 * and the call sites are checked statically for position.
 *
 * Mutations that turn it red: delete the die in the `have < want` branch (refusal arm); move the
 * call below the build or the stop (ordering arm); add engine-strict to .npmrc (npmrc arm).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { shippedFunction } from './real-postgres-cluster.ts'
import { withTempDir } from './temp-dir.ts'

const REPO = process.cwd()
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const UPDATE = read('scripts/update.sh')
const DEPLOY = read('scripts/deploy.sh')
const FN = shippedFunction(UPDATE, 'node_engine_preflight')

function ask(pkg: string): { out: string; rc: number } {
  const script = ['die() { echo "DIE: $*"; exit 1; }', FN, `node_engine_preflight '${pkg}'; echo ok`].join('\n')
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  return { out: `${r.stdout}${r.stderr}`, rc: r.status ?? -1 }
}

test('both entrypoints carry byte-identical node_engine_preflight()', () => {
  assert.ok(FN.length > 200, 'precondition: function lifted')
  assert.equal(shippedFunction(DEPLOY, 'node_engine_preflight'), FN)
})

test('refuses when the installed Node major is below engines.node, naming both majors', async () => {
  await withTempDir('ims-node-engine-', async (dir) => {
    const major = Number(process.versions.node.split('.')[0])
    const pkg = join(dir, 'package.json')
    writeFileSync(pkg, JSON.stringify({ engines: { node: `>=${major + 1}.0.0` } }))
    const r = ask(pkg)
    assert.equal(r.rc, 1)
    assert.match(r.out, new RegExp(`runs Node ${major} .* requires Node ${major + 1} or newer`))
    assert.match(r.out, /NOTHING HAS BEEN STOPPED, BUILT OR MIGRATED/)
    assert.doesNotMatch(r.out, /^ok$/m)
  })
})

test('passes at the same major, above it, and for engines shapes it does not evaluate', async () => {
  await withTempDir('ims-node-engine-', async (dir) => {
    const major = Number(process.versions.node.split('.')[0])
    const pkg = join(dir, 'package.json')
    for (const engines of [`>=${major}.0.0`, `>=${major - 1}.0.0`, '^20 || ^22', undefined]) {
      writeFileSync(pkg, JSON.stringify(engines === undefined ? {} : { engines: { node: engines } }))
      const r = ask(pkg)
      assert.equal(r.rc, 0, `${engines}: ${r.out}`)
      assert.match(r.out, /ok/)
    }
  })
})

test('refuses when node cannot be run at all', async () => {
  await withTempDir('ims-node-engine-', async (dir) => {
    const pkg = join(dir, 'package.json')
    writeFileSync(pkg, JSON.stringify({ engines: { node: '>=26.0.0' } }))
    const script = ['die() { echo "DIE: $*"; exit 1; }', FN, `node() { return 127; }; node_engine_preflight '${pkg}'; echo ok`].join('\n')
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stdout, /Cannot determine the installed Node version/)
  })
})

test('the call precedes the build and the stop in both entrypoints', () => {
  for (const [name, source] of [['update.sh', UPDATE], ['deploy.sh', DEPLOY]] as const) {
    const lines = source.split('\n').map((text, i) => ({ n: i + 1, text })).filter((l) => !/^\s*#/.test(l.text))
    const call = lines.find((l) => /^node_engine_preflight "\$\{APP_DIR(_REAL)?\}\/package\.json"$/.test(l.text))
    const build = lines.find((l) => /\bnpm run build\b/.test(l.text) && !/echo/.test(l.text))
    const fenceMarker = source.split('\n').findIndex((t) => t.trim() === '# @deploy-phase: fence-writers') + 1
    const stop = { n: fenceMarker }
    assert.ok(call && build && fenceMarker > 0, `${name}: call, build and fence-writers phase found`)
    assert.ok(call.n < build.n, `${name}: before the build`)
    assert.ok(call.n < stop.n, `${name}: before the stop`)
  }
})

test('.npmrc does not set engine-strict (the refusal is the scripts\', not npm ci\'s)', () => {
  assert.doesNotMatch(read('.npmrc'), /engine-strict/)
})
