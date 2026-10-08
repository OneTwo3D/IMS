import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyPublishedReport } from '../../lib/ops/published-report.ts'
import {
  ACCEPTANCE_MAX_DAYS,
  CHECK_CATALOGUE,
  PACK_ITEMS,
  READINESS_GATE_EXIT_CODES,
  REHEARSAL_MAX_AGE_DAYS,
  readinessGateExitCode,
  type ReadinessPhase,
} from '../../lib/ops/readiness-gate-constants.ts'
import {
  assessInvariantReport,
  assessOutboundStatus,
  assessReadSyncStatus,
  assessRehearsalReport,
  buildGateReport,
  decideVerdict,
  derivePackItemFromInvariant,
  dispositionOf,
  parseAcceptanceFile,
  renderGateMarkdown,
  type CheckResult,
  type CollectedResults,
} from '../../lib/ops/readiness-gate.ts'
import {
  DAY,
  NOW,
  NO_ACCEPTANCES,
  PASS,
  PHASES,
  acceptanceText,
  allPassing,
  cleanInvariant,
  cleanOutbound,
  greenRehearsal,
  realisticResults,
  validAcceptance,
} from '../helpers/readiness-gate-fixtures.ts'

/**
 * THE VERDICT IS A PURE FUNCTION OVER TYPED CHECK RESULTS.
 *
 * Every arm below prints its precondition (how many cases it examined) and has a named mutation that turns
 * it red; the mutations are recorded in the PR. The shapes that previous rounds got wrong:
 *   - "unreadable" read as "empty" or as "pass"
 *   - a check nobody collected silently skipped
 *   - a warning waved through without a written acceptance
 *   - an old rehearsal accepted because it was GREEN once
 */

const verdictOf = (phase: ReadinessPhase, results: CollectedResults, acceptances = NO_ACCEPTANCES) => decideVerdict({ phase, results, acceptances, now: NOW })

test('baseline: every check passing is GO in every phase (the control for every NO-GO arm below)', () => {
  for (const phase of PHASES) {
    const verdict = verdictOf(phase, allPassing())
    assert.equal(verdict.verdict, 'GO', `${phase}: ${verdict.blockingReasons.join('; ')}`)
    assert.equal(verdict.exitCode, 0)
    assert.equal(verdict.rows.length, CHECK_CATALOGUE.length)
  }
  console.log(`precondition: ${PHASES.length} phases, ${CHECK_CATALOGUE.length} checks each, all GO`)
})

test('every check can independently force NO-GO, whatever the failure shape (fail, unreadable, missing) [mutation: unreadable-as-pass / missing-ignored]', () => {
  let cases = 0
  for (const phase of PHASES) {
    for (const definition of CHECK_CATALOGUE) {
      const requirement = definition.requirement[phase]
      const shapes: Array<[string, CheckResult | undefined, boolean]> = [
        ['unreadable', { kind: 'unreadable', reason: 'could not read' }, true],
        ['missing', undefined, true],
        // A failure blocks wherever the check is more than informational; a listed-only item's failure is reported, not blocking.
        ['fail', { kind: 'fail', reasons: ['bad'] }, requirement !== 'listed-only'],
        // Not available blocks only where required.
        ['not-available', { kind: 'not-available', reason: 'n/a' }, requirement === 'required'],
      ]
      for (const [shape, result, shouldBlock] of shapes) {
        const results: Record<string, CheckResult | undefined> = { ...allPassing(), [definition.id]: result }
        const verdict = verdictOf(phase, results)
        cases += 1
        if (shouldBlock) {
          assert.equal(verdict.verdict, 'NO-GO', `${phase} ${definition.id} ${shape} must be NO-GO`)
          assert.ok(verdict.blockingReasons.some((reason) => reason.startsWith(`${definition.id}:`)), `${phase} ${definition.id} ${shape}: the reason names the check`)
          assert.equal(verdict.exitCode, readinessGateExitCode('no-go'))
        } else {
          assert.equal(verdict.verdict, 'GO', `${phase} ${definition.id} ${shape} does not block here (${requirement})`)
        }
      }
    }
  }
  console.log(`precondition: ${cases} (phase x check x shape) cases examined`)
  assert.equal(cases, PHASES.length * CHECK_CATALOGUE.length * 4)
})

test('an unreadable or missing result blocks even for an informational or optional check (unknown is always NO-GO)', () => {
  for (const id of ['read-sync-liveness', 'pack-R1', 'pack-R12']) {
    for (const result of [undefined, { kind: 'unreadable', reason: 'x' } as CheckResult]) {
      const verdict = verdictOf('P0', { ...allPassing(), [id]: result })
      assert.equal(verdict.verdict, 'NO-GO', id)
    }
  }
})

test('a result for a check the gate does not define is NO-GO, not ignored', () => {
  const verdict = verdictOf('P0', { ...allPassing(), 'surprise-check': PASS })
  assert.equal(verdict.verdict, 'NO-GO')
  assert.ok(verdict.rows.some((row) => row.id === 'surprise-check' && row.status === 'UNKNOWN CHECK'))
})

test('documented optional: read-sync liveness not available does not block, present-and-failing does', () => {
  const absent = verdictOf('P1', { ...allPassing(), 'read-sync-liveness': { kind: 'not-available', reason: 'no script' } })
  assert.equal(absent.verdict, 'GO')
  assert.deepEqual(absent.notYetAvailable, ['read-sync-liveness'])
  const failing = verdictOf('P1', { ...allPassing(), 'read-sync-liveness': { kind: 'fail', reasons: ['stale'] } })
  assert.equal(failing.verdict, 'NO-GO')
})

test('R-pack slots: not available is listed and does not block P0 or P1, and is NO-GO for P2 (each slot independently)', () => {
  const real = realisticResults()
  const unavailable = PACK_ITEMS.filter((item) => real[`pack-${item.id}`]?.kind === 'not-available').map((item) => `pack-${item.id}`)
  console.log(`precondition: ${unavailable.length} pack slots are not available on this tree: ${unavailable.join(' ')}`)
  assert.ok(unavailable.length >= 10)
  for (const phase of ['P0', 'P1'] as const) {
    const verdict = verdictOf(phase, real)
    assert.equal(verdict.verdict, 'GO', phase)
    for (const id of unavailable) assert.ok(verdict.notYetAvailable.includes(id), `${phase} lists ${id}`)
  }
  assert.equal(verdictOf('P2', real).verdict, 'NO-GO')
  for (const id of unavailable) {
    const onlyThisOne = { ...allPassing(), [id]: { kind: 'not-available', reason: 'no runner' } as CheckResult }
    assert.equal(verdictOf('P2', onlyThisOne).verdict, 'NO-GO', `P2: ${id} alone forces NO-GO`)
    assert.equal(verdictOf('P0', onlyThisOne).verdict, 'GO', `P0: ${id} alone does not`)
  }
})

test('there is no way to GO with a RED rehearsal: every red shape of the report, assessed then decided, is NO-GO [mutation: stale rehearsal accepted / digest ignored]', () => {
  const redShapes: Array<[string, ReturnType<typeof greenRehearsal>, { ok: true } | { ok: false; reason: string }]> = [
    ['verdict RED', greenRehearsal({ verdict: 'RED', exitCode: 1 }), { ok: true }],
    ['exit code 3', greenRehearsal({ exitCode: 3 as never }), { ok: true }],
    ['GREEN label over a failed step', greenRehearsal({ steps: greenRehearsal().steps.map((step, i) => (i === 3 ? { ...step, status: 'failed' as const } : step)) }), { ok: true }],
    ['GREEN label over a skipped outbound step', greenRehearsal({ steps: greenRehearsal().steps.map((step) => (step.id === 'outbound-status' ? { ...step, status: 'failed' as const, required: false } : step)) }), { ok: true }],
    ['outbound step not required (pre-WP1 rehearsal)', greenRehearsal({ steps: greenRehearsal().steps.map((step) => (step.id === 'outbound-status' ? { ...step, required: false } : step)) }), { ok: true }],
    ['missing step', greenRehearsal({ steps: greenRehearsal().steps.slice(1) }), { ok: true }],
    ['duplicate step', greenRehearsal({ steps: [...greenRehearsal().steps, greenRehearsal().steps[0]!] }), { ok: true }],
    ['unknown step', greenRehearsal({ steps: [...greenRehearsal().steps, { ...greenRehearsal().steps[0]!, id: 'surprise' as never }] }), { ok: true }],
    ['incomplete teardown', greenRehearsal({ teardown: { ...greenRehearsal().teardown!, orphanPids: [42] } }), { ok: true }],
    ['no teardown', greenRehearsal({ teardown: null }), { ok: true }],
    ['interrupted', greenRehearsal({ interrupted: 'SIGTERM' }), { ok: true }],
    ['wrong tool', greenRehearsal({ tool: 'something-else' as never }), { ok: true }],
    ['wrong schema', greenRehearsal({ schemaVersion: 2 as never }), { ok: true }],
    ['stale by one day', greenRehearsal({ finishedAt: new Date(NOW.getTime() - (REHEARSAL_MAX_AGE_DAYS + 1) * DAY).toISOString() }), { ok: true }],
    ['finished in the future', greenRehearsal({ finishedAt: new Date(NOW.getTime() + 3600_000).toISOString() }), { ok: true }],
    ['no finishedAt', greenRehearsal({ finishedAt: undefined as never }), { ok: true }],
    ['digest does not verify', greenRehearsal(), { ok: false, reason: 'the Markdown does not match' }],
  ]
  for (const [label, report, digest] of redShapes) {
    const result = assessRehearsalReport({ digest, parsed: report, location: '/x/readiness-report.json' }, NOW)
    assert.notEqual(result.kind, 'pass', `${label}: the assessor must not pass it`)
    const verdict = verdictOf('P0', { ...allPassing(), 'first-install-rehearsal': result })
    assert.equal(verdict.verdict, 'NO-GO', label)
  }
  const green = assessRehearsalReport({ digest: { ok: true }, parsed: greenRehearsal(), location: '/x' }, NOW)
  assert.equal(green.kind, 'pass', 'control: the same assessor passes a GREEN, fresh, complete report')
  const edge = assessRehearsalReport({ digest: { ok: true }, parsed: greenRehearsal({ finishedAt: new Date(NOW.getTime() - REHEARSAL_MAX_AGE_DAYS * DAY + 1000).toISOString() }), location: '/x' }, NOW)
  assert.equal(edge.kind, 'pass', 'control: just inside the age limit passes')
  console.log(`precondition: ${redShapes.length} red shapes examined, plus two controls`)
})

test('a rehearsal report that is not an object is unreadable', () => {
  assert.equal(assessRehearsalReport({ digest: { ok: true }, parsed: null, location: '/x' }, NOW).kind, 'unreadable')
})

// ---------------------------------------------------------------------------------------------
// Warnings and acceptances.
// ---------------------------------------------------------------------------------------------

const WARNING_ID = 'invariant:inventory:stock_movement_value_mismatch:product=p1'
const withWarning = (id = WARNING_ID): Record<string, CheckResult> => ({ ...allPassing(), 'invariant-preflight': { kind: 'pass', summary: 'ok', warnings: [{ id, message: 'm' }] } })
const accepted = (overrides: Record<string, unknown> = {}, id = WARNING_ID) => parseAcceptanceFile(acceptanceText([validAcceptance(id, overrides)]))

test('a warning with no written acceptance is NO-GO; with a current acceptance it is GO-WITH-ACCEPTED-WARNINGS [mutation: warning without acceptance passes]', () => {
  const none = verdictOf('P0', withWarning())
  assert.equal(none.verdict, 'NO-GO')
  assert.ok(none.blockingReasons.some((reason) => reason.startsWith(WARNING_ID)))
  const ok = verdictOf('P0', withWarning(), accepted())
  assert.equal(ok.verdict, 'GO-WITH-ACCEPTED-WARNINGS')
  assert.equal(ok.exitCode, readinessGateExitCode('go-with-accepted-warnings'))
  assert.notEqual(ok.exitCode, 0, 'automation that wants a clean GO cannot mistake this for one')
  assert.equal(ok.warnings[0]!.disposition.accepted, true)
})

test('an acceptance covers exactly its warning: every other shape of acceptance leaves the warning unaccepted', () => {
  const cases: Array<[string, ReturnType<typeof parseAcceptanceFile>]> = [
    ['other id', accepted({}, 'invariant:inventory:stock_movement_value_mismatch:product=p2')],
    ['id with different case', accepted({}, WARNING_ID.toUpperCase())],
    ['prefix of the id', accepted({}, 'invariant:inventory:stock_movement_value_mismatch')],
    ['wildcard', accepted({}, 'invariant:*')],
    ['expired', accepted({ acceptedAt: new Date(NOW.getTime() - 40 * DAY).toISOString(), expiresAt: new Date(NOW.getTime() - DAY).toISOString() })],
    ['expires exactly now', accepted({ acceptedAt: new Date(NOW.getTime() - DAY).toISOString(), expiresAt: NOW.toISOString() })],
    ['not yet in effect (future acceptedAt)', accepted({ acceptedAt: new Date(NOW.getTime() + DAY).toISOString(), expiresAt: new Date(NOW.getTime() + 5 * DAY).toISOString() })],
    ['other phase', accepted({ phases: ['P1', 'P2'] })],
    ['no who', accepted({ acceptedBy: '  ' })],
    ['no why', accepted({ reason: 'short' })],
    ['expiry before acceptance', accepted({ expiresAt: new Date(NOW.getTime() - 2 * DAY).toISOString() })],
    ['expiry beyond the maximum', accepted({ expiresAt: new Date(NOW.getTime() + (ACCEPTANCE_MAX_DAYS + 5) * DAY).toISOString() })],
    ['no zone on the time', accepted({ expiresAt: '2026-12-01T00:00:00' })],
    ['empty phases', accepted({ phases: [] })],
    ['unknown phase', accepted({ phases: ['P9'] })],
    ['file with an unknown field', parseAcceptanceFile(JSON.stringify({ schemaVersion: 1, acceptances: [validAcceptance(WARNING_ID)], extra: 1 }))],
    ['entry with an unknown field', parseAcceptanceFile(acceptanceText([validAcceptance(WARNING_ID, { extra: 'x' })]))],
    ['wrong schemaVersion', parseAcceptanceFile(JSON.stringify({ schemaVersion: 2, acceptances: [validAcceptance(WARNING_ID)] }))],
    ['duplicate id (ambiguous)', parseAcceptanceFile(acceptanceText([validAcceptance(WARNING_ID), validAcceptance(WARNING_ID, { acceptedBy: 'Someone Else' })]))],
    ['not JSON', parseAcceptanceFile('{nope')],
    ['array at top level', parseAcceptanceFile('[]')],
    ['absent file', parseAcceptanceFile(null)],
  ]
  for (const [label, file] of cases) {
    const verdict = verdictOf('P0', withWarning(), file)
    assert.equal(verdict.verdict, 'NO-GO', label)
    assert.equal(verdict.warnings[0]!.disposition.accepted, false, label)
  }
  console.log(`precondition: ${cases.length} non-accepting acceptance shapes examined`)
  const control = verdictOf('P0', withWarning(), accepted())
  assert.equal(control.verdict, 'GO-WITH-ACCEPTED-WARNINGS', 'control: the valid acceptance of the same warning is accepted')
})

test('a malformed entry does not reject its neighbours; an unknown field rejects the whole file', () => {
  const file = parseAcceptanceFile(acceptanceText([validAcceptance('a', { reason: 'x' }), validAcceptance('b')]))
  assert.equal(file.status, 'ok')
  assert.equal(file.entries.length, 1)
  assert.equal(file.problems.length, 1)
  assert.equal(parseAcceptanceFile(JSON.stringify({ schemaVersion: 1, acceptances: [], oops: true })).status, 'rejected')
})

test('acceptances apply only to warnings: a failing check stays NO-GO however many warnings are accepted', () => {
  const results = { ...withWarning(), 'validate-db': { kind: 'fail', reasons: ['exit 1'], warnings: [{ id: WARNING_ID, message: 'm' }] } as CheckResult }
  const verdict = verdictOf('P0', results, accepted())
  assert.equal(verdict.verdict, 'NO-GO')
})

test('two warnings need two acceptances; one unaccepted warning is enough for NO-GO; unused acceptances are listed', () => {
  const results = { ...allPassing(), 'invariant-preflight': { kind: 'pass', summary: 'ok', warnings: [{ id: 'w1', message: '' }, { id: 'w2', message: '' }] } as CheckResult }
  const one = verdictOf('P0', results, parseAcceptanceFile(acceptanceText([validAcceptance('w1'), validAcceptance('stale-id')])))
  assert.equal(one.verdict, 'NO-GO')
  assert.deepEqual(one.unusedAcceptances, ['stale-id'])
  const both = verdictOf('P0', results, parseAcceptanceFile(acceptanceText([validAcceptance('w1'), validAcceptance('w2')])))
  assert.equal(both.verdict, 'GO-WITH-ACCEPTED-WARNINGS')
})

test('dispositionOf names why a warning is not accepted', () => {
  const d = dispositionOf({ id: WARNING_ID, message: '' }, accepted({ phases: ['P2'] }), 'P0', NOW)
  assert.equal(d.accepted, false)
  assert.match((d as { why: string }).why, /does not cover phase P0/)
})

// ---------------------------------------------------------------------------------------------
// Assessors.
// ---------------------------------------------------------------------------------------------

test('outbound status per phase: held at P0/P1; exactly the declared writers at P2', () => {
  const grant = (...names: string[]) => cleanOutbound({
    connectors: ['woocommerce', 'mintsoft', 'xero'].map((connector) => ({ connector, state: names.includes(connector) ? 'granted' : 'held' })),
    anyGranted: names.length > 0,
  })
  const cases: Array<[ReadinessPhase, ReturnType<typeof grant>, string[] | null, 'pass' | 'fail' | 'unreadable']> = [
    ['P0', grant(), null, 'pass'],
    ['P1', grant(), null, 'pass'],
    ['P0', grant('woocommerce'), null, 'fail'],
    ['P1', grant('xero'), null, 'fail'],
    ['P2', grant('woocommerce'), ['woocommerce'], 'pass'],
    ['P2', grant('woocommerce', 'mintsoft'), ['mintsoft', 'woocommerce'], 'pass'],
    ['P2', grant(), [], 'pass'],
    ['P2', grant('woocommerce', 'mintsoft'), ['woocommerce'], 'fail'],
    ['P2', grant('woocommerce'), ['woocommerce', 'mintsoft'], 'fail'],
    ['P2', grant('xero'), ['woocommerce'], 'fail'],
    ['P2', grant('woocommerce'), null, 'fail'],
    ['P2', grant(), ['nonsense'], 'fail'],
    ['P0', cleanOutbound({ connectors: [{ connector: 'woocommerce', state: 'held' }, { connector: 'mintsoft', state: 'held' }] }), null, 'fail'],
    ['P0', cleanOutbound({ connectors: [...cleanOutbound().connectors, { connector: 'xero', state: 'held' }] }), null, 'fail'],
    ['P0', cleanOutbound({ connectors: [...cleanOutbound().connectors, { connector: 'qb', state: 'held' }] }), null, 'fail'],
    ['P0', cleanOutbound({ connectors: cleanOutbound().connectors.map((c) => (c.connector === 'xero' ? { ...c, state: 'unreadable' } : c)), anyUnreadable: true }), null, 'fail'],
    ['P0', cleanOutbound({ connectors: cleanOutbound().connectors.map((c) => (c.connector === 'xero' ? { ...c, state: 'what' } : c)) }), null, 'fail'],
    ['P0', cleanOutbound({ countsAvailable: false }), null, 'unreadable'],
  ]
  for (const [phase, evidence, expect, want] of cases) {
    assert.equal(assessOutboundStatus(evidence, phase, expect).kind, want, `${phase} ${JSON.stringify(expect)} ${JSON.stringify(evidence.connectors.map((c) => c.state))}`)
  }
  console.log(`precondition: ${cases.length} outbound cases examined`)
})

test('invariant report: complete and clean passes; every other shape fails; warnings are enumerated one by one', () => {
  const warn = (code: string, productId: string) => ({ severity: 'warning', code, productId, warehouseId: 'w1', message: `${code} ${productId}` })
  assert.equal(assessInvariantReport(cleanInvariant()).kind, 'pass')
  const withWarnings = assessInvariantReport(cleanInvariant({ inventory: [warn('stock_movement_value_mismatch', 'p1'), warn('stock_movement_value_mismatch', 'p2'), warn('transfer_stranded_in_transit', 'p1')] }))
  assert.equal(withWarnings.kind, 'pass')
  assert.deepEqual(withWarnings.kind === 'pass' ? withWarnings.warnings?.map((w) => w.id) : null, [
    'invariant:inventory:stock_movement_value_mismatch:product=p1,warehouse=w1',
    'invariant:inventory:stock_movement_value_mismatch:product=p2,warehouse=w1',
    'invariant:inventory:transfer_stranded_in_transit:product=p1,warehouse=w1',
  ])
  const crit = { severity: 'critical', code: 'stock_negative_quantity', productId: 'p1', message: 'neg' }
  const bad: Array<[string, ReturnType<typeof cleanInvariant>]> = [
    ['critical finding', cleanInvariant({ inventory: [crit] })],
    ['status not completed', cleanInvariant({ status: 'partial_failure' })],
    ['report errored', cleanInvariant({ errors: [{ domain: 'sales', message: 'x' }] })],
    ['preflight not ok', cleanInvariant({ ok: false })],
    ['inventory report truncated flag', cleanInvariant({ truncated: true })],
    ['truncated sentinel finding', cleanInvariant({ inventory: [{ severity: 'critical', code: 'invariant_report_truncated', message: 'x' }] })],
    // Isolating arm: the sentinel code is refused on its own, even if it were labelled a warning (the critical-severity rule cannot be what catches it).
    ['truncated sentinel finding labelled warning', cleanInvariant({ inventory: [{ severity: 'warning', code: 'invariant_report_truncated', message: 'x' }] })],
    ['inventory report absent', cleanInvariant({ nullReport: 'inventory' })],
    ['accounting report absent', cleanInvariant({ nullReport: 'accounting' })],
    ['sales report absent', cleanInvariant({ nullReport: 'sales' })],
    ['unknown severity', cleanInvariant({ accounting: [{ severity: 'fatal', code: 'x', message: 'x' }] })],
  ]
  for (const [label, evidence] of bad) assert.equal(assessInvariantReport(evidence).kind, 'fail', label)
  // Warnings that exist in the summary but are not listed cannot be individually accepted.
  const hidden = cleanInvariant({ inventory: [warn('stock_movement_value_mismatch', 'p1')] })
  hidden.result.summary.total.warning = 3
  assert.equal(assessInvariantReport(hidden).kind, 'fail', 'summary counts 3 warnings, 1 listed')
  console.log(`precondition: ${bad.length + 1} bad invariant shapes examined`)
})

test('pack items R3, R4 and R15 are read from the same invariant report', () => {
  const evidence = cleanInvariant()
  const invariantPass = assessInvariantReport(evidence)
  for (const item of ['R3', 'R4', 'R15'] as const) assert.equal(derivePackItemFromInvariant(item, evidence, invariantPass).kind, 'pass', item)
  const r3 = cleanInvariant({ inventory: [{ severity: 'warning', code: 'stock_cost_layer_quantity_mismatch', productId: 'p1', message: 'm' }] })
  assert.equal(derivePackItemFromInvariant('R3', r3, assessInvariantReport(r3)).kind, 'fail')
  assert.equal(derivePackItemFromInvariant('R4', r3, assessInvariantReport(r3)).kind, 'pass', 'R4 is unaffected by an R3 finding')
  const r4 = cleanInvariant({ inventory: [{ severity: 'critical', code: 'stock_reserved_source_mismatch', productId: 'p1', message: 'm' }] })
  assert.equal(derivePackItemFromInvariant('R4', r4, assessInvariantReport(r4)).kind, 'fail')
  assert.equal(derivePackItemFromInvariant('R15', r4, assessInvariantReport(r4)).kind, 'fail')
  assert.equal(derivePackItemFromInvariant('R3', null, { kind: 'unreadable', reason: 'x' }).kind, 'unreadable')
  assert.equal(derivePackItemFromInvariant('R15', null, { kind: 'unreadable', reason: 'x' }).kind, 'unreadable')
  const truncated = cleanInvariant({ truncated: true })
  assert.equal(derivePackItemFromInvariant('R3', truncated, assessInvariantReport(truncated)).kind, 'unreadable', 'a truncated report cannot establish R3')
})

test('read-sync status: strict contract; empty or malformed is unreadable, a stale stream fails', () => {
  const run = (stdout: string, exitCode: number | null = 0) => assessReadSyncStatus({ exitCode, stdout })
  const fresh = (name: string) => ({ stream: name, state: 'fresh', lastSuccessAt: '2026-10-08T11:00:00Z' })
  assert.equal(run(JSON.stringify({ streams: [fresh('wc'), fresh('xero')] })).kind, 'pass')
  assert.equal(run(JSON.stringify({ streams: [fresh('wc'), { stream: 'xero', state: 'stale', lastSuccessAt: null }] })).kind, 'fail')
  for (const [label, out, code] of [
    ['empty streams', JSON.stringify({ streams: [] }), 0],
    ['not json', 'banner\n{}', 0],
    ['no streams key', '{}', 0],
    ['exit 1', JSON.stringify({ streams: [fresh('wc')] }), 1],
    ['exit null', JSON.stringify({ streams: [fresh('wc')] }), null],
    ['duplicate stream', JSON.stringify({ streams: [fresh('wc'), fresh('wc')] }), 0],
    ['unnamed stream', JSON.stringify({ streams: [{ state: 'fresh' }] }), 0],
  ] as const) {
    assert.equal(run(out, code).kind, 'unreadable', label)
  }
})

// ---------------------------------------------------------------------------------------------
// Exit codes and reports.
// ---------------------------------------------------------------------------------------------

test('exit codes are unique, 0 is only GO, and every verdict maps into the table', () => {
  assert.equal(new Set(READINESS_GATE_EXIT_CODES.map((row) => row.code)).size, READINESS_GATE_EXIT_CODES.length)
  assert.equal(READINESS_GATE_EXIT_CODES.filter((row) => row.code === 0).length, 1)
  assert.equal(READINESS_GATE_EXIT_CODES.find((row) => row.code === 0)!.name, 'go')
  assert.equal(verdictOf('P0', allPassing()).exitCode, 0)
  assert.equal(verdictOf('P0', {}).exitCode, 1, 'nothing collected at all is NO-GO')
  assert.equal(verdictOf('P0', {}).rows.every((row) => row.status === 'MISSING'), true)
})

test('the report states what a GO does and does not cover, and lists NOT YET AVAILABLE items', () => {
  const verdict = verdictOf('P1', realisticResults())
  const report = buildGateReport({ runId: 'r1', now: NOW, phase: 'P1', expectGranted: null, verdict, acceptances: NO_ACCEPTANCES, acceptancePath: null })
  const md = renderGateMarkdown(report)
  assert.match(md, /^# Readiness gate: GO \(P1\)/)
  assert.match(md, /NOT YET AVAILABLE/)
  assert.match(md, /listed as NOT YET AVAILABLE were not checked at all/)
  for (const id of verdict.notYetAvailable) assert.ok(md.includes(id.replace('pack-', '')), `the Markdown lists ${id}`)
  const noGo = renderGateMarkdown(buildGateReport({ runId: 'r2', now: NOW, phase: 'P0', expectGranted: null, verdict: verdictOf('P0', {}), acceptances: NO_ACCEPTANCES, acceptancePath: null }))
  assert.match(noGo, /^# Readiness gate: NO-GO/)
  assert.match(noGo, /## Why NO-GO/)
  // The word GO must not describe a NO-GO report.
  assert.doesNotMatch(noGo.split('\n').slice(0, 3).join('\n'), /: GO/)
  void verifyPublishedReport
})
