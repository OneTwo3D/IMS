import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

/**
 * o3d-potv. `wc_sync_interval_minutes` was typed, defaulted to '5', listed in
 * SYNC_SETTING_KEYS, written by saveSyncSettings and rendered as an editable
 * "Polling interval (minutes)" number input — and read by NOTHING. The real
 * cadence is the wc-reconcile cron schedule, so an operator who set it to 5
 * after a webhook outage still got the daily 04:00 reconcile and was never told.
 *
 * scripts/check-documented-env-vars.mjs (o3d-o8cp) cannot see this class: it
 * only knows about environment variables. This is its sibling for settings keys
 * — a key an operator can edit must have a consumer somewhere that is not the
 * settings plumbing that stores it or the form that displays it.
 */

const WC_SYNC_ACTIONS = 'app/actions/wc-sync.ts'
const SYNC_UI_DIR = 'app/(dashboard)/sync'

// The settings plumbing (which stores the key) and the form (which displays it)
// are exactly what a phantom control consists of, so neither counts as a reader.
const NOT_A_CONSUMER = [WC_SYNC_ACTIONS, SYNC_UI_DIR]

async function collectSourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'generated') continue
      await collectSourceFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

async function syncSettingKeys(): Promise<string[]> {
  // Parsed from the source: wc-sync.ts is a 'use server' module, so the array
  // cannot be exported for import (every export there must be an async action).
  const source = await readFile(WC_SYNC_ACTIONS, 'utf8')
  const match = source.match(/const SYNC_SETTING_KEYS = \[([\s\S]*?)\]/)
  assert.ok(match, 'could not find SYNC_SETTING_KEYS in ' + WC_SYNC_ACTIONS)
  const keys = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(keys.length > 5, `expected the real key list, parsed ${keys.length}`)
  return keys
}

test('every editable WooCommerce sync setting has a consumer outside the settings plumbing (o3d-potv)', async () => {
  const keys = await syncSettingKeys()
  const files = [...await collectSourceFiles('lib'), ...await collectSourceFiles('app')]
    .filter((file) => !NOT_A_CONSUMER.some((excluded) => file === excluded || file.startsWith(excluded + path.sep)))

  const contents = await Promise.all(files.map(async (file) => ({ file, text: await readFile(file, 'utf8') })))

  const orphans: string[] = []
  for (const key of keys) {
    const readers = contents.filter(({ text }) => text.includes(key)).map(({ file }) => file)
    if (readers.length === 0) orphans.push(key)
  }

  assert.deepEqual(
    orphans,
    [],
    `these settings keys are saved and rendered but read by nothing — wire them or remove them: ${orphans.join(', ')}`,
  )
})

test('the phantom polling interval is gone from the key list and from the form (o3d-potv)', async () => {
  const keys = await syncSettingKeys()
  assert.equal(
    keys.includes('wc_sync_interval_minutes'),
    false,
    'wc_sync_interval_minutes must not be a saved setting: nothing reads it, and saving it makes the UI look like it did something',
  )

  const client = await readFile(path.join(SYNC_UI_DIR, 'sync-client.tsx'), 'utf8')
  assert.doesNotMatch(
    client,
    /<Input[^>]*wc_sync_interval_minutes/,
    'the polling interval must not be an editable input',
  )
  // A removal that leaves the operator with no answer is only half the fix: the
  // page has to say where the cadence actually lives.
  assert.match(client, /settings\/system\?tab=scheduler/, 'the sync page must link to the cron schedule that IS the cadence')
})
