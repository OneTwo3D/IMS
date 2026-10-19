import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { IMS_WRITER_SWITCHES, WRITER_CRON_ROUTES, writersCheckCronSlugs } from '../../lib/ops/writers-check'

/**
 * A SCHEDULE FLAG IS NOT A CAPABILITY UNLESS THE ROUTE ENFORCES IT.
 *
 * The flag only decides whether a crontab line exists. A route that does not check it stays callable by an authenticated request or a
 * stale scheduler entry, so `writers:check` must not read "the job is off" as "IMS cannot write". This census reads the routes.
 */

const routeSource = (slug: string): string => {
  const path = `app/api/cron/${slug}/route.ts`
  assert.ok(existsSync(path), `${path} exists`)
  return readFileSync(path, 'utf8')
}

/** What a route that enforces its own enablement has to call: the shared resolver (or a helper that wraps it). */
const ENFORCES_ENABLEMENT = /resolveCronEnablement|cronEnablementKeys|isCronJobEnabled|assertCronEnabled/

test('every cron requirement names a route that ENFORCES its enablement (a flag the route ignores cannot prove IMS cannot write)', () => {
  const slugs = writersCheckCronSlugs()
  console.log(`# cron requirements in the switch table: ${slugs.length} (${slugs.join(', ') || 'none'})`)
  for (const slug of slugs) {
    assert.equal(WRITER_CRON_ROUTES[slug], 'flag-enforced', `${slug} is used as a switch but not declared flag-enforced`)
    assert.match(routeSource(slug), ENFORCES_ENABLEMENT, `${slug}: the route does not enforce the flag the check relies on`)
  }
})

test('every declared route agrees with its source: always-callable routes do not gate, flag-enforced routes do, and the guard is not vacuous', () => {
  const declared = Object.entries(WRITER_CRON_ROUTES)
  assert.ok(declared.length >= 1)
  for (const [slug, mode] of declared) {
    const source = routeSource(slug)
    if (mode === 'always-callable') {
      assert.doesNotMatch(source, ENFORCES_ENABLEMENT, `${slug} now enforces its flag: declare it flag-enforced (and the check may use the flag)`)
      assert.ok(!writersCheckCronSlugs().includes(slug), `${slug} is always-callable, so no switch may require its flag`)
    } else {
      assert.match(source, ENFORCES_ENABLEMENT, `${slug} is declared flag-enforced but the route does not enforce it`)
    }
  }
  // Not vacuous: the matcher fires on a route that does enforce, and misses one that does not.
  assert.match("const on = resolveCronEnablement({ canonical })", ENFORCES_ENABLEMENT)
  assert.doesNotMatch(routeSource('wms-order-push'), ENFORCES_ENABLEMENT)
})

test('the Mintsoft order writers do not depend on the wms-order-push schedule flag', () => {
  for (const key of ['mintsoft.order.create', 'mintsoft.order.amend', 'mintsoft.order.cancel', 'mintsoft.order.hold']) {
    const entry = IMS_WRITER_SWITCHES.find((candidate) => candidate.key === key)
    assert.ok(entry, key)
    assert.ok(!entry!.requires.some((req) => 'cron' in req), `${key} must not treat the schedule flag as a capability`)
  }
})
