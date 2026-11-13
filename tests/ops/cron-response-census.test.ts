import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import test from 'node:test'

/**
 * EVERY /api/cron/* ROUTE ANSWERS THROUGH THE SHARED MAPPING.
 *
 * The crontab wrapper runs `curl -sf`, so the HTTP status is the run's exit status (and the Healthchecks heartbeat behind it). A route
 * that builds its own response can answer 200 for a failed run. Routes answer through cronRunResponse (logged runs) or
 * cronResultResponse (the rest) from lib/ops/cron-response.ts, and never build a JSON response themselves.
 */

const ROOT = 'app/api/cron'
const slugs = readdirSync(ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)

test('the census sees the routes (not vacuous)', () => {
  console.log(`# cron routes under ${ROOT}: ${slugs.length}`)
  assert.ok(slugs.length >= 30)
})

test('every cron route file answers through the shared response mapping and builds no response of its own', () => {
  for (const slug of slugs) {
    const file = `${ROOT}/${slug}/route.ts`
    assert.ok(existsSync(file), `${slug} has no route.ts`)
    const source = readFileSync(file, 'utf8')
    assert.match(source, /from '@\/lib\/ops\/cron-response'/, `${file} does not import the shared response mapping`)
    assert.match(source, /\bcron(?:Run|Result)Response\(/, `${file} does not answer through cronRunResponse or cronResultResponse`)
    assert.doesNotMatch(source, /NextResponse\.json\(|new Response\(|Response\.json\(/, `${file} builds its own response: a failed run could answer 2xx`)
  }
})

test('no route passes a hand-set HTTP status to the response (pass an outcomeClass instead)', () => {
  for (const slug of slugs) {
    const source = readFileSync(`${ROOT}/${slug}/route.ts`, 'utf8')
    assert.doesNotMatch(source, /\{\s*status:\s*\d{3}|status:\s*[a-zA-Z.]+\s*\?\s*\d{3}/, `${slug}: a hand-set status bypasses the mapping`)
  }
})

test('every cron route declares its own outcome mapping, and the mapping has an entry for it (no inference alone)', async () => {
  const { cronOutcomes } = await import('../../lib/ops/cron-outcomes.ts')
  assert.deepEqual(Object.keys(cronOutcomes).sort(), [...slugs].sort(), 'cronOutcomes must have exactly one entry per route directory')
  for (const slug of slugs) {
    const source = readFileSync(`${ROOT}/${slug}/route.ts`, 'utf8')
    assert.ok(source.includes(`cronOutcome('${slug}'`), `${slug}: the route does not call cronOutcome('${slug}', ...) with its own slug`)
    if (/runCronWithLogging\b/.test(source)) {
      assert.match(source, /outcomeOf:\s*\(result\)\s*=>\s*cronOutcome\(/, `${slug}: a logged run must pass outcomeOf`)
    }
  }
})

test('a response is never built without a class: the helpers have no inferring default', () => {
  const source = readFileSync('lib/ops/cron-response.ts', 'utf8')
  assert.doesNotMatch(source, /classifyCronResult/, 'the response helpers must not infer a class from the result')
})
