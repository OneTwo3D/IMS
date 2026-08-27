import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  ACCOUNTING_FOLLOW_UP_RECOVERY,
  CONNECTORS_WITHOUT_FOLLOW_UP_CONSUMER,
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

/** A sweep binding, by the naming convention both connectors follow. */
const SWEEP_BINDING_NAME = /^repair[A-Za-z]*BackReferences?$/

/** Scheduled (cron route) and manual (server action) entry points — where an invocation must be. */
function invocationSources(): Array<{ rel: string; text: string }> {
  const found: Array<{ rel: string; text: string }> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!full.endsWith('.ts')) continue
      found.push({ rel: path.relative(REPO_ROOT, full), text: readFileSync(full, 'utf8') })
    }
  }
  walk(path.join(REPO_ROOT, 'app', 'api', 'cron'))
  walk(path.join(REPO_ROOT, 'app', 'actions'))
  return found
}

const INVOCATION_SOURCES = invocationSources()

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
    const callers = INVOCATION_SOURCES.filter(({ text }) => bindings.some((name) => text.includes(`${name}(`)))
    assert.ok(
      callers.length > 0,
      `${connector} exports ${bindings.join(', ')} but NOTHING under app/api/cron or app/actions calls it. A `
        + 'binding nothing invokes is exactly as dead as no binding: the marker is retained, no candidate query '
        + 'ever selects it, and the operator is told a sweep will re-enqueue the work.',
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
      .filter(({ text }) => /repair[A-Za-z]*BackReferences?\(/.test(text) && new RegExp(connector, 'i').test(text))
      .map(({ rel }) => rel)
    for (const rel of callers) {
      const source = INVOCATION_SOURCES.find((entry) => entry.rel === rel)
      assert.ok(source)
      // A file may legitimately mention both connectors (the accounting-sync cron dispatches to
      // either). What must not appear is a sweep call inside this connector's own branch, which is
      // what tests/cron/accounting-sync-backreference-sweep.test.ts and
      // tests/connectors/quickbooks-manual-sync-repairs.test.ts assert behaviourally.
      assert.ok(source.text.includes('repairXeroBackReferences('), `${rel} calls a sweep — check whose`)
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

test('[o3d-0bfh r6] the backlog query selects exactly the connectors with no consumer', () => {
  const where = buildFollowUpObligationBacklogWhere() as {
    connector: { in: string[] }
    status: { in: string[] }
    backReferenceFollowUpsPendingAt: { not: null; lt: Date }
  }
  assert.deepEqual(where.connector.in, ['quickbooks'], 'derived from the registry, not restated')
  assert.ok(!where.connector.in.includes('xero'), 'a connector WITH a sweep must not be listed as unrecoverable')
  // SYNCED and FAILED only: a PENDING or stale PROCESSING row is still on the processor's own ladder,
  // and listing it would be self-resolving noise that trains an operator to ignore the section.
  assert.deepEqual(where.status.in, ['SYNCED', 'FAILED'])
  assert.equal(where.backReferenceFollowUpsPendingAt.not, null)
})
