import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * o3d-6thk1 round 2: every writer that FETCHES organisation-keyed data from Xero and WRITES it later must
 * remember the connection before the fetch and check it under the mapping lock before the write
 * (lib/connectors/xero/connection-fence.ts). The interleavings are proved at the database tier for the
 * chart, the drift snapshot, the auto-link and the single-rate write (tests/concurrency/xero-connection-
 * fence.concurrent.test.ts); the writers that tier cannot drive without a real Xero write or an interleaving
 * hook INSIDE the subject (the balance snapshots, generate-missing) are pinned here by ORDER IN THE SOURCE:
 * capture, then fetch, then the fenced write. Comments are stripped, so prose cannot satisfy it.
 */
const strip = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (path: string) => strip(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'))

function body(code: string, signature: string): string {
  const start = code.indexOf(signature)
  assert.notEqual(start, -1, `${signature} is no longer present`)
  const rest = code.slice(start + signature.length)
  const next = rest.search(/\n(export )?(async )?function /)
  return next === -1 ? rest : rest.slice(0, next)
}

const sites: Array<{ file: string; signature: string; capture: RegExp; fetch: RegExp; write: RegExp }> = [
  { file: 'lib/connectors/xero/account-balances.ts', signature: 'export async function syncXeroAccountBalanceSnapshots', capture: /captureXeroConnection\(\)/, fetch: /xeroGet<XeroTrialBalanceReport>/, write: /withXeroConnectionFence\(connection/ },
  { file: 'app/actions/settings.ts', signature: 'export async function generateMissingXeroTaxRates', capture: /captureXeroConnection\(\)/, fetch: /getXeroTaxRates\(\)/, write: /assertXeroConnectionUnchanged\(tx as never, connection\)/ },
  { file: 'app/actions/settings.ts', signature: 'export async function autoLinkXeroTaxRates', capture: /captureXeroConnection\(\)/, fetch: /getXeroTaxRates\(\)/, write: /assertXeroConnectionUnchanged\(tx as never, connection\)/ },
  { file: 'lib/connectors/xero/accounts.ts', signature: 'export async function syncChartOfAccounts', capture: /captureXeroConnection\(\)/, fetch: /xeroGet<AccountingAccountResponse>/, write: /withXeroConnectionFence\(connection/ },
  { file: 'lib/connectors/xero/tax-rate-drift-sweeper.ts', signature: 'export async function runXeroTaxRateDriftSweep', capture: /captureXeroConnection\(\)/, fetch: /sweepTaxRateDrift\(\{/, write: /withXeroConnectionFence\(connection/ },
]

for (const site of sites) {
  test(`[o3d-6thk1] ${site.file} ${site.signature.split(' ').pop()}: capture, then fetch, then the fenced write`, () => {
    const fn = body(read(site.file), site.signature)
    const at = { capture: fn.search(site.capture), fetch: fn.search(site.fetch), write: fn.search(site.write) }
    console.log(`# o3d-6thk1 fence order ${site.signature.split(' ').pop()}: ${JSON.stringify(at)}`)
    assert.ok(at.capture !== -1 && at.fetch !== -1 && at.write !== -1, `PRECONDITION: all three steps present ${JSON.stringify(at)}`)
    assert.ok(at.capture < at.fetch && at.fetch < at.write, `capture < fetch < write: ${JSON.stringify(at)}`)
  })
}
