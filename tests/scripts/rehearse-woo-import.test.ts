import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freePort, startCluster } from './real-postgres-cluster'
import { type TestContext, test } from 'node:test'

import { WOO_IMPORT_EXIT, WOO_STEP_CATALOGUE, type WooStepId } from '@/lib/ops/woo-import-rehearsal'
import { processIsAlive, processesNaming, verifyPublishedReport } from '@/scripts/rehearse-first-install'
import { parseWooImportArgs, readDeploymentStatusSetting, runWooImportRehearsal, type WooRehearsalHooks, type WooRehearsalOptions } from '@/scripts/rehearse-woo-import'
import { wooFixtureOrders, BULK_PROCESSING_ORDERS } from '@/tests/fixtures/woo-import/orders'
import type { FakeWooCommerce } from '@/tests/helpers/fake-woocommerce'

/**
 * THE WOOCOMMERCE INITIAL-IMPORT REHEARSAL, END TO END (real cluster, real import code, fake store).
 *
 * Each arm below is a way the rehearsal could lie, with the one change that makes it lie named in the
 * comment above it; the change was made, the arm went red, and the change was reverted (md5-verified).
 */

const SCRATCH_PARENT = '/var/tmp'
const REPO_CWD = process.cwd()
const TIMEOUT = 15 * 60 * 1000
const PREREQS: WooStepId[] = ['migrate-deploy', 'seed', 'prepare']

function scratchParent(t: TestContext): string {
  const parent = mkdtempSync(join(SCRATCH_PARENT, 'ims-rehearsal-test-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  return parent
}

const runDirsIn = (parent: string): string[] => readdirSync(parent).filter((name) => name.startsWith('ims-rehearsal-'))

async function rehearse(t: TestContext, options: { only?: ReadonlySet<WooStepId>; hooks?: WooRehearsalHooks; storeFaults?: WooRehearsalOptions['storeFaults']; seedUsdRate?: boolean; deploymentStatuses?: WooRehearsalOptions['deploymentStatuses'] } = {}) {
  const parent = scratchParent(t)
  const outcome = await runWooImportRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, ...options })
  assert.ok(outcome.report, `the rehearsal produced a report (refusal: ${outcome.refusal})`)
  return { parent, outcome, report: outcome.report }
}

function step(report: { steps: Array<{ id: unknown; required: boolean; status: string; reason?: string; detail: Record<string, unknown> }> }, id: WooStepId) {
  const found = report.steps.find((candidate) => candidate.id === id)
  assert.ok(found, `step ${id} is in the report`)
  return found
}

function redSteps(report: { steps: Array<{ id: unknown; required: boolean; status: string }> }): string[] {
  return report.steps.filter((s) => s.required && s.status !== 'passed').map((s) => String(s.id))
}

function assertTornDown(parent: string, outcome: Awaited<ReturnType<typeof rehearse>>['outcome']): void {
  assert.deepEqual(runDirsIn(parent), [], 'the run directory (cluster, env file) is gone')
  assert.ok(outcome.runRoot && !existsSync(outcome.runRoot))
  assert.deepEqual(outcome.report!.teardown, { ...outcome.report!.teardown!, clusterStopped: true, envFileShredded: true, rootRemoved: true, orphanPids: [], errors: [] })
  assert.deepEqual(processesNaming(outcome.runRoot!), [], 'no process still names the run directory')
  assert.equal(processIsAlive(outcome.report!.teardown!.postmasterPid as number), false, 'the postmaster this run started is not running')
}

// ---------------------------------------------------------------------------------------------
// The green run.
// ---------------------------------------------------------------------------------------------

test('GREEN: every step passes; counts are exact; the stamp appears only on the real pass; nothing but GET reached the store; secrets never reach argv; the teardown is clean', { timeout: TIMEOUT }, async (t) => {
  const seen: { mode?: number; hits?: number; scanned?: number; control?: number; storeUrl?: string } = {}
  const holder: { fake?: FakeWooCommerce } = {}
  const parent = scratchParent(t)
  const hooks: WooRehearsalHooks = {
    onFakeStore: (f) => { holder.fake = f },
    beforeStep: (id) => {
      if (id !== 'rehearsal-import') return
      const files = runDirsIn(parent).map((n) => join(parent, n, 'rehearsal.env')).filter((f) => existsSync(f))
      assert.equal(files.length, 1, 'precondition: the env file exists mid-run')
      seen.mode = statSync(files[0]!).mode & 0o777
      const env = Object.fromEntries(readFileSync(files[0]!, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
      seen.storeUrl = env.REHEARSAL_STORE_URL
      const secrets = [new URL(env.DATABASE_URL!).password, env.REHEARSAL_STORE_KEY!, env.REHEARSAL_STORE_SECRET!, env.SETTINGS_ENCRYPTION_KEY!, env.AUTH_SECRET!]
      let scanned = 0
      let hits = 0
      for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          scanned += 1
          if (secrets.some((secret) => cmdline.includes(secret))) hits += 1
        } catch { /* exited */ }
      }
      seen.scanned = scanned
      seen.hits = hits
      // Positive control: the same scan DOES find the store secret when it is on a command line.
      const control = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', env.REHEARSAL_STORE_SECRET!], { stdio: 'ignore' })
      let controlHits = 0
      try {
        execFileSync('sleep', ['0.3'])
        for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
          try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(env.REHEARSAL_STORE_SECRET!)) controlHits += 1 } catch { /* exited */ }
        }
      } finally { control.kill('SIGKILL') }
      seen.control = controlHits
    },
  }
  const outcome = await runWooImportRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), log: () => undefined, hooks })
  assert.ok(outcome.report, `report (refusal: ${outcome.refusal})`)
  const report = outcome.report
  console.log(`# env file mode ${seen.mode?.toString(8)}; ${seen.scanned} command lines scanned, secrets on argv: ${seen.hits}; positive control found: ${seen.control}`)
  assert.equal(seen.mode, 0o600)
  assert.ok((seen.scanned ?? 0) > 10 && (seen.control ?? 0) >= 1, 'the scan can find a secret on argv')
  assert.equal(seen.hits, 0)
  assert.match(seen.storeUrl ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, 'the store the connector was pointed at is on loopback')

  assert.deepEqual(redSteps(report), [])
  assert.equal(report.verdict, 'GREEN')
  assert.equal(outcome.exitCode, WOO_IMPORT_EXIT.OK)
  assert.deepEqual(report.steps.map((s) => s.id), WOO_STEP_CATALOGUE.map((s) => s.id), 'every catalogued step is in the report, in order')

  // R9 count and value, with the numbers the fixtures dictate.
  const fixtures = wooFixtureOrders()
  const selected = fixtures.filter((f) => ['processing', 'pending', 'on-hold'].includes(f.order.status))
  const expectedImported = selected.length
  console.log(`# store: ${fixtures.length} orders, ${selected.length} in the selected statuses, ${expectedImported} expected to import (bulk ${BULK_PROCESSING_ORDERS})`)
  assert.ok(selected.length > 100, 'precondition: more than one page of 100 in the selected statuses')
  assert.equal(report.r9!.expectedCount, selected.length)
  assert.equal(report.r9!.importedCount, expectedImported)
  assert.deepEqual(report.r9!.missing, [])
  assert.equal(report.r9!.maxValueDiffForeign, 0)
  assert.equal(report.r9!.maxValueDiffBase, 0)
  assert.equal(report.tallies.fetchedFromStore, selected.length, 'the first pass fetched exactly the orders in the selected statuses and no other')
  assert.equal(report.tallies.importedFirstPass, expectedImported)
  assert.equal(report.tallies.errorsFirstPass, 0)
  assert.equal(report.tallies.importedSecondPass, 0)
  assert.equal(report.tallies.abandonedByStatus, fixtures.length - selected.length)
  assert.deepEqual(report.statuses.resolved.slice().sort(), ['on-hold', 'pending', 'processing'])
  // The abandoned statuses were never asked for: no order-list request named one of them.
  const fake = holder.fake
  assert.ok(fake)
  const asked = fake.requests.filter((r) => r.path.endsWith('/orders')).map((r) => r.query.status ?? '')
  assert.ok(asked.length >= 9, `precondition: ${asked.length} order-list requests`)
  for (const status of asked) assert.equal(/completed|cancelled|refunded|failed/.test(status), false, `status filter "${status}" names an abandoned status`)

  // Pagination: three pages per pass (100 + remainder + the empty page that proves the ending).
  const pages = fake.requests.filter((r) => r.path.endsWith('/orders')).map((r) => r.query.page)
  assert.deepEqual(pages.slice(0, 3), ['1', '2', '3'])

  // Stamp: absent after the rehearsal passes, present only after the real pass.
  assert.deepEqual(report.stamp.afterRehearsal, { completed: null, cursor: null })
  assert.equal(report.stamp.afterRealPass!.completed, 'true')
  assert.ok(Number.isFinite(Date.parse(report.stamp.afterRealPass!.cursor ?? '')))

  // Read-only.
  assert.equal(report.readOnly!.nonGetRequests, 0)
  assert.equal(report.readOnly!.unmodelledRequests, 0)
  assert.deepEqual(report.readOnly!.holdRefusals, { woocommerce: 0, mintsoft: 0, xero: 0 })
  assert.deepEqual(Object.keys(report.readOnly!.byRoute), ['GET /wp-json/wc/v3/orders'])
  assert.equal(fake.writeViolations().length, 0)

  // R4 and OD-4.
  assert.ok(report.r4!.rowsWithReservations >= 2)
  assert.equal(report.r4!.worstDiff, 0)
  assert.ok(report.landing!.beforeLanding.length > 20 && report.landing!.afterSweep.length <= 3)
  const findings = report.findings.map((f) => f.code).sort()
  assert.deepEqual(findings, [
    'imported-short-orders-outside-processing-are-not-allocated-when-stock-lands',
    'lines-without-product-are-never-allocatable',
  ])
  // The review findings: nothing is excused from the count, and the not-allocated orders are named, not implied to allocate.
  assert.equal(step(report, 'short-after-landing').status, 'passed')
  assert.deepEqual(report.stillShortAfterLanding!.notExpectedToAllocate.map((r) => `${r.externalOrderId}:${r.imsStatus}`), ['5003:ON_HOLD', '5015:PENDING_PAYMENT'])
  assert.deepEqual(report.stillShortAfterLanding!.expectedToAllocate, [])
  assert.match(readFileSync(outcome.reportPaths!.markdown, 'utf8'), /not expected to allocate \(o3d-zjsb5\.36\): 2 order\(s\), still unallocated and NOT allocated by the stock landing/)
  const deployStep = step(report, 'deployment-statuses')
  assert.equal(deployStep.status, 'skipped')
  assert.equal(deployStep.required, false)
  assert.match(deployStep.reason ?? '', /^NOT CHECKED:/)
  assert.equal(report.deployment.state, 'not-checked')
  assert.match(readFileSync(outcome.reportPaths!.markdown, 'utf8'), /the deployment's actual setting\): \*\*NOT CHECKED\*\*/)
  assert.match(readFileSync(outcome.reportPaths!.markdown, 'utf8'), /SIMULATED: the rehearsal configured it itself/)

  const waiting = report.unallocatable.find((o) => o.externalOrderId === 5003)!
  assert.equal(waiting.imsStatus, 'ON_HOLD')
  assert.equal(waiting.afterLanding, 'still-waiting')
  assert.equal(report.unallocatable.find((o) => o.externalOrderId === 7090)!.afterLanding, 'allocated-when-stock-landed')
  assert.equal(report.unallocatable.find((o) => o.externalOrderId === 5008)!.afterLanding, 'never-allocatable-lines-without-product')

  // What the import left behind.
  assert.equal(report.sideEffects!.linesWithoutProduct, 3)
  assert.equal(report.sideEffects!.emailOutbox, 0)
  assert.ok(report.sideEffects!.customersCreated > 40)

  // Report files: a verified pair, and no secret in either.
  assert.deepEqual(verifyPublishedReport(outcome.reportPaths!.json), { ok: true })
  const json = readFileSync(outcome.reportPaths!.json, 'utf8')
  const markdown = readFileSync(outcome.reportPaths!.markdown, 'utf8')
  assert.match(markdown, /^# WooCommerce initial-import rehearsal: GREEN/)
  for (const text of [json, markdown]) {
    assert.equal(/postgres(ql)?:\/\//.test(text), false, 'no connection URL in the report')
    assert.equal(/\bck_[0-9a-f]{8}|\bcs_[0-9a-f]{8}|PGPASSWORD|SETTINGS_ENCRYPTION_KEY=/.test(text), false, 'no store credential or key in the report')
  }
  assertTornDown(parent, outcome)
})

test('IDEMPOTENT RE-RUN: a second run uses a fresh cluster directory, ignores an inherited DATABASE_URL and gets the same answers', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgresql://imsdev:not-a-real-password@127.0.0.1:1/onetwo3d_ims_dev'
  try {
    const only = new Set<WooStepId>([...PREREQS, 'rehearsal-import', 'status-selection', 'pass-complete', 'no-stamp-on-rehearsal', 'r9-orders'])
    const first = await runWooImportRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), only, log: () => undefined })
    const second = await runWooImportRehearsal({ parentDir: parent, reportDir: join(parent, 'reports'), only, log: () => undefined })
    for (const outcome of [first, second]) {
      assert.deepEqual(redSteps(outcome.report!), [])
      assert.ok(outcome.report!.notes.some((n) => /inherited DATABASE_URL was present and was IGNORED/.test(n)))
    }
    assert.notEqual(first.runRoot, second.runRoot)
    assert.notEqual(first.report!.cluster.port === second.report!.cluster.port && first.report!.runId === second.report!.runId, true)
    assert.equal(first.report!.r9!.importedCount, second.report!.r9!.importedCount)
    assert.deepEqual(runDirsIn(parent), [])
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
})

// ---------------------------------------------------------------------------------------------
// Arms: each is a way the rehearsal could pass while wrong.
// ---------------------------------------------------------------------------------------------

// ARM (R9 value). MUTATION: set R9_VALUE_TOLERANCE to 5 in lib/ops/woo-import-rehearsal.ts and this goes green-where-it-must-be-red.
test('ARM (total mismatch): an imported total that is 0.50 off the store\'s is RED, and r9-orders alone says so', { timeout: TIMEOUT }, async (t) => {
  const hooks: WooRehearsalHooks = {
    afterFirstPass: async (client) => {
      const updated = await client.query(`update sales_orders set "totalForeign" = "totalForeign" + 0.50, "totalBase" = "totalBase" + 0.50 where id = (select "orderId" from shopping_order_links where connector = 'woocommerce' and "externalOrderId" = '5001')`)
      assert.equal(updated.rowCount, 1, 'precondition: exactly one imported order was tampered with')
    },
  }
  const { outcome, report } = await rehearse(t, { only: new Set<WooStepId>([...PREREQS, 'rehearsal-import', 'r9-orders']), hooks })
  assert.deepEqual(redSteps(report), ['r9-orders'])
  assert.match(step(report, 'r9-orders').reason ?? '', /differ from WooCommerce by more than 0\.01: 5001/)
  assert.equal(outcome.exitCode, WOO_IMPORT_EXIT.RED)
  assert.equal(report.verdict, 'RED')
})

// ARM (count). MUTATION: change `missing` in assessR9 to an empty list (or compare against the imported set only) and this goes green.
test('ARM (count): one order missing from IMS is RED and named', { timeout: TIMEOUT }, async (t) => {
  const hooks: WooRehearsalHooks = {
    afterFirstPass: async (client) => {
      await client.query(`delete from shopping_order_links where connector = 'woocommerce' and "externalOrderId" = '5004'`)
    },
  }
  const { report } = await rehearse(t, { only: new Set<WooStepId>([...PREREQS, 'rehearsal-import', 'r9-orders']), hooks })
  assert.deepEqual(redSteps(report), ['r9-orders'])
  assert.match(step(report, 'r9-orders').reason ?? '', /not in IMS: 5004/)
})

// ARM (read-only). MUTATION: change `if (nonGet.length > 0)` in assessReadOnly to `if (false)` and this goes green.
// ISOLATING: the rogue write is authenticated and aimed at a route the fake models, so the non-GET fact is the ONLY
// thing that can make the step red (the unmodelled-route and credential checks cannot mask the mutation).
test('ARM (non-GET): an authenticated write to a modelled route is RED for that reason alone, named, and recorded by the store itself', { timeout: TIMEOUT }, async (t) => {
  const holder: { fake?: FakeWooCommerce } = {}
  const hooks: WooRehearsalHooks = {
    onFakeStore: async (f) => {
      holder.fake = f
      // The control: a plain POST to the fake, as a rogue order update would be.
      const res = await fetch(`${f.url}/wp-json/wc/v3/orders`, { method: 'POST', headers: { authorization: f.authorization, 'content-type': 'application/json' }, body: '{}' })
      assert.equal(res.status, 405)
    },
  }
  const { report } = await rehearse(t, { only: new Set<WooStepId>([...PREREQS, 'rehearsal-import', 'read-only-proof']), hooks })
  assert.ok(holder.fake)
  assert.equal(holder.fake.writeViolations().length, 1, 'precondition: the store recorded the write')
  assert.deepEqual({ authenticated: holder.fake.requests[0]!.authenticated, modelled: holder.fake.requests[0]!.modelled }, { authenticated: true, modelled: true }, 'precondition: nothing but the method is wrong with the rogue request')
  assert.deepEqual(redSteps(report), ['read-only-proof'])
  const reason = step(report, 'read-only-proof').reason ?? ''
  assert.equal(reason, '1 non-GET request(s) reached the store: POST /wp-json/wc/v3/orders', 'the non-GET fact is the only reason')
  assert.equal(report.readOnly!.nonGetRequests, 1)
})

// ARM (unmodelled). ISOLATING: an authenticated GET for a route the fake does not model. MUTATION: delete the `unmodelled` failure in assessReadOnly.
test('ARM (unmodelled route): an authenticated GET the fake does not model is RED for that reason alone', { timeout: TIMEOUT }, async (t) => {
  const hooks: WooRehearsalHooks = {
    onFakeStore: async (f) => {
      const res = await fetch(`${f.url}/wp-json/wc/v3/products?sku=A`, { headers: { authorization: f.authorization } })
      assert.equal(res.status, 404, 'the fake does not model /products')
    },
  }
  const { report } = await rehearse(t, { only: new Set<WooStepId>([...PREREQS, 'rehearsal-import', 'read-only-proof']), hooks })
  assert.deepEqual(redSteps(report), ['read-only-proof'])
  assert.equal(step(report, 'read-only-proof').reason, '1 request(s) were for routes the fake does not model: GET /wp-json/wc/v3/products')
})

// ARM (credentials). A request that did not carry the store credentials is RED for that reason alone. MUTATION: delete the `unauthenticated` failure.
test('ARM (unauthenticated request): a GET without the store credentials is RED for that reason alone', { timeout: TIMEOUT }, async (t) => {
  const hooks: WooRehearsalHooks = {
    onFakeStore: async (f) => {
      const res = await fetch(`${f.url}/wp-json/wc/v3/orders?per_page=1`)
      assert.equal(res.status, 401)
    },
  }
  const { report } = await rehearse(t, { only: new Set<WooStepId>([...PREREQS, 'rehearsal-import', 'read-only-proof']), hooks })
  assert.deepEqual(redSteps(report), ['read-only-proof'])
  assert.equal(step(report, 'read-only-proof').reason, '1 request(s) did not carry the store credentials')
})

// ARM (page hole). A store that fails page 2 must leave the pass failed and the rehearsal RED, and write no stamp.
test('ARM (store fails a page): the pass is not complete, the rehearsal is RED, and no stamp is written', { timeout: TIMEOUT }, async (t) => {
  const { report } = await rehearse(t, {
    only: new Set<WooStepId>([...PREREQS, 'rehearsal-import', 'pass-complete', 'no-stamp-on-rehearsal']),
    storeFaults: { failPages: [2] },
  })
  assert.deepEqual(redSteps(report), ['pass-complete'])
  assert.match(step(report, 'pass-complete').reason ?? '', /the pass ended failed, not complete/)
  assert.equal(step(report, 'no-stamp-on-rehearsal').status, 'passed')
  assert.deepEqual(report.stamp.afterRehearsal, { completed: null, cursor: null })
})

// ARM (page past the end answers 400). The import's walk ends on an EMPTY page; a store that answers 400 there fails the pass closed.
test('ARM (store answers 400 for a page past the end): the pass fails closed, and the rehearsal says so', { timeout: TIMEOUT }, async (t) => {
  const { report } = await rehearse(t, {
    only: new Set<WooStepId>([...PREREQS, 'rehearsal-import', 'pass-complete']),
    storeFaults: { pastEnd: 'error' },
  })
  assert.deepEqual(redSteps(report), ['pass-complete'])
  assert.match(step(report, 'pass-complete').reason ?? '', /the pass ended failed, not complete/)
})

// ARM (guards). A grant, or a connector credential, in the environment of a child is refused before anything is spawned.
test('ARM (grant in the environment): a write grant is refused before a process is spawned, and nothing reaches the store', { timeout: TIMEOUT }, async (t) => {
  const holder: { fake?: FakeWooCommerce } = {}
  const hooks: WooRehearsalHooks = {
    onFakeStore: (f) => { holder.fake = f },
    tamperStepEnv: (_id, env) => { env.WC_WRITEBACK_ALLOWED_ORIGIN = 'http://127.0.0.1:1' },
  }
  const { parent, outcome, report } = await rehearse(t, { hooks })
  assert.equal(step(report, 'migrate-deploy').status, 'failed')
  assert.match(step(report, 'migrate-deploy').reason ?? '', /^GUARD: refusing to spawn: the environment carries WC_WRITEBACK_ALLOWED_ORIGIN/)
  assert.ok(report.steps.slice(1).every((s) => s.status === 'skipped'), 'everything after the failed prerequisite is skipped')
  assert.equal(holder.fake!.requests.length, 0)
  assert.equal(outcome.exitCode, WOO_IMPORT_EXIT.RED)
  assertTornDown(parent, outcome)
})

test('ARM (wrong database): a DATABASE_URL that is not the throwaway cluster is refused before a process is spawned', { timeout: TIMEOUT }, async (t) => {
  const hooks: WooRehearsalHooks = {
    tamperStepEnv: (_id, env) => { env.DATABASE_URL = 'postgresql://imsdev:x@127.0.0.1:1/onetwo3d_ims_dev' },
  }
  const { report } = await rehearse(t, { hooks })
  assert.match(step(report, 'migrate-deploy').reason ?? '', /^GUARD: refusing to run against a DATABASE_URL that is not the throwaway cluster/)
})

// ---------------------------------------------------------------------------------------------
// Refusals and the command line.
// ---------------------------------------------------------------------------------------------

test('a RAM-backed --root is refused before anything is created', async () => {
  const type = execFileSync('stat', ['-f', '-c', '%T', '/dev/shm'], { encoding: 'utf8' }).trim()
  assert.equal(type, 'tmpfs', 'precondition: /dev/shm is tmpfs on this host')
  const before = readdirSync('/dev/shm').filter((name) => name.startsWith('ims-rehearsal-'))
  const outcome = await runWooImportRehearsal({ parentDir: '/dev/shm', log: () => undefined })
  assert.equal(outcome.exitCode, WOO_IMPORT_EXIT.REFUSED)
  assert.equal(outcome.report, null)
  assert.match(outcome.refusal ?? '', /tmpfs/)
  assert.deepEqual(readdirSync('/dev/shm').filter((name) => name.startsWith('ims-rehearsal-')), before)
})

test('parseWooImportArgs', () => {
  assert.deepEqual(parseWooImportArgs([]), { help: false })
  assert.deepEqual(parseWooImportArgs(['--root', '/x', '--report-dir', '/y']), { help: false, root: '/x', reportDir: '/y' })
  assert.deepEqual(parseWooImportArgs(['--help']), { help: true })
  assert.deepEqual(parseWooImportArgs(['--root']), { error: '--root needs a value' })
  assert.deepEqual(parseWooImportArgs(['--bogus']), { error: 'unknown argument --bogus' })
})

// ---------------------------------------------------------------------------------------------
// Review round 1.
// ---------------------------------------------------------------------------------------------

// FAILING-FIRST (finding 1). MUTATION: put the old carve-out back (exclude an order that has a retry row from `missing` in assessR9) and this goes green.
test('ARM (no USD rate): the USD order cannot import, R9 is RED for the missing order, the retry row is reported as a recovery fact, and the verdict is RED', { timeout: TIMEOUT }, async (t) => {
  const { outcome, report } = await rehearse(t, {
    only: new Set<WooStepId>([...PREREQS, 'rehearsal-import', 'pass-complete', 'r9-orders']),
    seedUsdRate: false,
  })
  console.log(`precondition: pass errors=${JSON.stringify(report.tallies.errorsFirstPass)} missing=${JSON.stringify(report.r9!.missing)} withRetryRow=${JSON.stringify(report.r9!.missingWithRetryRow)}`)
  assert.deepEqual(report.r9!.missing, [5010])
  assert.deepEqual(report.r9!.missingWithRetryRow, [5010], 'the recovery fact: a durable retry row exists')
  assert.deepEqual(redSteps(report), ['pass-complete', 'r9-orders'])
  assert.match(step(report, 'r9-orders').reason ?? '', /not in IMS: 5010 \(durable retry row recorded for 1, none for 0; a real pass would stamp completion over them\)/)
  assert.equal(report.orders.find((o) => o.externalOrderId === 5010)!.retryRecorded, true)
  assert.ok(report.findings.some((f) => f.code === 'pass-complete-with-orders-that-did-not-import'))
  assert.equal(report.verdict, 'RED')
  assert.equal(outcome.exitCode, WOO_IMPORT_EXIT.RED)
})

// MUTATION (finding 2): drop the `expectedToAllocateStillShort` failure in assessStillShort, or let short-after-landing look only at ON_HOLD.
test('ARM (PROCESSING order left short): an order of an allocating status that stays short after the stock landed is RED in short-after-landing', { timeout: TIMEOUT }, async (t) => {
  const { report } = await rehearse(t, {
    only: new Set<WooStepId>([...PREREQS, 'rehearsal-import', 'short-after-landing']),
  })
  // Without the landing step nothing has been topped up, so the bulk PROCESSING orders are still short: the step must say so.
  assert.deepEqual(redSteps(report), ['short-after-landing'])
  const reason = step(report, 'short-after-landing').reason ?? ''
  console.log(`precondition: ${reason.slice(0, 160)}`)
  assert.match(reason, /order\(s\) of a status expected to allocate are still short after stock landed: .*\(PROCESSING\)/)
  assert.ok(report.stillShortAfterLanding!.expectedToAllocate.length > 20)
})

// MUTATION (medium): make the deployment step return passed when no reader is given.
test('DEPLOYMENT STATUSES: not given is NOT CHECKED (never a pass); given and equal to the decision passes; given and the default or absent fails the run', { timeout: TIMEOUT }, async (t) => {
  const only = new Set<WooStepId>([...PREREQS, 'deployment-statuses'])
  const none = await rehearse(t, { only })
  assert.equal(step(none.report, 'deployment-statuses').status, 'skipped')
  assert.equal(none.report.deployment.state, 'not-checked')
  assert.deepEqual(redSteps(none.report), [], 'not checked does not make the run red, and it is not a pass')

  const good = await rehearse(t, { only, deploymentStatuses: { read: async () => JSON.stringify(['processing', 'pending', 'on-hold']) } })
  assert.equal(step(good.report, 'deployment-statuses').status, 'passed')
  assert.equal(good.report.deployment.state, 'passed')

  for (const raw of [null, JSON.stringify(['processing'])]) {
    const bad = await rehearse(t, { only, deploymentStatuses: { read: async () => raw } })
    console.log(`precondition: deployment setting ${JSON.stringify(raw)} -> ${bad.report.deployment.state}: ${bad.report.deployment.reason.slice(0, 100)}`)
    assert.deepEqual(redSteps(bad.report), ['deployment-statuses'])
    assert.equal(bad.report.deployment.state, 'failed')
    assert.deepEqual(bad.report.deployment.resolved, ['processing'])
  }
})

test('readDeploymentStatusSetting reads the one settings row over a real connection (value, and null when absent) and writes nothing', { timeout: TIMEOUT }, async (t) => {
  const parent = scratchParent(t)
  const port = await freePort()
  const cluster = startCluster(parent, 'dep', port, '127.0.0.1')
  t.after(() => cluster.stop())
  cluster.psql(['-c', "create role depr login password 'dep-pass-1'"])
  cluster.psql(['-c', 'create database depdb owner depr'])
  const url = `postgresql://depr:dep-pass-1@127.0.0.1:${port}/depdb`
  cluster.psql(['-c', 'create table settings (key text primary key, value text not null)'], { database: 'depdb' })
  cluster.psql(['-c', 'alter table settings owner to depr'], { database: 'depdb' })
  assert.equal(await readDeploymentStatusSetting(url), null, 'absent row')
  cluster.psql(['-c', `insert into settings values ('wc_sync_order_statuses', '["processing","pending"]'), ('other', 'x')`], { database: 'depdb' })
  const before = cluster.psql(['-c', 'select count(*) || md5(string_agg(key || value, \',\' order by key)) from settings'], { database: 'depdb' })
  assert.equal(await readDeploymentStatusSetting(url), '["processing","pending"]')
  const after = cluster.psql(['-c', 'select count(*) || md5(string_agg(key || value, \',\' order by key)) from settings'], { database: 'depdb' })
  assert.equal(after, before, 'the table is unchanged')

  // FAILING-FIRST (review round 2): the deployment's schema is the application's `?schema=`, not `public`.
  // MUTATION: `const schema = databaseUrlSchema(databaseUrl)` -> `const schema = 'public'` in readDeploymentStatusSetting.
  const good = '["processing","pending","on-hold"]'
  cluster.psql(['-c', `update settings set value = '${good}' where key = 'wc_sync_order_statuses'`], { database: 'depdb' })
  cluster.psql(['-c', 'create schema tenant_a authorization depr; create schema tenant_b authorization depr; create schema tenant_c authorization depr'], { database: 'depdb' })
  cluster.psql(['-c', `create table tenant_a.settings (key text primary key, value text not null); insert into tenant_a.settings values ('wc_sync_order_statuses', '["processing"]')`], { database: 'depdb' })
  cluster.psql(['-c', 'alter table tenant_a.settings owner to depr'], { database: 'depdb' })
  cluster.psql(['-c', `create table tenant_c.settings (key text primary key, value text not null)`], { database: 'depdb' })
  cluster.psql(['-c', 'alter table tenant_c.settings owner to depr'], { database: 'depdb' })
  console.log(`precondition: public says ${good}; tenant_a says ["processing"]; tenant_b has no settings table; tenant_c has the table and no row`)
  assert.equal(await readDeploymentStatusSetting(url), good, 'no schema named: public')
  assert.equal(await readDeploymentStatusSetting(`${url}?schema=tenant_a`), '["processing"]', 'the named schema wins over public, which says OK')
  assert.equal(await readDeploymentStatusSetting(`${url}?schema=tenant_c`), null, 'table present, row absent: null (the default then FAILS), not public\'s value')
  await assert.rejects(readDeploymentStatusSetting(`${url}?schema=tenant_b`), /no settings table/, 'schema without the table: refused, public is not consulted')
  await assert.rejects(readDeploymentStatusSetting(`${url}?schema=no_such_schema`), /no settings table/)
  await assert.rejects(readDeploymentStatusSetting(`${url}?schema=tenant_a&options=-c%20search_path%3Dtenant_c`), /./, 'two different schemas named: refused')
  await assert.rejects(readDeploymentStatusSetting('not a url'), /could not be parsed/)
})

test('--check-deployment-statuses is parsed, and an unreadable or group-readable env file is refused (exit 2) before a cluster is created', () => {
  assert.deepEqual(parseWooImportArgs(['--check-deployment-statuses', '/x/f.env']), { help: false, checkDeploymentStatuses: '/x/f.env' })
  assert.deepEqual(parseWooImportArgs(['--check-deployment-statuses']), { error: '--check-deployment-statuses needs a value' })
  const dir = mkdtempSync(join(SCRATCH_PARENT, 'ims-woo-cli-'))
  try {
    const loose = join(dir, 'loose.env')
    writeFileSync(loose, 'DATABASE_URL=postgresql://x:y@127.0.0.1:1/z\n', { mode: 0o644 })
    chmodSync(loose, 0o644)
    const before = readdirSync(SCRATCH_PARENT).filter((n) => n.startsWith('ims-rehearsal-woo-'))
    for (const file of [loose, join(dir, 'missing.env')]) {
      let code = 0
      let stderr = ''
      try {
        execFileSync('npx', ['tsx', 'scripts/rehearse-woo-import.ts', '--check-deployment-statuses', file], { cwd: REPO_CWD, encoding: 'utf8', stdio: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: dir } as unknown as NodeJS.ProcessEnv })
      } catch (error) {
        const e = error as { status?: number; stderr?: string }
        code = e.status ?? -1
        stderr = e.stderr ?? ''
      }
      assert.equal(code, WOO_IMPORT_EXIT.REFUSED, file)
      assert.match(stderr, /Refused: --check-deployment-statuses/)
    }
    assert.deepEqual(readdirSync(SCRATCH_PARENT).filter((n) => n.startsWith('ims-rehearsal-woo-')), before, 'no run directory was created')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
