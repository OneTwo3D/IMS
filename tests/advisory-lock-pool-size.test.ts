import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The shared advisory-lock pool is capped at 4 connections per process. It was raised to 6 for the first-load runner's run lease, but a competing runner is a
 * separate process with its own pool, so nothing in one process needs more; the cap is a per-process connection budget for every lock holder (web, cron workers).
 */
test('getLockPool caps the shared advisory-lock pool at 4', () => {
  const source = readFileSync(new URL('../lib/db/pinned-advisory-lock.ts', import.meta.url), 'utf8')
  assert.match(source, /createSessionAdvisoryLockPool\('advisory locks', 4\)/)
  assert.doesNotMatch(source, /createSessionAdvisoryLockPool\('advisory locks', 6\)/)
})
