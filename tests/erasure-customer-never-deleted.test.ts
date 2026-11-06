import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

/**
 * IMS GUARANTEES AN ANONYMISED CUSTOMER ROW IS NEVER HARD-DELETED: the erasure record points at it by id.
 * The only code allowed to delete customers is the factory reset, which empties the whole database (and with
 * it every erasure record). Anything else that deletes a customer must be added here deliberately.
 */
test('only the factory reset deletes customer rows', () => {
  const out = execFileSync(
    'git',
    ['grep', '-n', '-E', '\\.customer\\.(delete|deleteMany)\\(|DELETE FROM \\"?customers\\"?', '--', 'app', 'lib', 'scripts', ':!app/generated', ':!*.test.ts'],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname },
  ).trim().split('\n').filter(Boolean)
  const offenders = out.filter((line) => !line.startsWith('app/actions/reset.ts:'))
  assert.deepEqual(offenders, [])
  assert.ok(out.some((line) => line.startsWith('app/actions/reset.ts:')), 'the scan must still see the reset, or it matches nothing')
})
