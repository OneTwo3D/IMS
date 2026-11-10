import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The helper plugin's partial-shipment route may change a WooCommerce order's status only while
 * the order is still in flight (processing, or our own partial-shipped). The repo has no PHP
 * unit-test harness, so this pins the rule two ways: the real PHP function is executed with
 * `php` (skipped when php is not installed), and the handler's source is checked so that every
 * status write sits behind the eligibility branch.
 */

const PHP = readFileSync('lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php', 'utf8')

function phpFunction(name: string): string {
  const start = PHP.indexOf(`function ${name}(`)
  assert.ok(start > 0, `${name} exists`)
  const next = PHP.indexOf("\nif (!function_exists(", start)
  return PHP.slice(start, next > 0 ? next : undefined)
}

const HANDLER = phpFunction('oti_handle_partial_shipment')

test('plugin source: version is at least 1.3.1 (the status rule shipped in it)', () => {
  const match = /^\s*\*\s*Version:\s+(\d+)\.(\d+)\.(\d+)\s*$/m.exec(PHP)
  assert.ok(match)
  const [, major, minor, patch] = match.map(Number)
  assert.ok(major > 1 || minor > 3 || (minor === 3 && patch >= 1))
})

test('plugin source: every status write in the route is behind the eligibility check', () => {
  assert.match(HANDLER, /oti_ps_status_eligible\(/)
  const gate = HANDLER.indexOf('if (!$status_eligible)')
  assert.ok(gate > 0, 'the handler branches on eligibility')
  const writes = [
    HANDLER.indexOf("update_status('completed'"),
    HANDLER.indexOf("do_action('wphub_partial_shipment_status'"),
    HANDLER.indexOf("update_status('partial-shipped'"),
  ]
  for (const at of writes) assert.ok(at > gate, 'a status write sits before the eligibility check')
  // the ineligible branch is the FIRST branch, so no write can run when it is taken
  const afterGate = HANDLER.slice(gate)
  assert.ok(afterGate.indexOf('elseif ($all_done)') > 0)
  assert.doesNotMatch(afterGate.slice(0, afterGate.indexOf('elseif ($all_done)')), /update_status|do_action/)
})

const php = spawnSync('php', ['-v'])
const phpAvailable = php.status === 0

function eligible(status: string, filterReturns: string | null = null): boolean {
  // the slice ends with the closing brace of the `if (!function_exists(...))` wrapper: drop it
  const fn = phpFunction('oti_ps_status_eligible').trimEnd().replace(/\}$/, '')
  const code = `
function apply_filters($tag, $value, ...$args) { return ${filterReturns === null ? '$value' : filterReturns}; }
${fn}
echo oti_ps_status_eligible($argv[1]) ? 'yes' : 'no';`
  const run = spawnSync('php', ['-d', 'display_errors=1', '-r', code, '--', status], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr || run.stdout)
  return run.stdout === 'yes'
}

test('oti_ps_status_eligible: in-flight statuses are eligible', { skip: !phpAvailable && 'php not installed' }, () => {
  for (const status of ['processing', 'wc-processing', 'partial-shipped', 'wc-partial-shipped', ' Processing ']) {
    assert.equal(eligible(status), true, status)
  }
})

test('oti_ps_status_eligible: cancelled, refunded, on-hold, completed and the rest are not', { skip: !phpAvailable && 'php not installed' }, () => {
  for (const status of ['cancelled', 'refunded', 'on-hold', 'completed', 'pending', 'failed', 'trash', 'checkout-draft', 'ready-to-ship', '']) {
    assert.equal(eligible(status), false, status)
  }
})

test('oti_ps_status_eligible: a store can opt a custom in-flight status in through the filter', { skip: !phpAvailable && 'php not installed' }, () => {
  assert.equal(eligible('ready-to-ship', 'true'), true)
})

test('oti_ps_status_eligible: only a strict boolean true opts in; string/number/null filter returns do not', { skip: !phpAvailable && 'php not installed' }, () => {
  for (const returned of ["'false'", "'0'", "'1'", "'true'", '1', '0', 'null', "''", '[]']) {
    assert.equal(eligible('cancelled', returned), false, `filter returned ${returned}`)
  }
  assert.equal(eligible('processing', 'false'), false)
  assert.equal(eligible('processing', "'false'"), false, 'the string false must not leave processing eligible by truthiness')
})
