import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  ACCOUNTING_FOLLOW_UP_RECOVERY,
  CONNECTORS_WITHOUT_FOLLOW_UP_CONSUMER,
  FOLLOW_UP_OBLIGATION_AGE_COLUMNS,
  buildFollowUpObligationBacklogWhere,
  followUpObligationRecoveryFor,
} from '@/lib/domain/accounting/follow-up-obligation-registry'

// ---------------------------------------------------------------------------
// o3d-0bfh r6 (Codex MEDIUM) — "{ consumer: 'sweep' }" IS AN ORDINARY LITERAL, SO REQUIRING IT
// PREVENTS OMISSION AND NOTHING ELSE.
//
// r5 made `releaseFollowUpObligation` demand a recovery declaration from its caller, and the round
// that landed it called the defect unrepresentable. It is not. The declaration was a copyable object
// with no relationship to a registered sweep, an exported binding or a cron invocation: a new
// connector could paste Xero's `{ consumer: 'sweep' }`, have no consumer whatsoever, and compile —
// which is exactly the state QuickBooks was in for three rounds while its log lines promised a sweep.
//
// THE DECLARATION IS NOW A REGISTRY ENTRY, AND THIS IS WHAT MAKES THAT WORTH ANYTHING. Every
// `consumer: 'sweep'` entry must have BOTH:
//
//   • a sweep binding EXPORTED by that connector's module, and
//   • a SCHEDULED OR MANUAL INVOCATION of that export — a cron route or a server action.
//
// Both halves, because a binding nothing calls is exactly as dead as no binding: the marker is
// retained, no candidate query ever selects it, and the operator is told a sweep will re-enqueue the
// payment. Checking only the export would have passed a connector whose sweep is never invoked,
// which is the same silence in a different place.
//
// And the literal itself is BANNED outside the registry, so the copy route Codex described does not
// have a second entrance. Without that ban a connector could keep writing the literal inline and
// never appear in the registry at all — the checks above would have nothing to test.
//
// ---------------------------------------------------------------------------
// r7 (Codex MEDIUM) — WHAT THE INVOCATION CHECK PROVES, EXACTLY.
//
// r6's version accepted any `${binding}(` substring anywhere in a cron route or server action. A
// commented-out call, a call inside a string, a call to a same-named local dummy, or a call in a
// file that is not an entry point all satisfied that. It is a SYNTACTIC check and it is still a
// syntactic check; what r7 does is close the routes by which the syntax can be true while the
// runtime path is absent, and then say plainly where the line is.
//
// FOR EVERY `consumer: 'sweep'` CONNECTOR THIS FILE NOW PROVES, and this list is exhaustive:
//
//   1. the connector's module EXPORTS a sweep binding, and it is callable (a real function, loaded
//      by a real import — not a name found in text);
//   2. some file under app/api/cron or app/actions CALLS that binding from EXECUTABLE source —
//      comments and string literals are removed before the match, so a commented-out or quoted call
//      no longer counts;
//   3. that same file IMPORTS the binding FROM THAT CONNECTOR'S OWN MODULE (static or dynamic), so
//      the call cannot be to a same-named local stub;
//   4. that file is a real ENTRY POINT — a route module exporting GET/POST, or a 'use server'
//      action module — so the call is not sitting in a helper nothing routes to;
//   5. a named BEHAVIOURAL test exists for the connector, it drives the real entry point, and it
//      names the binding. That test is what actually executes the path.
//
// WHAT IT STILL DOES NOT PROVE: that the call is on a branch reached under production conditions.
// Nothing short of running the entry point proves that, which is why (5) requires a test that does —
// tests/cron/accounting-sync-backreference-sweep.test.ts imports the cron route's GET, invokes it,
// and asserts the sweep ran. The registry check's job is to make sure a NEWLY declared connector
// cannot reach `consumer: 'sweep'` without such a test existing at all; the test's job is to prove
// reachability. Neither alone is the guarantee, and this comment is the honest statement of that.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..')

/**
 * Where each registered connector's sweep binding would live, and where an invocation would come
 * from. Held HERE rather than in the registry so a new connector cannot satisfy the test by
 * declaring its own module — the map is asserted to cover every registry key, so adding a connector
 * without adding it here fails.
 */
const CONNECTOR_MODULES: Record<string, string> = {
  xero: '@/lib/connectors/xero/sync-processor',
  quickbooks: '@/lib/connectors/quickbooks/sync-processor',
}

/**
 * The BEHAVIOURAL test that actually drives each sweep connector's entry point. Held here, like
 * CONNECTOR_MODULES, so a new connector cannot satisfy the registry by pointing at its own file; the
 * map is asserted to cover every `consumer: 'sweep'` key.
 */
const SWEEP_BEHAVIOURAL_TESTS: Record<string, { test: string; entryPoint: string }> = {
  xero: {
    test: 'tests/cron/accounting-sync-backreference-sweep.test.ts',
    entryPoint: '@/app/api/cron/accounting-sync/route',
  },
}

/** A sweep binding, by the naming convention both connectors follow. */
const SWEEP_BINDING_NAME = /^repair[A-Za-z]*BackReferences?$/

/**
 * Split a TypeScript source into what a compiler would keep and what it would throw away.
 *
 * `code` has COMMENTS removed and string literals intact (module specifiers are strings, and the
 * import check needs them). `executable` also has the CONTENTS of string literals removed, so a call
 * quoted inside a string cannot satisfy an invocation check. One scanner produces both, because a
 * comment-stripper that does not know about strings truncates every line holding a `//` in a URL.
 */
function partitionSource(text: string): { code: string; executable: string } {
  let code = ''
  let executable = ''
  let i = 0
  while (i < text.length) {
    const two = text.slice(i, i + 2)
    if (two === '//') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (two === '/*') {
      i += 2
      while (i < text.length && text.slice(i, i + 2) !== '*/') i++
      i += 2
      continue
    }
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      let literal = ch
      i++
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') { literal += text[i]; i++ }
        if (i < text.length) { literal += text[i]; i++ }
      }
      literal += quote
      i++
      code += literal
      executable += quote + quote
      continue
    }
    code += ch
    executable += ch
    i++
  }
  return { code, executable }
}

type Source = { rel: string; text: string; code: string; executable: string }

function readSource(full: string): Source {
  const text = readFileSync(full, 'utf8')
  return { rel: path.relative(REPO_ROOT, full), text, ...partitionSource(text) }
}

/** Scheduled (cron route) and manual (server action) entry points — where an invocation must be. */
function invocationSources(): Source[] {
  const found: Source[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!full.endsWith('.ts')) continue
      found.push(readSource(full))
    }
  }
  walk(path.join(REPO_ROOT, 'app', 'api', 'cron'))
  walk(path.join(REPO_ROOT, 'app', 'actions'))
  return found
}

const INVOCATION_SOURCES = invocationSources()

/** Does this file import `binding` from `module` — statically, or as a dynamic `await import`? */
function importsBindingFrom(code: string, binding: string, module: string): boolean {
  const spec = module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const name = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const staticImport = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"\`]${spec}['"\`]`)
  const dynamicImport = new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*await\\s+import\\(\\s*['"\`]${spec}['"\`]`)
  return staticImport.test(code) || dynamicImport.test(code)
}

/**
 * Is this file something the framework can actually route to? A cron route module exports GET or
 * POST; a server-action module is marked 'use server'. A call in neither is a call in a helper.
 */
function isEntryPoint(source: Source): boolean {
  if (/^\s*['"]use server['"]/m.test(source.text)) return true
  return /export\s+(?:async\s+)?function\s+(GET|POST)\b/.test(source.executable)
    || /export\s+const\s+(GET|POST)\b/.test(source.executable)
}

test('[o3d-0bfh r6] every connector that claims a follow-up obligation is declared in the registry', () => {
  // The map below is the test's own knowledge of where a connector lives. If it does not cover a
  // registry key, every assertion about that key would silently be skipped.
  for (const connector of Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY)) {
    assert.ok(
      CONNECTOR_MODULES[connector],
      `${connector} is declared in ACCOUNTING_FOLLOW_UP_RECOVERY but this test does not know where its module `
        + 'is, so nothing below checks it. Add it to CONNECTOR_MODULES.',
    )
  }
  assert.ok(INVOCATION_SOURCES.length > 0, 'the invocation scan must actually reach some sources')
})

test("[o3d-0bfh r6] a consumer: 'sweep' declaration has a real binding AND a real invocation", async () => {
  const sweepConnectors = Object.entries(ACCOUNTING_FOLLOW_UP_RECOVERY)
    .filter(([, recovery]) => recovery.consumer === 'sweep')
    .map(([connector]) => connector)
  assert.ok(sweepConnectors.length > 0, 'at least one connector must declare a sweep, or this test asserts nothing')

  for (const connector of sweepConnectors) {
    const mod = await import(CONNECTOR_MODULES[connector]) as Record<string, unknown>
    const bindings = Object.keys(mod).filter((name) => SWEEP_BINDING_NAME.test(name))
    assert.ok(
      bindings.length > 0,
      `${connector} declares consumer: 'sweep', so ${CONNECTOR_MODULES[connector]} must EXPORT a back-reference `
        + 'repair sweep. Declaring one without a binding is how a connector comes to tell operators that a '
        + 'payment will be re-enqueued by something that does not exist.',
    )
    for (const name of bindings) {
      assert.equal(typeof mod[name], 'function', `${connector}'s ${name} must be callable`)
    }
    // (2) an invocation in EXECUTABLE source — comments and string contents removed first, so a
    // commented-out or quoted call no longer counts; (3) from a file that imports the binding from
    // THIS connector's module, so it cannot be a same-named local stub; (4) in a real entry point.
    const callers = INVOCATION_SOURCES.filter((source) => bindings.some((name) => (
      source.executable.includes(`${name}(`)
      && importsBindingFrom(source.code, name, CONNECTOR_MODULES[connector])
      && isEntryPoint(source)
    )))
    assert.ok(
      callers.length > 0,
      `${connector} exports ${bindings.join(', ')} but NOTHING under app/api/cron or app/actions calls it from `
        + 'executable code, importing it from ' + CONNECTOR_MODULES[connector] + ', inside a routable entry point. '
        + 'A binding nothing invokes is exactly as dead as no binding: the marker is retained, no candidate query '
        + 'ever selects it, and the operator is told a sweep will re-enqueue the work.',
    )

    // (5) AND A TEST THAT ACTUALLY DRIVES IT. Everything above is text about code; this is the
    // requirement that somebody has executed the path. The registry cannot prove reachability — see
    // the header — so what it enforces is that a connector cannot declare a sweep without a
    // behavioural test of its entry point existing.
    const behavioural = SWEEP_BEHAVIOURAL_TESTS[connector]
    assert.ok(
      behavioural,
      `${connector} declares consumer: 'sweep' but SWEEP_BEHAVIOURAL_TESTS names no test that drives its entry `
        + 'point. Text checks cannot prove the call is reached; add the test and name it here.',
    )
    const proof = readSource(path.join(REPO_ROOT, behavioural.test))
    assert.ok(
      proof.code.includes(behavioural.entryPoint),
      `${behavioural.test} must import the real entry point ${behavioural.entryPoint} — a test of the sweep `
        + 'function alone proves the function works, not that anything calls it.',
    )
    assert.ok(
      bindings.some((name) => proof.executable.includes(name)),
      `${behavioural.test} must name ${bindings.join(', ')}, or it is not evidence about this binding.`,
    )
  }
})

test("[o3d-0bfh r6] a consumer: 'none' declaration has neither, and says why and what to do instead", async () => {
  assert.deepEqual(
    [...CONNECTORS_WITHOUT_FOLLOW_UP_CONSUMER],
    ['quickbooks'],
    'the backlog population is derived from the registry — if this changes, the exception inbox changes with it',
  )
  for (const connector of CONNECTORS_WITHOUT_FOLLOW_UP_CONSUMER) {
    const recovery = followUpObligationRecoveryFor(connector)
    assert.equal(recovery.consumer, 'none')
    if (recovery.consumer !== 'none') return
    assert.ok(recovery.blockedBy.length > 20, 'it must say WHY nothing re-drives it')
    assert.ok(recovery.operatorRemedy.length > 20, 'and what a human must do instead')
    // The remedy must point somewhere an operator can actually look. Before this round it said
    // "find the row by its non-null backReferenceFollowUpsPendingAt", which is a database query.
    assert.match(
      recovery.operatorRemedy,
      /exception inbox|\/sync\/exceptions/i,
      'the remedy must name the operational backlog, not a column an operator cannot query',
    )
    assert.match(recovery.blockedBy, /o3d-8prh/, 'and name the REAL blocker, not the closed realm-isolation issue')

    const mod = await import(CONNECTOR_MODULES[connector]) as Record<string, unknown>
    const bindings = Object.keys(mod).filter((name) => SWEEP_BINDING_NAME.test(name))
    assert.deepEqual(
      bindings,
      [],
      `${connector} declares consumer: 'none' but exports a sweep binding — the declaration and the code have `
        + 'drifted, and the operator is being told to act by hand on work something is doing automatically.',
    )
    const callers = INVOCATION_SOURCES
      .filter(({ executable }) => /repair[A-Za-z]*BackReferences?\(/.test(executable) && new RegExp(connector, 'i').test(executable))
      .map(({ rel }) => rel)
    for (const rel of callers) {
      const source = INVOCATION_SOURCES.find((entry) => entry.rel === rel)
      assert.ok(source)
      // A file may legitimately mention both connectors (the accounting-sync cron dispatches to
      // either). What must not appear is a sweep call inside this connector's own branch, which is
      // what tests/cron/accounting-sync-backreference-sweep.test.ts and
      // tests/connectors/quickbooks-manual-sync-repairs.test.ts assert behaviourally.
      assert.ok(source.executable.includes('repairXeroBackReferences('), `${rel} calls a sweep — check whose`)
    }
  }
})

test('[o3d-0bfh r6] the sweep literal exists ONLY in the registry, so it cannot be copied into a connector', () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'generated') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.tsx?$/.test(full)) continue
      const rel = path.relative(REPO_ROOT, full)
      if (rel.startsWith('tests/')) continue
      if (rel === path.join('lib', 'domain', 'accounting', 'follow-up-obligation-registry.ts')) continue
      const text = readFileSync(full, 'utf8')
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        if (!/consumer:\s*'sweep'/.test(line)) return
        // Exempt, and both exemptions are narrow:
        //   • a union MEMBER in back-reference.ts (`| { consumer: 'sweep' }`) is the type that makes
        //     the registry's entry check at all, not a value anyone can pass;
        //   • a COMMENT naming the literal is how this rule is explained at the sites that used to
        //     hold one. Forbidding the string in prose would be answered by deleting the warning.
        if (/^\s*\|/.test(line)) return
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        offenders.push(`${rel}:${index + 1}: ${line.trim()}`)
      })
    }
  }
  walk(path.join(REPO_ROOT, 'lib'))
  walk(path.join(REPO_ROOT, 'app'))
  assert.deepEqual(
    offenders,
    [],
    "a connector wrote { consumer: 'sweep' } inline instead of reading its registry entry. That literal is the "
      + 'defect Codex named: it compiles whether or not a sweep exists, and a connector that never appears in the '
      + 'registry is never checked for a binding or an invocation:\n' + offenders.join('\n'),
  )
})

test('[o3d-0bfh r6] an UNDECLARED connector fails safe — it never inherits the sweep answer', () => {
  // The dangerous default is the reassuring one. A connector nobody has decided about must not be
  // told that a sweep will re-drive its work; it must say that nothing is known to.
  const unknown = followUpObligationRecoveryFor('sage')
  assert.equal(unknown.consumer, 'none')
  if (unknown.consumer !== 'none') return
  assert.match(unknown.blockedBy, /sage/, 'and it names the connector it could not find')
})

type BacklogWhere = {
  connector: { in: string[] }
  status: { in: string[] }
  backReferenceFollowUpsPendingAt: Record<string, unknown>
  OR: Array<Record<string, unknown>>
}

test('[o3d-0bfh r6] the backlog query selects exactly the connectors with no consumer', () => {
  const where = buildFollowUpObligationBacklogWhere() as BacklogWhere
  assert.deepEqual(where.connector.in, ['quickbooks'], 'derived from the registry, not restated')
  assert.ok(!where.connector.in.includes('xero'), 'a connector WITH a sweep must not be listed as unrecoverable')
  // SYNCED and FAILED only: a PENDING or stale PROCESSING row is still on the processor's own ladder,
  // and listing it would be self-resolving noise that trains an operator to ignore the section.
  assert.deepEqual(where.status.in, ['SYNCED', 'FAILED'])
  assert.deepEqual(where.backReferenceFollowUpsPendingAt, { not: null })
})

test('[o3d-0bfh r7] the backlog asks the MARKER only whether it is null, and measures age on real times', () => {
  // The r6 defect in one assertion. `backReferenceFollowUpsPendingAt` is a generation minted as
  // max(now, observed + 1ms), so under contention it is ahead of every clock; comparing it to one
  // hid stranded obligations for longer than the grace, by an amount that grew with contention.
  const where = buildFollowUpObligationBacklogWhere() as BacklogWhere
  for (const op of ['lt', 'lte', 'gt', 'gte']) {
    assert.ok(
      !(op in where.backReferenceFollowUpsPendingAt),
      `the backlog compared the obligation GENERATION with "${op}". It is an ordering token, not a time — see the `
        + '"WHAT backReferenceFollowUpsPendingAt IS, AND WHAT IT IS NOT" block in the registry.',
    )
  }
  // And the grace is measured on columns that ARE times, one branch per row shape.
  const branches = where.OR.map((clause) => Object.keys(clause).sort().join('+'))
  assert.deepEqual(branches, ['syncedAt', 'createdAt+syncedAt'])
  for (const column of FOLLOW_UP_OBLIGATION_AGE_COLUMNS) {
    assert.ok(
      where.OR.some((clause) => column in clause),
      `${column} is a declared age column but the backlog does not measure on it`,
    )
  }
  const grace = 5 * 60 * 1000
  const now = new Date('2026-08-27T12:00:00.000Z')
  const built = buildFollowUpObligationBacklogWhere({ now, settlingGraceMs: grace }) as BacklogWhere
  assert.equal(
    ((built.OR[0] as { syncedAt: { lt: Date } }).syncedAt.lt).getTime(),
    now.getTime() - grace,
    'the cutoff is now minus the grace, applied to a real completion time',
  )
})

/**
 * The rule the registry's header states, made enforceable: NOTHING outside the claim/release
 * protocol may range-compare the obligation marker. Extracts the marker property's own VALUE (the
 * balanced brace region, or the rest of the property) so a neighbouring predicate's `lt` cannot be
 * mistaken for one on the marker.
 */
function markerRangeComparisons(code: string): string[] {
  const found: string[] = []
  const needle = 'backReferenceFollowUpsPendingAt:'
  let at = code.indexOf(needle)
  while (at !== -1) {
    let i = at + needle.length
    while (i < code.length && /\s/.test(code[i])) i++
    let value = ''
    if (code[i] === '{') {
      let depth = 0
      for (; i < code.length; i++) {
        if (code[i] === '{') depth++
        if (code[i] === '}') { depth--; value += code[i]; if (depth === 0) break; continue }
        value += code[i]
      }
    } else {
      for (; i < code.length && code[i] !== ',' && code[i] !== '\n'; i++) value += code[i]
    }
    if (/\b(lt|lte|gt|gte)\s*:/.test(value)) found.push(`${needle}${value}`.replace(/\s+/g, ' '))
    at = code.indexOf(needle, at + needle.length)
  }
  return found
}

test('[o3d-0bfh r7] no reader outside the protocol range-compares the obligation generation', () => {
  const offences: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'generated') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.tsx?$/.test(full)) continue
      const source = readSource(full)
      for (const hit of markerRangeComparisons(source.executable)) offences.push(`${source.rel}: ${hit}`)
    }
  }
  walk(path.join(REPO_ROOT, 'lib'))
  walk(path.join(REPO_ROOT, 'app'))
  assert.deepEqual(
    offences,
    [],
    'the obligation marker is a GENERATION — minted as max(now, observed + 1ms) so it can be pushed ahead of real '
      + 'time under contention. Comparing it to a clock hides a stranded payment for as long as the mint ran '
      + 'ahead, and by an amount that grows with contention. Measure age on syncedAt/createdAt instead:\n'
      + offences.join('\n'),
  )
})

test('[o3d-0bfh r7] CONTROL: the range-comparison scan really does catch the r6 predicate', () => {
  // Without this, the scan above is green on a repository where the extractor has quietly stopped
  // matching — the same green as one with no offence in it. The literal r6 predicate, and the
  // multi-line form a maintainer would actually write, must both be caught.
  assert.deepEqual(
    markerRangeComparisons("{ backReferenceFollowUpsPendingAt: { not: null, lt: new Date(now.getTime() - grace) } }"),
    ['backReferenceFollowUpsPendingAt:{ not: null, lt: new Date(now.getTime() - grace) }'],
  )
  assert.equal(
    markerRangeComparisons('backReferenceFollowUpsPendingAt: {\n  not: null,\n  gte: cutoff,\n}').length, 1,
    'the multi-line form is the one a maintainer writes',
  )
  // And it must NOT fire on the shipped predicate, whose neighbouring OR branch does hold an `lt`.
  assert.deepEqual(
    markerRangeComparisons('backReferenceFollowUpsPendingAt: { not: null },\nOR: [{ syncedAt: { lt: cutoff } }]'),
    [],
    'a range comparison on a DIFFERENT column must not be attributed to the marker, or the rule is unusable',
  )
  // And on the protocol's own equality fences, which are how a release clears only what it minted.
  assert.deepEqual(
    markerRangeComparisons('where: { id: params.syncLogId, backReferenceFollowUpsPendingAt: params.generation },'),
    [],
  )
})

test('[o3d-0bfh r7] the remedy never asserts the follow-ups were never enqueued', () => {
  // Codex HIGH: a retained marker does NOT establish that the work never ran —
  // `settleFollowUpObligation` retains it when the enqueue succeeded and only the back-reference
  // write failed, and `releaseFollowUpObligation` retains it when everything ran and only the clear
  // failed. Telling an operator to re-drive a payment that may already be queued is worse on a money
  // path than the stall being reported.
  const surfaces: Array<{ what: string; prose: string }> = [
    ...CONNECTORS_WITHOUT_FOLLOW_UP_CONSUMER.map((connector) => {
      const recovery = followUpObligationRecoveryFor(connector)
      return { what: `${connector} registry remedy`, prose: recovery.consumer === 'none' ? recovery.operatorRemedy : '' }
    }),
    { what: 'undeclared-connector remedy', prose: (() => {
      const unknown = followUpObligationRecoveryFor('sage')
      return unknown.consumer === 'none' ? unknown.operatorRemedy : ''
    })() },
    { what: 'the exception-inbox section', prose: readSource(
      path.join(REPO_ROOT, 'app', '(dashboard)', 'sync', 'exceptions', 'exceptions-client.tsx'),
    ).text.split('\n').filter((line) => /Accounting follow-ups owed|reached the accounting package/.test(line)).join('\n') },
  ]
  for (const { what, prose } of surfaces) {
    assert.ok(prose.length > 20, `${what}: nothing was found to check`)
    assert.ok(
      !/never (been )?enqueued|was never (enqueued|run|queued)|did not run/i.test(prose),
      `${what} states as fact that the follow-up work never ran. The marker does not establish that:\n${prose}`,
    )
    assert.match(
      prose,
      /not known|unknown|unresolved/i,
      `${what} must say the outcome is UNKNOWN rather than undone`,
    )
    assert.match(
      prose,
      /verifiably absent|only what is verifiably|escalat/i,
      `${what} must give an action that is safe to take twice — reconcile first, create only what is missing, `
        + 'or escalate — rather than "re-drive each one"',
    )
  }
})
