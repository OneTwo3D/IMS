import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// onetwo3d-ims-dtay: authentication-sensitive rate-limit buckets must fail
// CLOSED (a backend outage must not silently disable brute-force protection).
// This asserts every checkRateLimit call in the auth-critical code paths passes
// `failClosed: true`, and documents that cron deliberately does not.

const root = process.cwd()
function read(rel: string): string {
  return readFileSync(path.join(root, rel), 'utf8')
}

const AUTH_CRITICAL_FILES = [
  'lib/auth/config.ts',
  'app/api/auth/totp/route.ts',
  'app/api/auth/step-up/route.ts',
  'app/actions/password-reset.ts',
]

test('every auth-critical checkRateLimit call fails closed', () => {
  const offenders: string[] = []
  for (const file of AUTH_CRITICAL_FILES) {
    const source = read(file)
    // Match each checkRateLimit( ... ) call, tolerant of newlines.
    const calls = source.match(/checkRateLimit\([\s\S]*?\)/g) ?? []
    assert.ok(calls.length > 0, `expected checkRateLimit usage in ${file}`)
    for (const call of calls) {
      if (!/failClosed:\s*true/.test(call)) offenders.push(`${file}: ${call.replace(/\s+/g, ' ')}`)
    }
  }
  assert.deepEqual(offenders, [], `auth-critical rate-limit call(s) not failing closed:\n${offenders.join('\n')}`)
})

test('cron rate limiting deliberately does NOT fail closed (availability over strictness)', () => {
  const source = read('lib/cron-rate-limit.ts')
  // The word appears in an explanatory comment; assert no actual failClosed:true
  // is passed to checkRateLimit.
  assert.doesNotMatch(source, /failClosed:\s*true/, 'cron rate limiting must remain fail-open (it is CRON_SECRET-gated)')
})
