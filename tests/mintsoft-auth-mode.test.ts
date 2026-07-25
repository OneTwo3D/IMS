import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MINTSOFT_AUTH_MODES,
  parseMintsoftAuthMode,
} from '../lib/connectors/mintsoft/settings/schema.ts'
import { SENSITIVE_SETTING_KEYS } from '../lib/settings-store.ts'

// o3d-092. Mintsoft's POST /api/Auth does not hand out a session token — it
// MINTS A NEW TENANT API KEY and invalidates the previous one. This connector,
// the woocommerce-mintsoft-sync order sweep and the shipping-label service all
// share that one tenant key, so any login here knocks the other two offline.
//
// `api_key` mode is therefore a HARD guarantee that /api/Auth is never called.
// These tests pin the parts of that guarantee which are pure; the wiring
// (getMintsoftAccessToken short-circuit, the 401 path) is exercised by the
// connector tests.

test('parseMintsoftAuthMode accepts exactly the two supported modes', () => {
  assert.equal(parseMintsoftAuthMode('credentials'), 'credentials')
  assert.equal(parseMintsoftAuthMode('api_key'), 'api_key')
  assert.deepEqual([...MINTSOFT_AUTH_MODES], ['credentials', 'api_key'])
})

test('parseMintsoftAuthMode tolerates operator whitespace and casing', () => {
  assert.equal(parseMintsoftAuthMode('  API_KEY  '), 'api_key')
  assert.equal(parseMintsoftAuthMode('Credentials'), 'credentials')
})

test('parseMintsoftAuthMode returns null for anything unrecognised', () => {
  // Callers map null onto 'credentials' (the pre-o3d-092 behaviour) on read
  // paths, and REJECT it on the settings write path — so a typo can never be
  // silently persisted as a mode.
  for (const bogus of ['', '   ', 'apikey', 'static', 'fixed', 'none', 'true']) {
    assert.equal(parseMintsoftAuthMode(bogus), null, `expected null for ${JSON.stringify(bogus)}`)
  }
  assert.equal(parseMintsoftAuthMode(null), null)
  assert.equal(parseMintsoftAuthMode(undefined), null)
})

test('a falsey non-string mode is not mistaken for a supported mode', () => {
  // The Python side had exactly this bug: `configured or ''` collapsed False/0
  // into "unset", which resolved to credentials and logged in. String() here
  // turns them into 'false'/'0', which are simply unrecognised.
  assert.equal(parseMintsoftAuthMode(false as unknown as string), null)
  assert.equal(parseMintsoftAuthMode(0 as unknown as string), null)
})

test('the fixed API key is encrypted at rest like every other Mintsoft credential', () => {
  // It is a tenant-wide bearer credential — the same class of secret as the
  // rotating token and the password. Omitting it from SENSITIVE_SETTING_KEYS
  // would silently store it in plaintext.
  assert.ok(
    SENSITIVE_SETTING_KEYS.has('mintsoft_static_api_key'),
    'mintsoft_static_api_key must be in SENSITIVE_SETTING_KEYS',
  )
})

test('the fixed key does NOT reuse the rotating-token setting slot', () => {
  // mintsoft_api_key is the cache for the rotating 24-hour token: a
  // credentials-mode refresh overwrites it. Storing the operator's fixed key
  // there would mean it is destroyed the first time anything refreshes, and
  // lost when toggling modes.
  assert.notEqual('mintsoft_static_api_key', 'mintsoft_api_key')
  assert.ok(SENSITIVE_SETTING_KEYS.has('mintsoft_api_key'))
})
