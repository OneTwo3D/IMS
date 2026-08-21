import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { normaliseStoreUrl, seedSetting } from '../../scripts/provision-instance.mjs'

// o3d-esha. WC_STORE_URL is written into every .env by scripts/install.sh, so it
// must not be a runtime override — an installation repointed at a new store in
// Settings would silently revert on its next upgrade. It is a SEED instead: the
// installer supplies the value once and the Settings UI owns it afterwards.
// That distinction only holds if the write is insert-only.

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../..')

function fakeDb(existingKeys: string[] = []) {
  const keys = new Set(existingKeys)
  const queries: Array<{ sql: string; params: unknown[] }> = []
  return {
    queries,
    async query(sql: string, params: unknown[]) {
      queries.push({ sql, params })
      const key = String(params[0])
      if (keys.has(key)) return { rowCount: 0 }
      keys.add(key)
      return { rowCount: 1 }
    },
  }
}

test('seedSetting inserts once and never overwrites an existing value', async () => {
  const fresh = fakeDb()
  assert.equal(await seedSetting(fresh, 'wc_url', 'https://store.example'), true)
  assert.deepEqual(fresh.queries[0]?.params, ['wc_url', 'https://store.example'])

  const alreadySet = fakeDb(['wc_url'])
  assert.equal(await seedSetting(alreadySet, 'wc_url', 'https://stale-store.example'), false)
  // The SQL itself must say so: `do update set` here would make the seed an
  // override with extra steps, and a re-run of the installer would undo the
  // operator's Settings change exactly as an env override would.
  assert.match(alreadySet.queries[0]?.sql ?? '', /on conflict \(key\) do nothing/)
  assert.doesNotMatch(alreadySet.queries[0]?.sql ?? '', /do update/)
})

test('seedSetting writes nothing for an empty value', async () => {
  const db = fakeDb()

  assert.equal(await seedSetting(db, 'wc_url', ''), false)
  assert.equal(db.queries.length, 0)
})

test('the seeded store URL is stored the way the connector reads it', () => {
  // wcFetch appends `/wp-json/wc/v3/...`, so a trailing slash produces a
  // double-slashed request against every WooCommerce endpoint.
  assert.equal(normaliseStoreUrl('https://store.example/'), 'https://store.example')
  assert.equal(normaliseStoreUrl('https://store.example///'), 'https://store.example')
  assert.equal(normaliseStoreUrl('https://store.example/shop/'), 'https://store.example/shop')
  assert.equal(normaliseStoreUrl('http://store.example:8080'), 'http://store.example:8080')
})

test('a mistyped installer answer is skipped rather than seeded', () => {
  // Seeding rubbish would leave the connector reporting itself configured while
  // every call failed, which is harder to diagnose than an unset store URL.
  for (const raw of ['', '   ', 'store.example', 'ftp://store.example', 'javascript:alert(1)']) {
    assert.equal(normaliseStoreUrl(raw), '', JSON.stringify(raw))
  }
})

// The wiring below has no other test: seedSetting can be perfect and still never
// be called, or be called with a value the installer never passes through.
test('provision-instance seeds wc_url from WC_STORE_URL, and does not upsert it', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts/provision-instance.mjs'), 'utf8')

  assert.match(source, /normaliseStoreUrl\(getEnv\('WC_STORE_URL'\)\)/)
  assert.match(source, /seedSetting\(db, 'wc_url', wcStoreUrl\)/)
  assert.doesNotMatch(source, /upsertSetting\(db, 'wc_url'/)
})

test('install.sh passes WC_STORE_URL through to the bootstrap script', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts/install.sh'), 'utf8')
  const bootstrap = source.slice(source.indexOf('BOOTSTRAP_SCRIPT='))

  // Without this the seed silently never runs: the installer prompts for the
  // store URL, writes it into .env, and the app starts with no store configured.
  assert.match(bootstrap, /WC_STORE_URL="\$\{WC_STORE_URL\}"/)
})
