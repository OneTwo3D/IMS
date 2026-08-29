import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import { followUpObligationRecoveryNote } from '@/lib/domain/accounting/back-reference'
import { sweepRetainedFollowUpObligationDescription } from '@/lib/domain/accounting/back-reference-sweep'
import {
  buildCompactedFollowUpLossActivity,
  type CompactedFollowUpLossPhase,
} from '@/lib/domain/accounting/compacted-followup-loss'
import { xeroRetainedFollowUpObligationDescription } from '@/lib/connectors/xero/sync-processor'
import {
  deferredReceiptRecoveryWhere,
  deferredReceiptsDocumentMovedDescription,
  deferredReceiptsFailedDescription,
  deferredReceiptsUnlinkedDescription,
  describeInvoicePaymentRefusal,
  invoicePaymentConnectorMovedDescription,
  invoicePaymentDocumentMovedDescription,
  invoicePaymentNotQueuedDescription,
  invoicePaymentPostingContextChangedDescription,
  invoicePaymentRedriveFor,
  invoicePaymentRemedyNote,
  readDeferredReceiptRecovery,
  type DeferredReceiptRecoveryClient,
} from '@/lib/domain/accounting/invoice-payment-enqueue'
import {
  paymentAccountRefusalMessage,
  postedRowFollowUpRetryNote,
  unreadablePaymentAmountRefusalMessage,
} from '@/lib/domain/accounting/followup-enqueue-outcome'
import { ACCOUNTING_CONNECTORS } from '@/lib/connectors/accounting-registry'
import {
  ACCOUNTING_FOLLOW_UP_RECOVERY,
  CONNECTORS_WITHOUT_FOLLOW_UP_CONSUMER,
  FOLLOW_UP_OBLIGATION_AGE_COLUMNS,
  FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN,
  buildFollowUpObligationBacklogWhere,
  describeFollowUpObligationBacklogRow,
  followUpObligationRecoveryFor,
  readFollowUpObligationDatabaseNow,
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
//   5. a named BEHAVIOURAL test exists for the connector, it drives the real entry point, it names
//      the binding, and (r8) it is DRIVEN BY THIS REGISTRY — it imports ACCOUNTING_FOLLOW_UP_RECOVERY
//      and asserts, per entry, that invoking the real entry point calls that connector's sweep if
//      and only if the entry says `consumer: 'sweep'`. That test is what actually executes the path,
//      and being registry-driven is what makes it cover a connector nobody remembered to add.
//
// (2), (3) and (4) ARE ONE RESOLVED QUESTION SINCE r8, not three independent text matches. Codex was
// right that three independent matches are answered together by a file that does none of it: an
// unused aliased import beside a same-named local function, and a call in a helper nothing routes
// to, satisfied all three at once. `reachableSweepInvocations` binds the CALLED identifier to the
// module's export and walks outward from the real entry points, so neither forgery answers it.
//
// WHAT IT STILL DOES NOT PROVE: that the call is on a branch reached under production conditions.
// Nothing short of running the entry point proves that, which is why (5) requires a test that does —
// tests/cron/accounting-sync-backreference-sweep.test.ts imports the cron route's GET, invokes it
// per registry entry, and asserts that connector's own sweep double was called exactly when the
// entry says it should be. The registry check's job is to make sure a NEWLY declared connector
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



// ---------------------------------------------------------------------------
// o3d-0bfh r8 (Codex MEDIUM) — THE INVOCATION CHECK RESOLVES THE CALL TO AN IMPORTED SYMBOL, AND
// PROVES THE CALL SITE IS REACHED FROM AN ENTRY POINT.
//
// r7's checks (2), (3) and (4) were three INDEPENDENT text matches over one file: "some `name(`
// appears", "some import of `name` from that module appears", "the file exports GET/POST". Codex is
// right that all three are satisfied together by a file that does none of what they claim:
//
//   import { repairXeroBackReferences as unused } from '@/lib/connectors/xero/sync-processor'
//   function repairXeroBackReferences() { ... }        // a same-named LOCAL
//   function neverCalled() { repairXeroBackReferences() }   // in a helper nothing routes to
//   export async function GET() { return NextResponse.json({}) }
//
// The check below asks one question instead of three. It binds every imported name — static
// `import { a as b } from 'mod'` AND the dynamic `const { a } = await import('mod')` form this
// codebase's cron routes actually use — to its module and its ORIGINAL export name, then walks
// outward from the module's real entry points (GET/POST on a route, every export on a 'use server'
// module) through the calls those functions make, and asks whether any function it can reach calls
// an identifier bound to that module's export. A same-named local is not bound to the module; a
// helper nothing reaches is never walked into.
// ---------------------------------------------------------------------------

/** One imported name: what it is called here, what it is called there, and where it came from. */
type ImportBinding = { local: string; imported: string; module: string }

function importBindings(sourceFile: ts.SourceFile): ImportBinding[] {
  const bindings: ImportBinding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.importClause?.namedBindings
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          bindings.push({
            local: element.name.text,
            imported: (element.propertyName ?? element.name).text,
            module: (node.moduleSpecifier as ts.StringLiteral).text,
          })
        }
      }
    }
    // `const { repairXeroBackReferences } = await import('@/lib/...')` — the form the cron route
    // uses, and one a static-import matcher would have to be told about separately.
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      let initializer: ts.Expression = node.initializer
      if (ts.isAwaitExpression(initializer)) initializer = initializer.expression
      if (
        ts.isCallExpression(initializer)
        && initializer.expression.kind === ts.SyntaxKind.ImportKeyword
        && initializer.arguments[0]
        && ts.isStringLiteral(initializer.arguments[0])
      ) {
        const module = (initializer.arguments[0] as ts.StringLiteral).text
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue
          const imported = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text
          bindings.push({ local: element.name.text, imported, module })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return bindings
}

/** Top-level named functions, so a call from one can be followed into the next. */
function topLevelFunctions(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement)
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
          functions.set(declaration.name.text, declaration.initializer)
        }
      }
    }
  }
  return functions
}

/** The names the framework can call into: GET/POST on a route, every export on a server action. */
function entryPointNames(sourceFile: ts.SourceFile, isServerActionModule: boolean): string[] {
  const names: string[] = []
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
    if (!exported) continue
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (isServerActionModule || statement.name.text === 'GET' || statement.name.text === 'POST') {
        names.push(statement.name.text)
      }
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        if (isServerActionModule || declaration.name.text === 'GET' || declaration.name.text === 'POST') {
          names.push(declaration.name.text)
        }
      }
    }
  }
  return names
}

/** Every identifier called anywhere inside this subtree. */
function calledNames(node: ts.Node): Set<string> {
  const called = new Set<string>()
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) called.add(current.expression.text)
    ts.forEachChild(current, visit)
  }
  visit(node)
  return called
}

/**
 * Which of `bindingNames` this file calls, as an import from `module`, from code the framework can
 * actually reach. The answer is a list so a caller can say WHICH binding, and empty means "no
 * reachable call to any of them", which is the state r7's three text checks could not tell apart
 * from a real one.
 */
function reachableSweepInvocations(
  code: string,
  fileName: string,
  module: string,
  bindingNames: readonly string[],
): string[] {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const isServerActionModule = sourceFile.statements.some((statement) => (
    ts.isExpressionStatement(statement)
    && ts.isStringLiteral(statement.expression)
    && statement.expression.text === 'use server'
  ))
  const entries = entryPointNames(sourceFile, isServerActionModule)
  if (entries.length === 0) return []

  const functions = topLevelFunctions(sourceFile)
  const bindings = importBindings(sourceFile)
  // The LOCAL names that really are this module's exports — a same-named local function is not one.
  const localForBinding = new Map<string, string>()
  for (const binding of bindings) {
    if (binding.module !== module) continue
    if (!bindingNames.includes(binding.imported)) continue
    // A local function declaration with the same name shadows the import for every call in the file,
    // so the import cannot vouch for those calls.
    if (functions.has(binding.local)) continue
    localForBinding.set(binding.local, binding.imported)
  }
  if (localForBinding.size === 0) return []

  const visited = new Set<string>()
  const queue = [...entries]
  const invoked = new Set<string>()
  while (queue.length > 0) {
    const name = queue.pop() as string
    if (visited.has(name)) continue
    visited.add(name)
    const node = functions.get(name)
    if (!node) continue
    for (const called of calledNames(node)) {
      const imported = localForBinding.get(called)
      if (imported) invoked.add(imported)
      if (functions.has(called) && !visited.has(called)) queue.push(called)
    }
  }
  return [...invoked]
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

/**
 * Does this test file import the registry itself? The contract test's list of connectors must BE the
 * registry, not a copy of it — a copy stops covering the registry the moment somebody adds an entry.
 */
function reachableRegistryImport(code: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return importBindings(sourceFile).some((binding) => (
    binding.module === '@/lib/domain/accounting/follow-up-obligation-registry'
    && binding.imported === 'ACCOUNTING_FOLLOW_UP_RECOVERY'
  ))
}

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
    // r8 (Codex MEDIUM): ONE resolved question, not three independent text matches. The called
    // identifier must be bound to THIS module's export (so a same-named local cannot answer for it),
    // and the call site must be reached from a real entry point (so a helper nothing routes to
    // cannot either).
    const callers = INVOCATION_SOURCES.filter((source) => (
      reachableSweepInvocations(source.text, source.rel, CONNECTOR_MODULES[connector], bindings).length > 0
    ))
    assert.ok(
      callers.length > 0,
      `${connector} exports ${bindings.join(', ')} but NOTHING under app/api/cron or app/actions calls it as an `
        + `import from ${CONNECTOR_MODULES[connector]}, from code reachable from an entry point. `
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
    // r8 (Codex MEDIUM): AND IT MUST BE DRIVEN BY THIS REGISTRY. A hand-written list of connectors
    // in the contract test would leave a NEWLY declared connector checked by nothing while every
    // assertion here stayed green — which is the same silence one file over. Resolved as an import
    // symbol rather than matched as text, for the reason the invocation check is.
    assert.ok(
      reachableRegistryImport(proof.text, behavioural.test),
      `${behavioural.test} must import ACCOUNTING_FOLLOW_UP_RECOVERY from `
        + '@/lib/domain/accounting/follow-up-obligation-registry and drive its assertions from it. A contract test '
        + 'with its own list of connectors stops covering the registry the moment a connector is added to it.',
    )
  }
})

test('[o3d-0bfh r8] CONTROL: the invocation check resolves the SYMBOL, so the two forgeries Codex named fail it', () => {
  // r7's checks were three independent text matches over one file. Codex named two files that
  // satisfy all three while doing none of what they claim. Both are asserted here, along with the
  // real shapes that must keep passing — a control that only rejects would be satisfied by a
  // function that returns nothing.
  const MODULE = '@/lib/connectors/xero/sync-processor'
  const BINDINGS = ['repairXeroBackReferences']

  const forgeries: Array<{ what: string; code: string }> = [
    {
      what: 'AN UNUSED ALIASED IMPORT plus a same-named local function',
      code: [
        `import { repairXeroBackReferences as unused } from '${MODULE}'`,
        'function repairXeroBackReferences() { return {} }',
        'export async function GET() { repairXeroBackReferences(); return new Response() }',
      ].join('\n'),
    },
    {
      what: 'A CALL IN A HELPER NOTHING ROUTES TO, in a file that does export GET',
      code: [
        `import { repairXeroBackReferences } from '${MODULE}'`,
        'async function neverCalled() { await repairXeroBackReferences() }',
        'export async function GET() { return new Response() }',
      ].join('\n'),
    },
    {
      what: 'a call in a file with no entry point at all',
      code: [
        `import { repairXeroBackReferences } from '${MODULE}'`,
        'export async function helper() { await repairXeroBackReferences() }',
      ].join('\n'),
    },
    {
      what: 'an import of the binding from a DIFFERENT module',
      code: [
        "import { repairXeroBackReferences } from '@/lib/connectors/quickbooks/sync-processor'",
        'export async function GET() { await repairXeroBackReferences(); return new Response() }',
      ].join('\n'),
    },
  ]
  for (const { what, code } of forgeries) {
    assert.deepEqual(
      reachableSweepInvocations(code, 'forgery.ts', MODULE, BINDINGS), [],
      `the invocation check is satisfied by ${what}, which is the defect it exists to close`,
    )
  }

  const genuine: Array<{ what: string; code: string }> = [
    {
      what: 'the dynamic-import form the cron route actually uses',
      code: [
        'export async function GET() {',
        `  const { repairXeroBackReferences } = await import('${MODULE}')`,
        '  await repairXeroBackReferences()',
        '  return new Response()',
        '}',
      ].join('\n'),
    },
    {
      what: 'a LEGITIMATELY aliased static import',
      code: [
        `import { repairXeroBackReferences as repair } from '${MODULE}'`,
        'export async function GET() { await repair(); return new Response() }',
      ].join('\n'),
    },
    {
      what: 'a call one hop away, in a helper the entry point does reach',
      code: [
        `import { repairXeroBackReferences } from '${MODULE}'`,
        'async function sweep() { await repairXeroBackReferences() }',
        'export async function GET() { await sweep(); return new Response() }',
      ].join('\n'),
    },
    {
      what: 'a server action module, where every export is an entry point',
      code: [
        "'use server'",
        `import { repairXeroBackReferences } from '${MODULE}'`,
        'export async function runSync() { await repairXeroBackReferences() }',
      ].join('\n'),
    },
  ]
  for (const { what, code } of genuine) {
    assert.deepEqual(
      reachableSweepInvocations(code, 'genuine.ts', MODULE, BINDINGS), BINDINGS,
      `the invocation check rejects ${what}, which is a real wiring — a check nothing can satisfy gets deleted`,
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
  OR?: Array<Record<string, unknown>>
}

/** A stand-in for `readFollowUpObligationDatabaseNow`'s reading — never this host's clock. */
const DATABASE_NOW = new Date('2026-08-27T12:00:00.000Z')

test('[o3d-0bfh r6] the backlog query selects exactly the connectors with no consumer', () => {
  const where = buildFollowUpObligationBacklogWhere({ databaseNow: DATABASE_NOW }) as BacklogWhere
  assert.deepEqual(where.connector.in, ['quickbooks'], 'derived from the registry, not restated')
  assert.ok(!where.connector.in.includes('xero'), 'a connector WITH a sweep must not be listed as unrecoverable')
  // SYNCED and FAILED only: a PENDING or stale PROCESSING row is still on the processor's own ladder,
  // and listing it would be self-resolving noise that trains an operator to ignore the section.
  assert.deepEqual(where.status.in, ['SYNCED', 'FAILED'])
  assert.deepEqual(where.backReferenceFollowUpsPendingAt, { not: null })
})

test('[o3d-0bfh r7] the backlog asks the MARKER only whether it is null, and measures age on DATABASE-STAMPED times', () => {
  // The r6 defect in one assertion. `backReferenceFollowUpsPendingAt` is a generation minted as
  // max(now, observed + 1ms), so under contention it is ahead of every clock; comparing it to one
  // hid stranded obligations for longer than the grace, by an amount that grew with contention.
  const where = buildFollowUpObligationBacklogWhere({ databaseNow: DATABASE_NOW }) as BacklogWhere
  for (const op of ['lt', 'lte', 'gt', 'gte']) {
    assert.ok(
      !(op in where.backReferenceFollowUpsPendingAt),
      `the backlog compared the obligation GENERATION with "${op}". It is an ordering token, not a time — see the `
        + '"WHAT backReferenceFollowUpsPendingAt IS, AND WHAT IT IS NOT" block in the registry.',
    )
  }
  // And the grace is measured on columns that ARE times, one branch per row shape.
  assert.ok(where.OR)
  const branches = where.OR.map((clause) => Object.keys(clause).sort().join('+'))
  assert.deepEqual(branches, [
    'backReferenceFollowUpsClaimedAtDatabaseClock',
    'backReferenceFollowUpsClaimedAtDatabaseClock+createdAt',
  ])
  for (const column of FOLLOW_UP_OBLIGATION_AGE_COLUMNS) {
    assert.ok(
      where.OR.some((clause) => column in clause),
      `${column} is a declared age column but the backlog does not measure on it`,
    )
  }
  const grace = 5 * 60 * 1000
  const built = buildFollowUpObligationBacklogWhere({
    databaseNow: DATABASE_NOW, settlingGraceMs: grace,
  }) as BacklogWhere
  assert.ok(built.OR)
  assert.equal(
    ((built.OR[0] as { backReferenceFollowUpsClaimedAtDatabaseClock: { lt: Date } })
      .backReferenceFollowUpsClaimedAtDatabaseClock.lt).getTime(),
    DATABASE_NOW.getTime() - grace,
    'the cutoff is the DATABASE clock minus the grace, applied to a database-stamped claim time',
  )
})

// ---------------------------------------------------------------------------
// o3d-0bfh r8 (Codex MEDIUM) — THE MARKER RULE IS CHECKED ON THE SYNTAX TREE, NOT ON THE TEXT.
//
// r7's scanner found the literal string `backReferenceFollowUpsPendingAt:`, took the balanced brace
// region after it, and looked for `lt|lte|gt|gte`. Codex is right that the exact regression it
// exists to stop walks straight past it:
//
//   const stale = { lt: cutoff }; ... backReferenceFollowUpsPendingAt: stale   (aliased predicate)
//   { ...stalePredicate }                                                      (spread)
//   { [MARKER]: { lt: cutoff } }                                               (computed key)
//   if (row.backReferenceFollowUpsPendingAt < cutoff)                          (plain JS)
//   sql`... WHERE "backReferenceFollowUpsPendingAt" < $1`                       (raw SQL)
//
// and it looked only at .ts/.tsx under lib and app.
//
// The scan below parses each file with the TypeScript compiler and reasons about NODES. Identifiers
// are resolved to their declaration in the same file, so an alias is followed to the object it
// names; spreads are followed the same way. And the rule is an ALLOWLIST rather than a banlist: a
// marker predicate may be a null test or a protocol EQUALITY (`{ not: null }`, `null`, `true` in a
// select, or any non-object value, which is an assignment or a compare-and-set operand) and
// ANYTHING ELSE is reported. A banlist can only ever name the forms somebody thought of; an
// allowlist has to be widened deliberately, which is the whole difference between this and r7.
// ---------------------------------------------------------------------------

const MARKER = 'backReferenceFollowUpsPendingAt'
/** Prisma range operators — the comparison the marker may never take part in. */
const RANGE_OPERATORS = new Set(['lt', 'lte', 'gt', 'gte'])
/** Prisma operators that ask about identity or nullness, which is all this column may be asked. */
const IDENTITY_OPERATORS = new Set(['not', 'equals', 'in', 'notIn', 'isSet'])
/**
 * Prisma keys whose value is a PREDICATE, i.e. where the marker is being asked a question rather
 * than assigned a value (o3d-0bfh r9, Codex MEDIUM).
 *
 * The distinction matters because the same key means opposite things either side of it.
 * `backReferenceFollowUpsPendingAt: now` under `data:` is the mint; under `where:` it is a
 * compare-and-set fence. r8's scan had no notion of position, so it had to be lenient enough for
 * the `data` side — and that leniency is what let a predicate operand through.
 */
const PREDICATE_KEYS = new Set(['where', 'AND', 'OR', 'NOT'])
/**
 * The property names a marker EQUALITY operand may be read from — THE DELIBERATE WIDENING POINT.
 *
 * In a predicate position the operand may only be a generation VALUE: `null`, a filter object the
 * scan can read, or a plain read of one of these. Everything else is refused, including a call. r8
 * accepted "anything that is not an inline object literal" as safe, which admits exactly the two
 * forms Codex named — `olderThan(cutoff)` and an imported `FILTERS.stale` returning `{ lt: cutoff }`
 * — because neither is an object literal at the point of use and neither can be resolved to one.
 *
 * A name-based allowlist is the honest fail-closed rule available without a type checker: the scan
 * cannot tell a `Date` from a filter object by shape, so it refuses every read it has not been told
 * about. Adding a name here is a deliberate act with this comment attached to it, which is the
 * whole difference between an allowlist and an assumption.
 */
const PROTOCOL_OPERAND_NAMES = new Set([
  MARKER,
  'followUpsPendingAt',
  'generation',
  'marker',
  'pendingAt',
  'settlementMarker',
])
/** JavaScript operators that treat a value as a point on a line. */
const RANGE_TOKENS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.MinusToken,
])

/** Every `const`/`let`/`var` initializer in the file, by name — the file-local symbol table. */
function localBindings(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      // First declaration wins; a shadowing re-declaration is itself suspicious and this scan is
      // deliberately conservative rather than clever about scopes.
      if (!bindings.has(node.name.text)) bindings.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return bindings
}

/**
 * Names that hold a value DESTRUCTURED off the marker column (o3d-0bfh r9, Codex MEDIUM).
 *
 * `const { backReferenceFollowUpsPendingAt: pendingAt } = row` puts the generation in a plain
 * identifier, and `pendingAt < cutoff` is then the exact clock comparison this whole scan exists to
 * refuse — invisible to it, because `localBindings` only records identifier declarations and
 * `readsMarker` only recognises a property access. Both destructuring forms are recorded here, the
 * renaming one and the shorthand.
 */
function destructuredMarkerAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>([MARKER])
  const visit = (node: ts.Node): void => {
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const source = node.propertyName ?? node.name
      const sourceName = ts.isIdentifier(source) || ts.isStringLiteral(source) ? source.text : null
      if (sourceName === MARKER) aliases.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return aliases
}

/**
 * The single expression a function body hands back, or null when there is not exactly one.
 *
 * ONE return, deliberately. A body with two of them is a decision this scan cannot make, and the
 * honest answer to "which clause does this build" is then "unknown" — which is what
 * {@link couldConcernMarker} is for. Guessing the first branch would be the fail-open shape all over
 * again, one level further in.
 */
function soleReturnExpression(fn: ts.Node): ts.Expression | null {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return fn.body
  const body = (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)
    || ts.isMethodDeclaration(fn))
    ? fn.body
    : undefined
  if (!body || !ts.isBlock(body)) return null
  const returns: ts.ReturnStatement[] = []
  const visit = (node: ts.Node): void => {
    // A nested function's returns belong to IT, not to this one.
    if (node !== body && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))) return
    if (ts.isReturnStatement(node)) returns.push(node)
    ts.forEachChild(node, visit)
  }
  visit(body)
  return returns.length === 1 && returns[0]!.expression ? returns[0]!.expression : null
}

/** Every locally declared function, by name — so a call to one can be followed to what it returns. */
function localFunctions(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && !functions.has(node.name.text)) {
      functions.set(node.name.text, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return functions
}

/**
 * Follow identifiers and parenthesised/`as` wrappers to the expression they actually name — AND A
 * CALL TO A LOCAL FUNCTION TO THE EXPRESSION IT RETURNS (o3d-0bfh r10, Codex MEDIUM).
 *
 * Without the last part, `function stale(c) { return { [MARKER]: olderThan(c) } }` +
 * `findMany({ where: stale(cutoff) })` was accepted twice over: `predicateClauses` could not resolve
 * the call and produced NO clauses, so the where-side strict judgement ran over nothing, while the
 * literal inside the function body was visited in its own right — outside predicate context, where
 * the judge runs non-strictly and lets a call operand through. Two fail-open answers agreeing.
 *
 * Following the return is what puts the literal back INSIDE the predicate, where it is judged
 * strictly and `olderThan(cutoff)` is refused. It is conservative on purpose: one return statement
 * only, and a nested function's returns are not this function's.
 */
function resolve(expression: ts.Expression, bindings: Map<string, ts.Expression>, seen = new Set<string>()): ts.Expression {
  return resolveIn(expression, bindings, seen).node
}

/**
 * A resolution AND THE SCOPE IT WAS REACHED IN (o3d-0bfh r12, Codex MEDIUM).
 *
 * Following a call to the expression it returns changes scope: the returned expression is written in
 * terms of the callee's FORMAL PARAMETERS, and the values they stand for are the call's ACTUAL
 * ARGUMENTS. r11 substituted the return and threw the arguments away, so
 * `predicates.stale(olderThan(cutoff))` resolved to `{ [MARKER]: generation }` with `generation`
 * meaning nothing — and `generation` is an ALLOWLISTED protocol operand name, so the range-building
 * argument disappeared and the shape was judged as a legitimate compare-and-set fence. The argument
 * carrying the offence was the one thing not looked at.
 *
 * `unbound` is the fail-closed half: a formal parameter this scan could NOT pair with an argument —
 * a destructuring pattern, a rest parameter, a spread call, a missing argument with no default —
 * must not then be readable as a generation just because it is spelled `generation`.
 */
type ResolvedExpression = {
  node: ts.Expression
  /** The binding table the node must be read in: the caller's, plus this call's parameters. */
  bindings: Map<string, ts.Expression>
  /** Parameter names substituted past whose actual argument could not be identified. */
  unbound: Set<string>
}

function resolveIn(
  expression: ts.Expression,
  bindings: Map<string, ts.Expression>,
  seen = new Set<string>(),
  unbound = new Set<string>(),
): ResolvedExpression {
  let current: ts.Expression = expression
  let scope = bindings
  for (;;) {
    if (ts.isParenthesizedExpression(current)) { current = current.expression; continue }
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) { current = current.expression; continue }
    if (ts.isIdentifier(current) && !seen.has(current.text)) {
      const bound = scope.get(current.text)
      if (bound) { seen.add(current.text); current = bound; continue }
    }
    if (ts.isCallExpression(current)) {
      const callee = calleeFunction(current, scope, seen)
      const returned = callee ? soleReturnExpression(callee) : null
      if (callee && returned && !seen.has(`call:${current.getText()}`)) {
        seen.add(`call:${current.getText()}`)
        scope = bindCallArguments(callee, current, scope, unbound)
        current = returned
        continue
      }
    }
    return { node: current, bindings: scope, unbound }
  }
}

/** Every identifier a parameter's binding name introduces — a pattern binds several. */
function parameterNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  const names: string[] = []
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    names.push(...parameterNames(element.name))
  }
  return names
}

/**
 * Every name an expression READS — an over-approximation, deliberately (o3d-0bfh r13).
 *
 * Property NAMES are excluded (`row.generation` reads `row`, not `generation`) and so are
 * non-computed object keys, because neither is a free variable and treating them as one would refuse
 * ordinary shapes. Everything else counts, including a shorthand property, whose key IS a read.
 */
function referencedIdentifiers(expression: ts.Expression): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) { names.add(node.text); return }
    if (ts.isShorthandPropertyAssignment(node)) { names.add(node.name.text); return }
    // `a.b` reads `a`; `b` is a property name in the object, not a binding in this scope.
    if (ts.isPropertyAccessExpression(node)) { visit(node.expression); return }
    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name.expression)
      visit(node.initializer)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(expression)
  return names
}

/**
 * Pair a followed call's actual arguments with the callee's formal parameters (o3d-0bfh r12).
 *
 * EVERY parameter name is first REMOVED from the scope and recorded as unbound, because a parameter
 * SHADOWS whatever the enclosing file called that name — reading an outer `const generation` through
 * a parameter of the same name is a second way to lose the argument, and it is a way that reads as a
 * clean result. A name is only put back when this scan can point at the expression it stands for.
 *
 * FAIL-CLOSED ON EVERYTHING IT CANNOT PAIR POSITIONALLY: a spread call (`stale(...args)`) makes
 * every index a guess, a rest parameter has no single argument, a destructuring pattern binds names
 * that are properties of an argument rather than the argument, and a missing argument with no
 * default is `undefined` and is certainly not a generation.
 *
 * AND FAIL-CLOSED ON CAPTURE (o3d-0bfh r13, Codex MEDIUM). r12 installed the caller's RAW argument
 * expression into the callee's table, which is only a valid substitution while the callee redefines
 * no name the argument reads. It does redefine its own parameters, so
 *
 *     const generation = olderThan(cutoff)
 *     function stale(generation) { return { backReferenceFollowUpsPendingAt: generation } }
 *     findMany({ where: stale(generation) })
 *
 * bound `generation` to the identifier `generation` — a binding that points at ITSELF. `resolveIn`
 * follows it once, marks the name seen, stops, and hands back a bare identifier; the range
 * comparison sitting in the caller's `olderThan(cutoff)` is never looked at, and the name is then
 * waved through because it is in PROTOCOL_OPERAND_NAMES. Substituting `f(b, a)` into
 * `function f(a, b)` is the same defect without the self-reference.
 *
 * Hygienic renaming is not available to a scan with no type checker, so the answer is REFUSAL: an
 * argument that reads ANY name this call is about to shadow does not get installed, the parameter
 * stays in `unbound`, and `judgeMarkerPredicateOperand` refuses it ahead of the allowlist.
 */
function bindCallArguments(
  callee: ts.Node,
  call: ts.CallExpression,
  scope: Map<string, ts.Expression>,
  unbound: Set<string>,
): Map<string, ts.Expression> {
  const parameters = (callee as Partial<ts.SignatureDeclarationBase>).parameters
  if (!parameters) return scope
  const next = new Map(scope)
  const spreadCall = call.arguments.some(ts.isSpreadElement)
  // Every name this call redefines. Collected across ALL parameters before any pairing, because the
  // capture that matters is between one parameter's binding and another parameter's name.
  const shadowed = new Set(parameters.flatMap((parameter) => parameterNames(parameter.name)))
  parameters.forEach((parameter, index) => {
    for (const name of parameterNames(parameter.name)) {
      next.delete(name)
      unbound.add(name)
    }
    if (spreadCall || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return
    const argument = call.arguments[index] ?? parameter.initializer
    if (!argument) return
    // CAPTURE. The argument would be read in a scope where these names mean something else — for the
    // self-referential case, itself. There is no rename available here, so it stays unbound.
    //
    // ONE CARVE-OUT, and it is provably a no-op: `f(generation)` into `function f(generation)` while
    // the CALLER has no binding for that name is the identity substitution. The name is free on both
    // sides, means the same unreadable runtime value on both sides, and the allowlist reaches the
    // same verdict it would reach for a plain read — which is the protocol's own fence
    // (`fenceWhere(row.id, generation)`), not a hiding place. The moment the caller DOES bind the
    // name, that binding is precisely what the substitution would hide, and it is refused.
    const identity = ts.isIdentifier(argument) && argument.text === parameter.name.text && !scope.has(argument.text)
    for (const referenced of referencedIdentifiers(argument)) {
      if (!shadowed.has(referenced)) continue
      if (identity && referenced === parameter.name.text) continue
      return
    }
    next.set(parameter.name.text, argument)
    unbound.delete(parameter.name.text)
  })
  return next
}

/** The locally declared function a call expression actually reaches, or null. */
function calleeFunction(
  call: ts.CallExpression,
  bindings: Map<string, ts.Expression>,
  seen: Set<string>,
): ts.Node | null {
  const declared = LOCAL_FUNCTIONS.get(call.getSourceFile())
  const callee = call.expression
  if (ts.isIdentifier(callee)) {
    const named = declared?.get(callee.text)
    if (named) return named
    // `const build = () => ({ ... })` lands in the binding table rather than the function table.
    const bound = bindings.get(callee.text)
    if (bound && !seen.has(`fn:${callee.text}`)) {
      seen.add(`fn:${callee.text}`)
      const inner = resolve(bound, bindings, seen)
      if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner
    }
  }
  // `predicates.stale(cutoff)` — A METHOD ON A LOCALLY DECLARED OBJECT (o3d-0bfh r11, Codex MEDIUM).
  //
  // Only bare identifier calls were followed, so a predicate builder reached through a property
  // access resolved to nothing at all — and that nothing was accepted twice over, exactly as the
  // r10 finding described for functions: `predicateClauses` produced an unresolved expression which
  // `couldConcernMarker` then cleared because neither the call text nor (there being no callee) any
  // body named the column, while the literal inside the method was visited on its own, OUTSIDE
  // predicate context, where the judge runs non-strictly and lets a call operand through. Two
  // fail-open answers agreeing, in a different syntax.
  if (ts.isPropertyAccessExpression(callee)) {
    const owner = resolve(callee.expression, bindings, seen)
    if (ts.isObjectLiteralExpression(owner)) {
      for (const member of owner.properties) {
        if (keyOf(member, bindings) !== callee.name.text) continue
        // `{ stale(c) { ... } }`
        if (ts.isMethodDeclaration(member)) return member
        // `{ stale: (c) => ({ ... }) }`
        if (ts.isPropertyAssignment(member)) {
          const value = resolve(member.initializer, bindings, seen)
          if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value
        }
      }
    }
  }
  return null
}

/** Per-source-file function tables, populated by `markerClockReads` before it walks. */
const LOCAL_FUNCTIONS = new WeakMap<ts.SourceFile, Map<string, ts.Node>>()

/** The property's key as written — following a computed key to its string, when it names one. */
function keyOf(
  property: ts.ObjectLiteralElementLike,
  bindings: Map<string, ts.Expression>,
): string | null {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text
  if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) return null
  const name = property.name
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) {
    const resolved = resolve(name.expression, bindings)
    if (ts.isStringLiteral(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved)) return resolved.text
  }
  return null
}

/** Does this expression read the marker column — directly, through an alias, or through a call? */
function readsMarker(
  expression: ts.Expression,
  bindings: Map<string, ts.Expression>,
  aliases: Set<string> = new Set([MARKER]),
): boolean {
  const resolved = resolve(expression, bindings)
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    // A DESTRUCTURED alias is just an identifier by the time it is compared, so the name is the
    // only evidence left that it holds the generation.
    if (ts.isIdentifier(node) && aliases.has(node.text)) { found = true; return }
    if (ts.isPropertyAccessExpression(node) && node.name.text === MARKER) { found = true; return }
    if (ts.isElementAccessExpression(node)) {
      const argument = resolve(node.argumentExpression, bindings)
      if ((ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) && argument.text === MARKER) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(resolved)
  return found
}

/**
 * Judge the VALUE a marker key was given. Returns the offending form, or null when the value is one
 * of the two things this column may be asked: is it null, and is it exactly this generation.
 */
function judgeMarkerValue(
  value: ts.Expression,
  bindings: Map<string, ts.Expression>,
  sourceFile: ts.SourceFile,
  depth = 0,
  strict = false,
  /** Parameter names inherited from a call already followed to get here — see {@link resolveIn}. */
  carried: Set<string> = new Set(),
): string | null {
  // o3d-0bfh r12: resolved WITH its scope. Everything below reads the resolved node in `scope`, not
  // in the caller's table, or a substituted parameter means whatever the enclosing file happens to
  // call that name.
  const resolution = resolveIn(value, bindings, new Set(), new Set(carried))
  const resolved = resolution.node
  const scope = resolution.bindings
  const unbound = resolution.unbound
  if (depth > 4) return `${MARKER}: a predicate nested deeper than this scan will follow — state it plainly`
  if (ts.isConditionalExpression(resolved)) {
    return judgeMarkerValue(resolved.whenTrue, scope, sourceFile, depth + 1, strict, unbound)
      ?? judgeMarkerValue(resolved.whenFalse, scope, sourceFile, depth + 1, strict, unbound)
  }
  if (!ts.isObjectLiteralExpression(resolved)) {
    // NOT AN OBJECT. In an ASSIGNMENT or a select this is the protocol's own use: `null`, `true`,
    // `now()`, a generation carried in a variable. In a PREDICATE it is the r8 hole — Codex's
    // `olderThan(cutoff)` and `FILTERS.stale` both land here, and both were called safe purely for
    // not being inline object literals. `strict` is where that stops.
    if (!strict) return null
    return judgeMarkerPredicateOperand(resolved, sourceFile, unbound)
  }
  for (const property of resolved.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = resolveIn(property.expression, scope, new Set(), new Set(unbound))
      if (!ts.isObjectLiteralExpression(spread.node)) {
        return `${MARKER}: ${property.getText(sourceFile)} — a spread this scan cannot resolve to an object literal`
      }
      const verdict = judgeMarkerValue(spread.node, spread.bindings, sourceFile, depth + 1, strict, spread.unbound)
      if (verdict) return verdict
      continue
    }
    const key = keyOf(property, scope)
    if (key === null) {
      return `${MARKER}: ${property.getText(sourceFile)} — a key this scan cannot read`
    }
    if (RANGE_OPERATORS.has(key)) {
      return `${MARKER}: ${resolved.getText(sourceFile).replace(/\s+/g, ' ')}`
    }
    if (!IDENTITY_OPERATORS.has(key)) {
      return `${MARKER}: unrecognised operator "${key}" — only null tests and equality may be asked of a generation`
    }
    if (ts.isPropertyAssignment(property)) {
      const verdict = judgeMarkerValue(property.initializer, scope, sourceFile, depth + 1, strict, unbound)
      if (verdict) return verdict
    }
  }
  return null
}

/**
 * Judge a non-object operand sitting in a marker PREDICATE — the position r8 could not see.
 *
 * ALLOWED: the `null` literal (a null test), and a PLAIN READ — an identifier or a property-access
 * chain with no call anywhere in it — whose final name is one of {@link PROTOCOL_OPERAND_NAMES}.
 * That is the compare-and-set fence the protocol is built on, and it is the only reason this
 * position ever holds something that is not an object.
 *
 * REFUSED: everything else, and refused BY DEFAULT rather than by enumeration. A call
 * (`olderThan(cutoff)`), a read the allowlist does not name (`FILTERS.stale`, which may return
 * `{ lt: cutoff }`), an `await`, an arithmetic expression, an array. The scan has no type checker
 * and so cannot tell a `Date` from a filter object; refusing what it cannot read is the only answer
 * that does not amount to assuming the answer.
 */
function judgeMarkerPredicateOperand(
  resolved: ts.Expression,
  sourceFile: ts.SourceFile,
  unbound: Set<string> = new Set(),
): string | null {
  const text = resolved.getText(sourceFile).replace(/\s+/g, ' ')
  if (resolved.kind === ts.SyntaxKind.NullKeyword) return null

  const plainRead = (node: ts.Expression): string | null => {
    if (ts.isIdentifier(node)) return node.text
    if (ts.isNonNullExpression(node)) return plainRead(node.expression)
    if (ts.isPropertyAccessExpression(node)) {
      // The BASE must itself be a plain read, or a call is hiding inside the chain.
      return plainRead(node.expression) === null ? null : node.name.text
    }
    return null
  }

  const name = plainRead(resolved)
  // o3d-0bfh r12 (Codex MEDIUM): AN ALLOWLISTED NAME IS NOT A LICENCE WHEN IT IS A PARAMETER THIS
  // SCAN COULD NOT PAIR WITH AN ARGUMENT. `predicates.stale(olderThan(cutoff))` returning
  // `{ [MARKER]: generation }` reads exactly like the compare-and-set fence, and the range was in
  // the argument. Checked BEFORE the allowlist, because the allowlist is what it defeats.
  if (name !== null && unbound.has(name)) {
    return `${MARKER}: ${text} — a callee parameter whose actual argument this scan could not identify. The `
      + 'range comparison can be IN that argument, so an allowlisted parameter name is refused rather than read '
      + 'as the generation the protocol fences on'
  }
  if (name !== null && PROTOCOL_OPERAND_NAMES.has(name)) return null
  return `${MARKER}: ${text} — a predicate operand this scan cannot read as a generation value. A helper-built `
    + 'or imported filter can return { lt: cutoff } from exactly this position, so an unrecognised shape is '
    + 'REFUSED rather than assumed safe. If it really is a generation, name it in PROTOCOL_OPERAND_NAMES'
}

/** A `where` clause together with the scope it has to be read in (o3d-0bfh r12). */
type PredicateClause = {
  clause: ts.ObjectLiteralExpression
  bindings: Map<string, ts.Expression>
  unbound: Set<string>
}

/**
 * Every way this file treats the obligation generation as a point on a clock.
 *
 * Three separate questions, because they are three separate routes and r7 asked only the first:
 * a Prisma predicate on the column, a JavaScript comparison of a value read from it, and raw SQL.
 */
function markerClockReads(code: string, fileName = 'scan.ts'): string[] {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  LOCAL_FUNCTIONS.set(sourceFile, localFunctions(sourceFile))
  const bindings = localBindings(sourceFile)
  const aliases = destructuredMarkerAliases(sourceFile)
  const offences: string[] = []

  /**
   * Does this expression have anything to do with THIS COLUMN? — the question that decides whether
   * an unreadable predicate is this scan's business (o3d-0bfh r10).
   *
   * Scans the resolved subtree, and — for a call — the body of the local function it reaches, for
   * the column name in any of the forms it can wear: an identifier, a destructured alias, a string
   * literal (a computed key), a property access.
   */
  const couldConcernMarker = (expression: ts.Expression, depth = 0): boolean => {
    if (depth > 3) return false
    const resolved = resolve(expression, bindings)
    let found = false
    const roots: ts.Node[] = [resolved]
    if (ts.isCallExpression(resolved)) {
      const callee = calleeFunction(resolved, bindings, new Set())
      if (callee) roots.push(callee)
    }
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isIdentifier(node) && (node.text === MARKER || aliases.has(node.text))) { found = true; return }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === MARKER) { found = true; return }
      if (ts.isPropertyAccessExpression(node) && node.name.text === MARKER) { found = true; return }
      ts.forEachChild(node, visit)
    }
    for (const root of roots) visit(root)
    return found
  }

  /**
   * The object literals a `where`/`AND`/`OR`/`NOT` value actually stands for, AND THE EXPRESSIONS IT
   * COULD NOT RESOLVE (o3d-0bfh r10, Codex MEDIUM).
   *
   * Returning an empty clause list for anything unreadable was a fail-open answer wearing the shape
   * of a clean result: the where-side strict judgement then ran over nothing at all, and the caller
   * could not tell "this predicate holds no marker clause" from "this predicate is unreadable".
   * Those are the two answers this scan must never confuse — the whole finding, twice now.
   */
  const predicateClauses = (
    expression: ts.Expression,
    depth = 0,
    // o3d-0bfh r12: the scope the expression must be read in. A clause reached THROUGH a call is
    // written in the callee's parameters, and judging it in the caller's table is how the actual
    // argument disappears.
    scope: Map<string, ts.Expression> = bindings,
    carried: Set<string> = new Set(),
  ): { clauses: PredicateClause[]; unresolved: ts.Expression[] } => {
    if (depth > 3) return { clauses: [], unresolved: [expression] }
    const resolution = resolveIn(expression, scope, new Set(), new Set(carried))
    const resolved = resolution.node
    if (ts.isObjectLiteralExpression(resolved)) {
      return { clauses: [{ clause: resolved, bindings: resolution.bindings, unbound: resolution.unbound }], unresolved: [] }
    }
    // `AND: [...]` / `OR: [...]` — each element is a clause in its own right.
    if (ts.isArrayLiteralExpression(resolved)) {
      const clauses: PredicateClause[] = []
      const unresolved: ts.Expression[] = []
      for (const element of resolved.elements) {
        const inner = predicateClauses(
          ts.isSpreadElement(element) ? element.expression : element as ts.Expression,
          depth + 1,
          resolution.bindings,
          resolution.unbound,
        )
        clauses.push(...inner.clauses)
        unresolved.push(...inner.unresolved)
      }
      return { clauses, unresolved }
    }
    return { clauses: [], unresolved: [resolved] }
  }

  const visit = (node: ts.Node): void => {
    // 1. A PRISMA PREDICATE keyed on the marker — including an aliased value, a spread and a
    //    computed key, none of which the text scan could see.
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        const key = keyOf(property, bindings)
        if (key === MARKER) {
          const value = ts.isShorthandPropertyAssignment(property)
            ? property.name
            : (ts.isPropertyAssignment(property) ? property.initializer : null)
          if (value === null) continue
          const verdict = judgeMarkerValue(value, bindings, sourceFile)
          if (verdict) offences.push(verdict)
          continue
        }
        // 1b. THE SAME KEY, JUDGED STRICTLY BECAUSE OF WHERE IT SITS (o3d-0bfh r9). Reached from
        //     the `where`/`AND`/`OR`/`NOT` side rather than from the literal, so a clause built
        //     elsewhere and passed in by name is judged as the predicate it becomes — which is
        //     also the only way position is known at all.
        if (key === null || !PREDICATE_KEYS.has(key) || !ts.isPropertyAssignment(property)) continue
        const predicate = predicateClauses(property.initializer)
        // 1c. AND WHAT IT COULD NOT READ IS AN OFFENCE, NOT AN EMPTY RESULT (o3d-0bfh r10).
        //
        //     SCOPED TO THIS COLUMN, and that narrowing is measured rather than assumed: 93 `where`
        //     values across lib/, app/ and scripts/ are helper-built and unresolvable, essentially
        //     all of them about other columns entirely. Refusing every one of them would make this
        //     rule unusable, and an unusable rule gets deleted — which is a worse outcome for this
        //     column than a rule that refuses only what could possibly concern it. So the test is
        //     "does this expression, or the local function it calls, mention the marker at all".
        for (const unreadable of predicate.unresolved) {
          if (!couldConcernMarker(unreadable)) continue
          offences.push(
            `${MARKER}: ${unreadable.getText(sourceFile).replace(/\s+/g, ' ')} — a ${key} clause this scan cannot `
            + 'resolve, built where the marker is named. An unreadable predicate is not an absent one: it can '
            + 'return a range comparison on the generation from exactly this position',
          )
        }
        for (const { clause, bindings: clauseScope, unbound } of predicate.clauses) {
          for (const inner of clause.properties) {
            if (keyOf(inner, clauseScope) !== MARKER) continue
            const value = ts.isShorthandPropertyAssignment(inner)
              ? inner.name
              : (ts.isPropertyAssignment(inner) ? inner.initializer : null)
            if (value === null) continue
            const verdict = judgeMarkerValue(value, clauseScope, sourceFile, 0, true, unbound)
            if (verdict) offences.push(verdict)
          }
        }
      }
    }
    // 2. A DIRECT JAVASCRIPT COMPARISON of a value read from the column. `<` and friends, and `-`,
    //    which is how an "age" is computed before being compared somewhere else entirely. A
    //    destructured alias counts as a read of the column (r9).
    if (ts.isBinaryExpression(node) && RANGE_TOKENS.has(node.operatorToken.kind)) {
      if (readsMarker(node.left, bindings, aliases) || readsMarker(node.right, bindings, aliases)) {
        offences.push(`direct comparison: ${node.getText(sourceFile).replace(/\s+/g, ' ')}`)
      }
    }
    // 3. RAW SQL naming the column next to a comparison. Prisma's $queryRaw is not covered by
    //    anything above, and it is the one route where the predicate is a string by design. A
    //    COMPOSED fragment counts: a template whose substitutions resolve to strings is flattened
    //    first, so `sql\`... "${MARKER_COLUMN}" < $1\`` is read as the statement it becomes (r9).
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = flattenTemplate(node, bindings, sourceFile)
      if (text.includes(MARKER) && /<|>|\bBETWEEN\b|\bINTERVAL\b/i.test(text)) {
        offences.push(`raw SQL: ${text.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return [...new Set(offences)]
}

/**
 * A string/template as the statement it becomes, following substitutions that resolve to strings.
 *
 * Without this, splitting the column name into a constant hides a raw predicate from check 3 —
 * `sql\`WHERE "${MARKER_COLUMN}" < $1\`` contains neither the column name nor, in the fragment
 * that carries the comparison, anything to match on.
 */
function flattenTemplate(
  node: ts.Expression,
  bindings: Map<string, ts.Expression>,
  sourceFile: ts.SourceFile,
  depth = 0,
): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (!ts.isTemplateExpression(node) || depth > 3) return node.getText(sourceFile)
  let text = node.head.text
  for (const span of node.templateSpans) {
    text += flattenTemplate(resolve(span.expression, bindings), bindings, sourceFile, depth + 1)
    text += span.literal.text
  }
  return text
}

/** Every source file the rule applies to. r8 widens this from `lib`+`app`/.ts(x) to include scripts. */
function markerScanFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'generated') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      // r8: `.mjs` and `.mts` too. The deploy-time scripts are bare-node modules, and a rule that
      // stopped at the extension boundary would stop exactly where the next reader is likely to be.
      if (!/\.(tsx?|mts|mjs|jsx?)$/.test(full)) continue
      files.push(full)
    }
  }
  walk(path.join(REPO_ROOT, 'lib'))
  walk(path.join(REPO_ROOT, 'app'))
  walk(path.join(REPO_ROOT, 'scripts'))
  return files
}

test('[o3d-0bfh r7] no reader outside the protocol range-compares the obligation generation', () => {
  const offences: string[] = []
  const files = markerScanFiles()
  for (const full of files) {
    const rel = path.relative(REPO_ROOT, full)
    for (const hit of markerClockReads(readFileSync(full, 'utf8'), rel)) offences.push(`${rel}: ${hit}`)
  }
  // The scan must actually be reaching the modules the rule is about, or an empty result means
  // nothing. `lib/domain/accounting/back-reference.ts` is where the protocol's own equality fences
  // live, so it is both in range and expected to be clean.
  assert.ok(files.length > 500, `the scan reached only ${files.length} files`)
  assert.ok(
    files.some((full) => full.endsWith(path.join('lib', 'domain', 'accounting', 'back-reference.ts'))),
    'the protocol module itself must be in range',
  )
  assert.deepEqual(
    offences,
    [],
    'the obligation marker is a GENERATION — minted as max(now, observed + 1ms) so it can be pushed ahead of real '
      + 'time under contention. Comparing it to a clock hides a stranded payment for as long as the mint ran '
      + 'ahead, and by an amount that grows with contention. Measure age on the claim\'s database-stamped clock '
      + 'instead (backReferenceFollowUpsClaimedAtDatabaseClock):\n'
      + offences.join('\n'),
  )
})

test('[o3d-0bfh r7/r8] CONTROL: the scan catches the r6 predicate AND the four forms that walked past r7', () => {
  // Without controls the scan above is green on a repository where the extractor quietly stopped
  // matching — the same green as one with no offence in it. Each case below is a mutation of the
  // production predicate that a maintainer could plausibly write, and r7's TEXT scan missed all but
  // the first two.
  const cases: Array<{ what: string; code: string }> = [
    { what: 'the literal r6 predicate', code: '({ backReferenceFollowUpsPendingAt: { not: null, lt: new Date(now.getTime() - grace) } })' },
    { what: 'the multi-line form a maintainer writes', code: '({ backReferenceFollowUpsPendingAt: {\n  not: null,\n  gte: cutoff,\n} })' },
    { what: 'AN ALIASED PREDICATE', code: 'const stale = { lt: cutoff }\nconst where = { backReferenceFollowUpsPendingAt: stale }' },
    { what: 'A SPREAD', code: 'const stale = { lt: cutoff }\nconst where = { backReferenceFollowUpsPendingAt: { not: null, ...stale } }' },
    { what: 'A COMPUTED KEY', code: 'const MARKER = "backReferenceFollowUpsPendingAt"\nconst where = { [MARKER]: { lt: cutoff } }' },
    { what: 'A DIRECT JAVASCRIPT COMPARISON', code: 'if (row.backReferenceFollowUpsPendingAt < cutoff) hide(row)' },
    { what: 'a comparison through .getTime()', code: 'const age = Date.now() - row.backReferenceFollowUpsPendingAt.getTime()' },
    { what: 'a comparison through a local alias', code: 'const marker = row.backReferenceFollowUpsPendingAt\nif (marker < cutoff) hide(row)' },
    { what: 'RAW SQL', code: 'await db.$queryRaw`SELECT id FROM accounting_sync_logs WHERE "backReferenceFollowUpsPendingAt" < now() - interval \'5 minutes\'`' },
  ]
  for (const { what, code } of cases) {
    assert.ok(
      markerClockReads(code).length > 0,
      `the scan does not catch ${what}, so the rule it enforces is decoration:\n${code}`,
    )
  }

  // AND IT MUST NOT FIRE ON WHAT THE PROTOCOL ITSELF DOES, or the rule is unusable and gets deleted.
  const allowed: Array<{ what: string; code: string }> = [
    { what: 'the shipped existence predicate, beside an OR branch that DOES hold an lt', code: '({ backReferenceFollowUpsPendingAt: { not: null }, OR: [{ createdAt: { lt: cutoff } }] })' },
    { what: "the release's equality fence", code: '({ where: { id: params.syncLogId, backReferenceFollowUpsPendingAt: params.generation } })' },
    { what: 'the claim fragment', code: '({ backReferenceFollowUpsPendingAt: now })' },
    { what: 'the discharge', code: '({ data: { backReferenceFollowUpsPendingAt: null } })' },
    { what: 'a select', code: '({ select: { backReferenceFollowUpsPendingAt: true } })' },
    { what: 'an aliased EQUALITY operand', code: 'const observed = current.backReferenceFollowUpsPendingAt\nconst where = { id, backReferenceFollowUpsPendingAt: observed }' },
    { what: 'a type declaration of the column', code: 'type Row = { backReferenceFollowUpsPendingAt: Date | null }' },
    { what: 'a raw statement that only NAMES the column', code: 'await db.$executeRaw`UPDATE accounting_sync_logs SET "backReferenceFollowUpsPendingAt" = NULL WHERE id = ${id}`' },
  ]
  for (const { what, code } of allowed) {
    assert.deepEqual(
      markerClockReads(code), [],
      `the scan fires on ${what}, which is the protocol working as designed:\n${code}`,
    )
  }
})

test('[o3d-0bfh r8] CONTROL: the marker rule is an ALLOWLIST, so an operator nobody thought of is reported', () => {
  // The difference between this scan and r7's. A banlist can only name the forms somebody imagined;
  // anything else passes silently. Here a marker predicate may be a null test or an equality, and
  // every other Prisma operator — including ones that do not exist yet — has to be reported.
  //
  // Mutation: replace the `IDENTITY_OPERATORS.has(key)` check with a `RANGE_OPERATORS` banlist and
  // this fails, because `search`/`mode`/anything new goes quiet again.
  assert.ok(markerClockReads('({ backReferenceFollowUpsPendingAt: { somethingNew: cutoff } })').length > 0)
  assert.ok(markerClockReads('({ backReferenceFollowUpsPendingAt: { ...unresolvableFromHere } })').length > 0)
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
    // THE INBOX SECTION IS THIS STRING (o3d-0bfh r9). It used to be scraped out of the .tsx by
    // matching lines, because the section held a paragraph of its own — the paragraph that was
    // still saying "create only what is verifiably absent" a whole round after the registry
    // stopped. It authors nothing now: `detail={FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN}`. The
    // proof that the inbox really renders this and cannot reacquire a literal of its own is the
    // r9 surface test below; here it is simply the prose an operator reads.
    { what: 'the exception-inbox section', prose: FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN },
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
      `${what} must give an action that is safe to take twice — read the document and escalate — rather than `
        + '"re-drive each one". (Creating "only what is missing" is NOT such an action: see r8.)',
    )
  }
})

// ---------------------------------------------------------------------------
// o3d-0bfh r8 (Codex HIGH) — THE GRACE WAS TWO APPLICATION CLOCKS, AND HIDING IS THE DIRECTION THAT
// COSTS MONEY.
//
// r7's grace compared `syncedAt` — written by the connector's host with `new Date()` — against a
// cutoff derived from `new Date()` on whichever host renders the inbox. If the minting host runs
// ahead, or is stepped backwards afterwards, the row stays above the cutoff and a genuinely stranded
// payment is HIDDEN from the only surface that reports it. This repository already knows application
// timestamps are not authoritative for ordering: `syncedAtDatabaseClock` is on this very table for
// exactly that reason.
// ---------------------------------------------------------------------------

test('[o3d-0bfh r8] every column the grace compares is stamped by the DATABASE — no application clock takes part', () => {
  // Route: readFollowUpObligationDatabaseNow() -> clock_timestamp() -> `databaseNow` ->
  // settledBefore -> `lt` on backReferenceFollowUpsClaimedAtDatabaseClock (stamped by the trigger in
  // migration 20260827120000) and on createdAt (a database now() DEFAULT).
  //
  // Mutation: put `syncedAt` back into either branch and the first two assertions fail; restore the
  // `options?.now ?? new Date()` default and the source assertion fails — which is the entrance the
  // defect came through, since a default lets a caller take this host's clock without saying so.
  assert.deepEqual(
    [...FOLLOW_UP_OBLIGATION_AGE_COLUMNS],
    ['backReferenceFollowUpsClaimedAtDatabaseClock', 'createdAt'],
    "syncedAt is an application host's new Date(); it may not be an end of this comparison",
  )
  const where = buildFollowUpObligationBacklogWhere({ databaseNow: DATABASE_NOW }) as BacklogWhere
  assert.ok(where.OR)
  const columns = new Set(where.OR.flatMap((clause) => Object.keys(clause)))
  assert.ok(!columns.has('syncedAt'), 'the backlog must not read syncedAt at all')

  // COMMENTS REMOVED FIRST — the block above the function explains that the default was deleted, and
  // a text scan that read prose would be satisfied by the explanation of the very thing it bans.
  const source = readSource(
    path.join(REPO_ROOT, 'lib', 'domain', 'accounting', 'follow-up-obligation-registry.ts'),
  ).code
  const from = source.indexOf('export function buildFollowUpObligationBacklogWhere')
  assert.ok(from > 0)
  const fnBody = source.slice(from, source.indexOf('\n}\n', from))
  assert.doesNotMatch(
    fnBody, /new Date\(\)/,
    'buildFollowUpObligationBacklogWhere must never mint a clock of its own — the cutoff comes from the database',
  )
})

test('[o3d-0bfh r8] an unreadable database clock lists EVERY marked row rather than filtering on a clock nobody can identify', () => {
  // Fail-safe direction. The failure this column addresses is a stranded payment being HIDDEN, so a
  // backlog that cannot establish an age must show too much, never too little.
  //
  // Route: readFollowUpObligationDatabaseNow() catches -> null -> the age predicate is omitted.
  //
  // Mutation: fall back to `new Date()` when databaseNow is null, or build the OR from a zero
  // cutoff, and this fails — the OR reappears, which is this host's clock back in the comparison.
  const where = buildFollowUpObligationBacklogWhere({ databaseNow: null }) as BacklogWhere
  assert.equal(where.OR, undefined, 'no database clock, no age filter')
  assert.deepEqual(where.backReferenceFollowUpsPendingAt, { not: null }, 'but still only MARKED rows')
  assert.deepEqual(where.connector.in, ['quickbooks'], 'and still only connectors with no consumer')
})

test('[o3d-0bfh r8] readFollowUpObligationDatabaseNow asks the DATABASE, and fails to null rather than to this host', async () => {
  // Route: $queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC'` -> the Date it returns.
  //
  // Mutation: swap clock_timestamp() for now() and the statement assertion fails (now() is
  // transaction-start time, which can predate the claim it is compared with); return `new Date()`
  // from the catch and the failure assertion fails.
  const statements: string[] = []
  const stamp = new Date('2026-08-27T11:59:00.000Z')
  const reading = await readFollowUpObligationDatabaseNow({
    $queryRaw: (async (query: TemplateStringsArray) => {
      statements.push(query.join('?'))
      return [{ now: stamp }]
    }) as never,
  } as never)
  assert.equal(reading?.getTime(), stamp.getTime())
  assert.match(statements[0], /clock_timestamp\(\)/, 'clock_timestamp(), not now(): now() is transaction-start time')
  assert.match(statements[0], /AT TIME ZONE 'UTC'/, 'the identical expression the trigger stamps with')

  const captured: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => { captured.push(args) }
  let failed: Date | null
  try {
    failed = await readFollowUpObligationDatabaseNow({
      $queryRaw: (async () => { throw new Error('transient: the database did not answer') }) as never,
    } as never)
  } finally {
    console.error = original
  }
  assert.equal(failed, null, 'a database that cannot be asked the time must NOT be answered by this host')
  assert.equal(captured.length, 1, 'and the failure is reported rather than swallowed')

  // NON-VACUITY: a row shape carrying no Date is also `null`, never a coerced value.
  assert.equal(await readFollowUpObligationDatabaseNow({ $queryRaw: (async () => []) as never } as never), null)
})

test('[o3d-0bfh r8] the migration stamps the claim clock from the database and lets no writer supply one', () => {
  // The stamp is a TRIGGER rather than an extra statement in claimFollowUpObligation, and that is a
  // decision with a reason: the connectors' claim rides inside the transaction that records the
  // invoice's external id, so one more statement that can fail there is one more way to roll that
  // transaction back — and a rolled-back SYNCED write re-posts the invoice to QuickBooks.
  //
  // Route: prisma/migrations/20260827120000_.../migration.sql (applied to no database).
  //
  // Mutation: drop the ELSE branch and a writer can supply its own value; drop the NULL branch and a
  // discharged obligation keeps a stale claim time; swap clock_timestamp() for now() and the stamp
  // becomes transaction-start time, which can predate the claim it is meant to date.
  const sql = readFileSync(
    path.join(REPO_ROOT, 'prisma', 'migrations', '20260827120000_followup_obligation_claimed_at_database_clock', 'migration.sql'),
    'utf8',
  )
  assert.match(sql, /ADD COLUMN "backReferenceFollowUpsClaimedAtDatabaseClock" TIMESTAMP\(3\)/)
  assert.doesNotMatch(sql, /ADD COLUMN[\s\S]{0,120}NOT NULL/, 'nullable and not backfilled — see the migration header')
  assert.match(sql, /clock_timestamp\(\) AT TIME ZONE 'UTC'/, "the database stamps it, with the reader's own expression")
  assert.doesNotMatch(sql, /:=\s*now\(\)/, 'now() is transaction-start time and can predate the claim')
  assert.match(
    sql,
    /IF NEW\."backReferenceFollowUpsPendingAt" IS NULL THEN\s*\n\s*NEW\."backReferenceFollowUpsClaimedAtDatabaseClock" := NULL;/,
    'a discharged obligation must not keep a claim time',
  )
  assert.match(
    sql,
    /ELSE\s*\n\s*NEW\."backReferenceFollowUpsClaimedAtDatabaseClock" := OLD\."backReferenceFollowUpsClaimedAtDatabaseClock";/,
    'an unchanged marker carries the OLD stamp over, so no statement can supply its own value',
  )
  assert.match(sql, /BEFORE UPDATE OF "backReferenceFollowUpsPendingAt", "backReferenceFollowUpsClaimedAtDatabaseClock"/)
  assert.match(sql, /BEFORE INSERT ON "accounting_sync_logs"/)
})

// ---------------------------------------------------------------------------
// o3d-0bfh r8 (Codex HIGH) — REMOTE ABSENCE IS NOT PROOF THAT CREATION IS SAFE.
//
// r7's remedy told an operator to read QuickBooks and "create ONLY what is verifiably absent".
// `enqueueFollowUps` writes each follow-up as its own local sync-log row and enqueues
// INVOICE_PAYMENT BEFORE INVOICE_PDF, so the ordinary way this marker is retained — the PDF enqueue
// failing — leaves a payment already PENDING and simply not executed yet. An operator reading
// QuickBooks in that window finds no payment, creates one, and the queued row posts its own
// afterwards. The connector's request id cannot deduplicate a payment a human made in the QuickBooks
// UI, and a second payment against an invoice is not undoable.
//
// The serialized recovery workflow that would make creation safe — hold or cancel every local
// follow-up row for the document under one lock, then reconcile the remote — does not exist and is
// gated on o3d-8prh. So no surface may authorise a creation. These tests are what stops the
// instruction coming back.
// ---------------------------------------------------------------------------

/**
 * THE ONE LIST. The instructions no surface may carry for a retained follow-up obligation, with why.
 *
 * Every check in this file runs THIS array — the registry strings, the exception inbox, the operator
 * documentation, the connector's activity messages. A pattern added for one is a pattern added for
 * all, which is the whole point: the r8 failure was two lists, and the r9 failure was that the list
 * covering the RENDERED strings was the smaller of the two, so `re-driven by hand` was banned in the
 * UI and permitted in the registry entry the UI renders.
 */
const BANNED_OPERATOR_INSTRUCTIONS: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\bcreate (only|ONLY)\b/,
    why: 'remote absence is not proof that creation is safe — a payment can be PENDING in the local queue while '
      + 'the accounting package shows none',
  },
  {
    // The lookbehind exempts the exception-inbox SECTION TITLE ("...with nothing to re-drive
    // them"), which is a statement that nothing will, not an instruction that somebody should.
    pattern: /(?<!nothing to )re-?driv(e|en) (it|them|this|the)\b/i,
    why: 'a re-drive on the money path can double a payment already queued',
  },
  {
    pattern: /re-?driven by hand/i,
    why: 'same: it authorises a hand-made payment that no request id can deduplicate',
  },
  {
    // NOT pinned to one accounting package (o3d-0bfh r11, Codex HIGH). The Xero processor shipped
    // "register the receipt in Xero by hand" through the round that grew this list to eleven, and a
    // pattern naming QuickBooks could not see it. The instruction is the danger, not the vendor.
    pattern: /register the (receipt|payment) in \w+ by hand/i,
    why: 'a payment created in the accounting package\'s UI cannot be deduplicated against the queued row',
  },
  {
    pattern: /re-run the invoice sync/i,
    why: 'it is a re-drive instruction wearing different words',
  },
]

/** Runs the ONE list over one string, naming the surface in every failure. */
function assertNoBannedInstruction(what: string, text: string): void {
  for (const { pattern, why } of BANNED_OPERATOR_INSTRUCTIONS) {
    assert.doesNotMatch(text, pattern, `${what} carries a banned operator instruction — ${why}`)
  }
}

/** A connector that is deliberately NOT in the registry, so the fallback branch is exercised. */
const UNDECLARED_CONNECTOR = 'sage'

/**
 * EVERY RUNTIME STRING THE REMEDY SURFACES RETURN, taken from the functions that produce them rather
 * than from the constants they happen to be built out of today.
 *
 * `describeFollowUpObligationBacklogRow` is the ONE producer: the exception inbox renders its
 * `blockedBy` and `operatorRemedy` per row, and `followUpObligationRecoveryNote` composes the same
 * remedy into every activity message and console line. So this walks every connector the registry
 * declares PLUS an undeclared one, and takes both strings from each.
 *
 * Reading it through the describer rather than off the registry constants is deliberate — r9's
 * finding was a string that existed only in a surface. `blockedBy` is included for the same reason:
 * it is rendered beside the remedy and an instruction in it reads exactly like an instruction.
 */
function remedySurfaces(): Array<{ what: string; text: string; mustEscalate: boolean }> {
  const connectors = [...Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY), UNDECLARED_CONNECTOR]
  // Non-vacuity: the walk must cover the connector the finding is about AND the fallback branch.
  assert.ok(connectors.includes('quickbooks'), 'the registry must still declare quickbooks')
  assert.ok(connectors.includes('xero'), 'and xero, whose consumer branch produces its own strings')
  assert.equal(ACCOUNTING_FOLLOW_UP_RECOVERY[UNDECLARED_CONNECTOR], undefined,
    `${UNDECLARED_CONNECTOR} must stay undeclared, or this stops exercising the fallback`)

  const surfaces: Array<{ what: string; text: string; mustEscalate: boolean }> = []
  for (const connector of connectors) {
    const recovery = followUpObligationRecoveryFor(connector)
    const row = describeFollowUpObligationBacklogRow({
      id: `log-${connector}`,
      connector,
      type: 'SALES_INVOICE',
      status: 'SYNCED',
      referenceType: 'SalesOrder',
      referenceId: 'so-1',
      externalTransactionId: 'INV-1',
      backReferenceFollowUpsPendingAt: new Date('2026-01-01T00:00:00.000Z'),
      backReferenceFollowUpsClaimedAtDatabaseClock: new Date('2026-01-01T00:00:00.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    // A connector WITH a consumer never reaches this backlog, so its two strings are the
    // "these two disagree" diagnostics rather than a remedy: scanned, but not required to escalate.
    const noConsumer = recovery.consumer === 'none'
    surfaces.push({
      what: `the ${connector} remedy rendered by describeFollowUpObligationBacklogRow`,
      text: row.operatorRemedy,
      mustEscalate: noConsumer,
    })
    surfaces.push({
      what: `the ${connector} blockedBy text rendered beside it`,
      text: row.blockedBy,
      mustEscalate: false,
    })
  }
  surfaces.push({
    what: 'FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN (the exception inbox section detail)',
    text: FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN,
    mustEscalate: true,
  })
  return surfaces
}

test('[o3d-0bfh r8/r10] no runtime remedy string authorises creating a payment, judged by THE ONE LIST', () => {
  // Route: describeFollowUpObligationBacklogRow(...).operatorRemedy and .blockedBy for EVERY
  // registry connector plus an undeclared one, and FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN — i.e.
  // every string the exception inbox renders and every string followUpObligationRecoveryNote
  // composes into an activity message or a console line.
  //
  // r9 left this test running a SMALLER inline list of its own while the UI and processor scans ran
  // BANNED_OPERATOR_INSTRUCTIONS. The two disagreed on `re-driven by hand`, and the disagreement fell
  // exactly where it mattered: the registry remedy is the string the UI interpolates, so a phrase the
  // UI scan banned was permitted in the value the UI displays. There is now one list and it is this
  // one; the inline copy is gone.
  //
  // Mutation: put r7's "create ONLY what is verifiably absent" into any remedy, or append
  // "this still has to be re-driven by hand" to QUICKBOOKS_RECOVERY.operatorRemedy, and this fails
  // naming the surface. Drop "escalate" and the escalation assertion fails, which is what stops the
  // fix being "delete the sentence and say nothing". See the dedicated control below.
  const surfaces = remedySurfaces()
  // Two strings per registry connector, two for the undeclared fallback, plus the section detail.
  assert.equal(
    surfaces.length, (Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY).length + 1) * 2 + 1,
    'every connector contributes BOTH of its rendered strings, or the walk is not exhaustive',
  )
  for (const { what, text, mustEscalate } of surfaces) {
    assert.ok(text.length > 0, `${what} must actually be a string, or this scan reads nothing`)
    assertNoBannedInstruction(what, text)
    if (mustEscalate) assert.match(text, /escalat/i, `${what} must say what to do instead of creating: escalate`)
  }

  // And the QuickBooks remedy has to explain WHY reading first is not enough, or the next round
  // reinstates it as an obvious improvement.
  const quickbooks = surfaces.find((surface) => surface.what.startsWith('the quickbooks remedy'))
  assert.ok(quickbooks, 'the QuickBooks remedy must be one of the surfaces walked')
  assert.match(quickbooks.text, /PENDING/, 'it names the state the queued payment is actually in')
  assert.match(quickbooks.text, /INVOICE_PAYMENT[\s\S]*INVOICE_PDF/, 'and the enqueue ORDER that creates the window')
  assert.match(quickbooks.text, /DO NOT CREATE/, 'and it refuses in as many words')
})

test('[o3d-0bfh r10] CONTROL: the shipped registry remedy with `re-driven by hand` appended is REFUSED', () => {
  // THE CODEX MEDIUM, AS A CONTROL. The claim "one list covers the rendered strings" is worth
  // nothing unless the list can be shown to reject the exact instruction it says it bans, ON THE
  // EXACT STRING the finding named. r9's registry check could not: its inline list had no
  // `re-driven by hand` pattern, so appending that sentence to QUICKBOOKS_RECOVERY.operatorRemedy
  // while keeping all the unknown/escalate prose passed every test in this file and was rendered in
  // the inbox and in every activity message.
  //
  // Route: the SHIPPED string, mutated here rather than in the registry, so the control cannot rot
  // into a test of a hardcoded sentence. If the registry remedy is rewritten, this mutates whatever
  // it has become.
  const shipped = followUpObligationRecoveryFor('quickbooks')
  assert.equal(shipped.consumer, 'none')
  if (shipped.consumer !== 'none') return
  // The shipped string passes — the precondition, so a list that rejected everything would not
  // satisfy this control either.
  assertNoBannedInstruction('the shipped QuickBooks remedy', shipped.operatorRemedy)

  const mutated = `${shipped.operatorRemedy}. Note that this still has to be re-driven by hand`
  assert.throws(
    () => assertNoBannedInstruction('the mutated QuickBooks remedy', mutated),
    /banned operator instruction/,
    'THE ONE LIST must reject `re-driven by hand` in the registry remedy — this is the surface the '
      + 'exception inbox and every retained-obligation log line interpolate, and it is where r9 let it through',
  )

  // And the other three instructions the r7 rounds produced, on the same shipped string, so the
  // control covers the list rather than one entry of it.
  for (const phrase of [
    ' Read the ledger and create ONLY what is verifiably absent',
    ' If it is missing, register the receipt in QuickBooks by hand',
    ' Otherwise re-run the invoice sync for this reference',
  ]) {
    assert.throws(
      () => assertNoBannedInstruction('the mutated QuickBooks remedy', shipped.operatorRemedy + phrase),
      /banned operator instruction/,
      `THE ONE LIST must reject "${phrase.trim()}" in the registry remedy`,
    )
  }
})

test('[o3d-0bfh r8] the QuickBooks processor no longer asserts that follow-up work was not enqueued', () => {
  // The registry is not the only surface: the processor writes its own activity-log descriptions,
  // and r7 corrected the registry while leaving "its follow-up work was NOT enqueued ... need to be
  // re-driven manually" and "re-run the invoice sync for this reference, or register the receipt in
  // QuickBooks by hand" in the processor.
  //
  // Route: lib/connectors/quickbooks/sync-processor.ts, executable source (comments removed, string
  // CONTENTS kept — these are strings, and the string is the surface).
  //
  // Mutation: restore either sentence and this fails naming it.
  const source = readSource(path.join(REPO_ROOT, 'lib', 'connectors', 'quickbooks', 'sync-processor.ts'))
  const banned: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /work was NOT\s+`?\s*\+?\s*`?enqueued/, why: 'the marker survives a pass whose enqueues succeeded' },
    { pattern: /need to be re-driven manually/, why: 'a re-drive can double a payment already queued' },
    { pattern: /register the receipt in QuickBooks by hand/, why: 'a hand-made payment cannot be deduplicated' },
    { pattern: /re-run the invoice\s+`?\s*\+?\s*'?sync for this reference/, why: 'same: it is a re-drive instruction' },
  ]
  for (const { pattern, why } of banned) {
    assert.doesNotMatch(
      source.code, pattern,
      `lib/connectors/quickbooks/sync-processor.ts still tells an operator to act on this row — ${why}`,
    )
  }
  // CONTROL: the scanner is looking at the right file and the right text. The description that
  // REPLACED them is present, so a rename or a failed read cannot make the four assertions vacuous.
  assert.match(source.code, /HOW FAR IT GOT IS NOT KNOWN FROM HERE/, 'the replacement wording must be the thing there')
})

// ---------------------------------------------------------------------------
// o3d-0bfh r9 (Codex HIGH) — THE REGISTRY IS NOT THE SURFACE. THE SURFACE IS.
//
// r8 corrected the registry's remedy and the QuickBooks processor's log lines, and the test above
// asserted both. It protected nobody: the exception inbox's own SectionHeading held an INDEPENDENT
// copy of the sentence being removed — "create only what is verifiably absent" — and that is the
// sentence an operator actually reads. One rule, two authors, one of them fixed. The same round
// left a third copy in help-docs/xero-sync.md ("a QuickBooks follow-up that fails still has to be
// re-driven by hand") and a fourth in a code comment that justified the row as "the remedy is a
// human act in the accounting package (register the payment, ...)" — which is where UI prose comes
// from.
//
// So the contract is no longer "the registry strings are safe". It is:
//
//   1. NO OPERATOR-FACING SURFACE AUTHORS ITS OWN INSTRUCTION FOR THESE ROWS. The inbox section
//      renders `FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN` and each row renders its connector's own
//      `operatorRemedy`; a literal `detail="..."` on that section is banned outright, because a
//      literal is the only way a second copy can exist.
//   2. AND every surface that still writes prose about these rows — the processor's activity
//      messages, the operator documentation — is scanned for the same banned instructions the
//      registry strings are.
//
// (1) is the part that stops a THIRD copy appearing; (2) is the part that catches one that already
// has. Both are needed: a scan alone would have missed nothing here, but it also cannot stop
// somebody writing a fresh paragraph that happens to avoid the banned words.
// ---------------------------------------------------------------------------

/** The UI section for this backlog, sliced out of the inbox by its own section markers. */
function accountingFollowUpSection(): { slice: string; whole: string } {
  const full = path.join(REPO_ROOT, 'app', '(dashboard)', 'sync', 'exceptions', 'exceptions-client.tsx')
  const { code } = readSource(full)
  const marker = /\{data\.\w+\.length > 0 \? \(/g
  const starts: number[] = []
  for (let m = marker.exec(code); m; m = marker.exec(code)) starts.push(m.index)
  const start = starts.findIndex((index) => code.startsWith('{data.accountingFollowUpObligations', index))
  assert.notEqual(start, -1, 'the accounting follow-up section must still be rendered by the exception inbox')
  const end = starts[start + 1] ?? code.length
  return { slice: code.slice(starts[start]!, end), whole: code }
}

test('[o3d-0bfh r9] the exception inbox renders the registry remedy and authors no instruction of its own', () => {
  // THE R8 DEFECT, AS A TEST. The registry said read-and-escalate while this SectionHeading said
  // "create only what is verifiably absent", and nothing compared them because nothing looked at
  // the UI at all.
  //
  // Route: app/(dashboard)/sync/exceptions/exceptions-client.tsx -> <SectionHeading detail={...}>
  // for `data.accountingFollowUpObligations`, and the per-row cell that renders
  // `row.operatorRemedy` (produced by describeFollowUpObligationBacklogRow straight off the
  // registry). Executable source, comments stripped: a comment is not a surface, a rendered string
  // is.
  //
  // Mutation: put the r8 paragraph back as `detail="These documents reached ... create only what is
  // verifiably absent ..."` and BOTH the literal-detail assertion and the banned-instruction scan
  // fail; change the cell to a hardcoded sentence and the `row.operatorRemedy` assertion fails.
  const { slice } = accountingFollowUpSection()

  // CONTROL: the slice is the right region and is not the whole file, so the assertions below
  // cannot pass by looking at nothing.
  assert.match(slice, /Accounting follow-ups owed, with nothing to re-drive them/, 'the slice is this section')
  assert.match(slice, /<SectionHeading/, 'and it contains the heading being checked')
  assert.equal(slice.includes('productStructureConflicts'), false, 'and stops before the next section')

  // 1. THE SECTION TEXT IS THE REGISTRY'S OWN STRING, not a restatement of it.
  assert.match(
    slice, /detail=\{FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN\}/,
    'the section detail must BE the registry string, not a copy that can go stale independently',
  )
  // 2. AND A LITERAL IS BANNED OUTRIGHT — this is the assertion that stops a third copy, because a
  //    literal is the only way one can exist. A scan for bad words cannot do this: the next author
  //    would simply phrase the authorisation differently.
  assert.doesNotMatch(
    slice, /detail="/,
    'a literal section detail is how the r8 copy survived a round that corrected the registry',
  )
  // 3. AND THE PER-ROW REMEDY COMES FROM THE ROW, i.e. from the connector's registry entry.
  assert.match(
    slice, /\{row\.operatorRemedy\}/,
    'each row must render its connector\'s declared remedy rather than a sentence written here',
  )

  assertNoBannedInstruction("the exception inbox's accounting follow-up section", slice)
})

test('[o3d-0bfh r9] the operator documentation for these rows authorises no hand settlement either', () => {
  // THE THIRD COPY. help-docs/xero-sync.md is what an operator is pointed at, and it said "a
  // QuickBooks follow-up that fails still has to be re-driven by hand" for the whole of r8.
  //
  // Route: help-docs/xero-sync.md, every paragraph that talks about QuickBooks AND follow-ups —
  // i.e. about the connector this backlog exists for. Paragraphs about Xero's sweep are a different
  // mechanism (it has a consumer) and are deliberately out of scope, so the scan is not silently
  // wider than the finding.
  //
  // Mutation: restore "a QuickBooks follow-up that fails still has to be re-driven by hand" and
  // this fails naming the paragraph; delete the paragraphs entirely and the non-vacuity control
  // below fails instead of the test passing on an empty set.
  const doc = readFileSync(path.join(REPO_ROOT, 'help-docs', 'xero-sync.md'), 'utf8')
  const paragraphs = doc.split(/\n\s*\n/)
  const scoped = paragraphs.filter((p) => /quickbooks/i.test(p) && /follow-?ups?\b/i.test(p))

  assert.equal(scoped.length > 0, true, 'the documentation must still describe the QuickBooks follow-up backlog')
  for (const paragraph of scoped) {
    assertNoBannedInstruction(`help-docs/xero-sync.md (${paragraph.slice(0, 80).replace(/\s+/g, ' ')}…)`, paragraph)
  }
  // CONTROL: the doc still carries the refusal, so "delete the guidance" is not a passing strategy.
  assert.match(
    doc, /Do not settle one of these rows by hand/,
    'the documentation must say what an operator may NOT do, not merely stop saying what they may',
  )
})

test('[o3d-0bfh r9] the activity messages and the shared recovery note carry the registry remedy, not their own', () => {
  // The processor's own strings were corrected in r8 and are re-checked here against the SHARED
  // banned list rather than a second list that can drift from it — two lists is the r8 failure in
  // miniature.
  //
  // Route: lib/connectors/quickbooks/sync-processor.ts (activity-log descriptions and warnings) and
  // lib/domain/accounting/back-reference.ts (`followUpObligationRecoveryNote`, the one definition
  // every `console.error` on this path composes its message from).
  //
  // Mutation: restore any r7 instruction to either file and the scan fails naming it; make
  // followUpObligationRecoveryNote restate a remedy instead of interpolating
  // `recovery.operatorRemedy` and the composition assertion fails.
  const processor = readSource(path.join(REPO_ROOT, 'lib', 'connectors', 'quickbooks', 'sync-processor.ts'))
  const backReference = readSource(path.join(REPO_ROOT, 'lib', 'domain', 'accounting', 'back-reference.ts'))

  for (const source of [processor, backReference]) assertNoBannedInstruction(source.rel, source.code)

  // The shared note must COMPOSE the registry's remedy, so a connector's declaration is what an
  // operator reads wherever the note is logged.
  assert.match(
    backReference.code, /\$\{recovery\.operatorRemedy\}/,
    'followUpObligationRecoveryNote must interpolate the declared remedy rather than restate one',
  )
  // CONTROL: the scanner read the files it names.
  assert.match(processor.code, /Accounting follow-ups owed, with nothing to re-drive them/)
  assert.match(backReference.code, /followUpObligationRecoveryNote/)
})

test('[o3d-0bfh r9] the marker scan REFUSES the shapes it cannot read, instead of assuming them safe', () => {
  // CODEX MEDIUM, AS CONTROLS. r8 called its rule an allowlist, but `judgeMarkerValue` returned
  // "safe" for every resolved expression that was not an inline object literal — so a predicate
  // built by a helper or imported from elsewhere walked straight through the thing that was
  // supposed to have to be widened deliberately. These snippets are the escape routes, each run
  // through the real scanner.
  //
  // Route: markerClockReads() — the same function the repository-wide test above runs over ~700
  // files. Proving it on synthetic sources is the only way to show it can FAIL: the repository is
  // clean, so the wide test passes whether the scan works or not.
  //
  // Mutation: drop the `strict` argument at the `where`-side call, or return null from
  // judgeMarkerPredicateOperand, and the first four fail. Remove the alias tracking and the
  // destructuring case fails; remove flattenTemplate and the composed-SQL case fails.
  const refused: Array<{ what: string; code: string }> = [
    {
      // CODEX r9 MEDIUM, AND THE REASON r10 EXISTS. r9 refused the helper-built OPERAND and left the
      // helper-built WHOLE CLAUSE open, because `predicateClauses` answered "no clauses" for a call
      // it could not resolve. The literal inside the function was then visited on its own, OUTSIDE
      // predicate context, where the judge runs non-strictly and accepts a call operand. Two
      // fail-open answers, each covering for the other, and the range comparison came straight back.
      what: 'A HELPER RETURNING THE WHOLE WHERE CLAUSE',
      code: 'function stale(cutoff) { return { backReferenceFollowUpsPendingAt: olderThan(cutoff) } }\n'
        + 'await db.accountingSyncLog.findMany({ where: stale(cutoff) })',
    },
    {
      what: 'the same helper written as an arrow',
      code: 'const stale = (cutoff) => ({ backReferenceFollowUpsPendingAt: olderThan(cutoff) })\n'
        + 'await db.accountingSyncLog.findMany({ where: stale(cutoff) })',
    },
    {
      what: 'a helper returning a whole clause into an AND array',
      code: 'function stale(cutoff) { return { backReferenceFollowUpsPendingAt: { lt: cutoff } } }\n'
        + 'await db.accountingSyncLog.findMany({ where: { AND: [stale(cutoff)] } })',
    },
    {
      // The branch the return-following deliberately will NOT guess at: two returns, so the clause
      // is unknown. Unknown is an OFFENCE now, which is the half of the fix that does not depend on
      // being able to read the helper at all.
      what: 'a helper with two returns, so the clause it builds is unknowable',
      // Both branches use a CALL operand on purpose: a `{ lt: c }` literal would be caught by the
      // range-operator rule wherever it sits, so the case would not discriminate. This one is
      // invisible to every other check in the scan, and is caught only because an unreadable
      // predicate that names the column is now an offence in its own right.
      code: 'function stale(c, flag) { if (flag) { return { backReferenceFollowUpsPendingAt: olderThan(c) } }\n'
        + ' return { backReferenceFollowUpsPendingAt: notOlderThan(c) } }\n'
        + 'await db.accountingSyncLog.findMany({ where: stale(cutoff, true) })',
    },
    {
      what: 'a helper-built range predicate',
      code: 'const cutoff = new Date(); await db.accountingSyncLog.findMany({ where: { backReferenceFollowUpsPendingAt: olderThan(cutoff) } })',
    },
    {
      what: 'an imported filter object reached by property access',
      code: 'import { FILTERS } from "./filters"; await db.accountingSyncLog.findMany({ where: { backReferenceFollowUpsPendingAt: FILTERS.stale } })',
    },
    {
      what: 'a filter returned from an awaited call',
      code: 'await db.accountingSyncLog.findMany({ where: { backReferenceFollowUpsPendingAt: await buildStaleFilter() } })',
    },
    {
      what: 'a clause built elsewhere and passed in by name',
      code: 'const stale = { backReferenceFollowUpsPendingAt: makeFilter(cutoff) }; await db.accountingSyncLog.findMany({ where: stale })',
    },
    {
      what: 'a helper-built predicate inside an AND array',
      code: 'await db.accountingSyncLog.findMany({ where: { AND: [{ backReferenceFollowUpsPendingAt: olderThan(cutoff) }] } })',
    },
    {
      what: 'a helper-built operand behind an identity operator',
      code: 'await db.accountingSyncLog.findMany({ where: { backReferenceFollowUpsPendingAt: { not: olderThan(cutoff) } } })',
    },
    {
      what: 'a destructured marker alias compared to a clock',
      code: 'const { backReferenceFollowUpsPendingAt: pendingAt } = row; if (pendingAt < cutoff) { park(row) }',
    },
    {
      what: 'a shorthand-destructured marker compared to a clock',
      code: 'const { backReferenceFollowUpsPendingAt } = row; if (backReferenceFollowUpsPendingAt < cutoff) { park(row) }',
    },
    {
      what: 'raw SQL composed from a column constant',
      code: 'const MARKER_COLUMN = "backReferenceFollowUpsPendingAt"; await db.$queryRaw(sql`SELECT 1 FROM "accounting_sync_logs" WHERE "${MARKER_COLUMN}" < $1`)',
    },
    {
      // CODEX r10 MEDIUM. `calleeFunction` followed BARE IDENTIFIER calls only, so a predicate
      // builder reached through a property access resolved to nothing — and that nothing was
      // accepted twice over, exactly as r10 described for plain functions: `predicateClauses`
      // handed back an unresolved expression, `couldConcernMarker` cleared it because neither the
      // call text nor (there being no callee) any body named the column, and the literal inside the
      // method was visited on its own OUTSIDE predicate context, where the judge runs non-strictly
      // and lets a call operand through. Same two fail-open answers, different syntax.
      what: 'A LOCAL OBJECT METHOD RETURNING THE WHOLE WHERE CLAUSE',
      code: 'const predicates = { stale(cutoff) { return { backReferenceFollowUpsPendingAt: olderThan(cutoff) } } }\n'
        + 'await db.accountingSyncLog.findMany({ where: predicates.stale(cutoff) })',
    },
    {
      what: 'the same method written as an arrow property',
      code: 'const predicates = { stale: (cutoff) => ({ backReferenceFollowUpsPendingAt: olderThan(cutoff) }) }\n'
        + 'await db.accountingSyncLog.findMany({ where: predicates.stale(cutoff) })',
    },
    {
      what: 'a local object method returning a whole clause into an AND array',
      code: 'const predicates = { stale(cutoff) { return { backReferenceFollowUpsPendingAt: { lt: cutoff } } } }\n'
        + 'await db.accountingSyncLog.findMany({ where: { AND: [predicates.stale(cutoff)] } })',
    },
    {
      // The method equivalent of the two-return helper: unreadable, and named on the marker only
      // through the body the property access now reaches. Invisible to every other check.
      what: 'a local object method with two returns, so the clause it builds is unknowable',
      code: 'const predicates = { stale(c, flag) { if (flag) { return { backReferenceFollowUpsPendingAt: olderThan(c) } }\n'
        + ' return { backReferenceFollowUpsPendingAt: notOlderThan(c) } } }\n'
        + 'await db.accountingSyncLog.findMany({ where: predicates.stale(c, true) })',
    },
    {
      what: 'a local object method producing only the OPERAND',
      code: 'const predicates = { staleAt(cutoff) { return { lt: cutoff } } }\n'
        + 'await db.accountingSyncLog.findMany({ where: { backReferenceFollowUpsPendingAt: predicates.staleAt(cutoff) } })',
    },
    {
      // CODEX r11 MEDIUM. r11 replaced a call with the callee's return expression and never bound
      // the FORMAL PARAMETERS to the ACTUAL ARGUMENTS, so this resolved to
      // `{ MARKER: generation }` — and `generation` is an ALLOWLISTED protocol operand name. The
      // argument carrying the range comparison was the one thing not looked at, and the shape read
      // as the compare-and-set fence the protocol is built on.
      what: 'AN ALLOWLISTED PARAMETER NAME HOLDING A RANGE-BUILDING ARGUMENT',
      code: 'const predicates = { stale(generation) { return { backReferenceFollowUpsPendingAt: generation } } }\n'
        + 'await db.accountingSyncLog.findMany({ where: predicates.stale(olderThan(cutoff)) })',
    },
    {
      what: 'the same, with a clock read as the argument',
      code: 'const predicates = { stale(generation) { return { backReferenceFollowUpsPendingAt: generation } } }\n'
        + 'await db.accountingSyncLog.findMany({ where: predicates.stale(new Date()) })',
    },
    {
      what: 'the same, through a plain function rather than a method',
      code: 'function stale(marker) { return { backReferenceFollowUpsPendingAt: marker } }\n'
        + 'await db.accountingSyncLog.findMany({ where: stale(olderThan(cutoff)) })',
    },
    {
      what: 'the same, with the range literal handed in directly as the argument',
      code: 'function stale(pendingAt) { return { backReferenceFollowUpsPendingAt: pendingAt } }\n'
        + 'await db.accountingSyncLog.findMany({ where: stale({ lt: cutoff }) })',
    },
    {
      // The fail-closed half: the parameter cannot be paired with an argument at all, so an
      // allowlisted name must not be read as a generation just because it is spelled like one.
      what: 'an allowlisted parameter with NO argument passed for it',
      code: 'function stale(generation) { return { backReferenceFollowUpsPendingAt: generation } }\n'
        + 'await db.accountingSyncLog.findMany({ where: stale() })',
    },
    {
      what: 'an allowlisted name arriving through a DESTRUCTURED parameter',
      code: 'function stale({ generation }) { return { backReferenceFollowUpsPendingAt: generation } }\n'
        + 'await db.accountingSyncLog.findMany({ where: stale({ generation: olderThan(cutoff) }) })',
    },
    {
      what: 'an allowlisted parameter reached through a SPREAD call, where no index can be trusted',
      code: 'function stale(flag, generation) { return { backReferenceFollowUpsPendingAt: generation } }\n'
        + 'await db.accountingSyncLog.findMany({ where: stale(...args) })',
    },
    {
      // AND THE SHADOWING ROUTE. Without deleting the parameter names from the scope first, the
      // outer `const generation` would be read through the parameter and the argument lost again —
      // a clean-looking result built from a value the call never passed.
      what: 'an allowlisted parameter SHADOWING an outer binding of the same name',
      code: 'const generation = someRow.backReferenceFollowUpsPendingAt\n'
        + 'function stale(generation) { return { backReferenceFollowUpsPendingAt: generation } }\n'
        + 'await db.accountingSyncLog.findMany({ where: stale(olderThan(cutoff)) })',
    },
    {
      // CODEX r12 MEDIUM, VERBATIM — THE SAME-NAME CAPTURE. r12 installed the caller's RAW argument
      // expression into the callee's table, which is a valid substitution only while the callee
      // redefines no name the argument reads. Here it redefines the very one: the binding
      // `generation → generation` points at ITSELF, `resolveIn` follows it once, marks the name
      // seen and stops, and hands back a bare identifier. The `olderThan(cutoff)` the caller
      // actually passed is never looked at, and the name is waved through by the allowlist. This is
      // the shipped probe from the review, and it returned NO offences.
      what: 'AN ARGUMENT CAPTURED BY A PARAMETER OF ITS OWN NAME, HIDING THE CALLER FROM ITSELF',
      code: 'const generation = olderThan(cutoff)\n'
        + 'function stale(generation) { return { backReferenceFollowUpsPendingAt: generation } }\n'
        + 'await db.accountingSyncLog.findMany({ where: stale(generation) })',
    },
    {
      what: 'the same capture through an object method rather than a plain function',
      code: 'const generation = olderThan(cutoff)\n'
        + 'const predicates = { stale(generation) { return { backReferenceFollowUpsPendingAt: generation } } }\n'
        + 'await db.accountingSyncLog.findMany({ where: predicates.stale(generation) })',
    },
    {
      // The same defect without the self-reference: two parameters whose names are each other's
      // arguments. Substituting both raw expressions makes the pair resolve in a circle.
      what: 'two arguments SWAPPED into parameters named after each other',
      code: 'const generation = params.generation\n'
        + 'const cutoff = olderThan(now)\n'
        + 'function stale(generation, cutoff) { return { backReferenceFollowUpsPendingAt: generation } }\n'
        + 'await db.accountingSyncLog.findMany({ where: stale(cutoff, generation) })',
    },
    {
      // And the capture buried inside a larger argument, so the check cannot be "is the argument
      // exactly this identifier".
      what: 'a captured name reached inside a composed argument',
      code: 'const generation = olderThan(cutoff)\n'
        + 'function stale(generation) { return { backReferenceFollowUpsPendingAt: generation } }\n'
        + 'await db.accountingSyncLog.findMany({ where: stale(pick(generation)) })',
    },
  ]
  for (const { what, code } of refused) {
    const offences = markerClockReads(code, 'control.ts')
    assert.ok(
      offences.length > 0,
      `the scan accepted ${what}. An unrecognised shape must be REFUSED, not assumed safe — that is the whole `
        + `difference between an allowlist and r7's banlist:\n${code}`,
    )
  }

  // AND THE OTHER DIRECTION, or "refuse everything" would pass the block above. These are the
  // protocol's own uses, and the scan must stay quiet on all of them — this is what stops the fix
  // being made by turning the allowlist into a refusal of the code that already exists.
  const allowed: Array<{ what: string; code: string }> = [
    {
      what: 'the null test the backlog query asks',
      code: 'const where = { backReferenceFollowUpsPendingAt: { not: null } }; await db.accountingSyncLog.findMany({ where })',
    },
    {
      what: 'the compare-and-set fence, operand read off a parameter',
      code: 'await db.accountingSyncLog.updateMany({ where: { id: params.syncLogId, backReferenceFollowUpsPendingAt: params.generation }, data: { backReferenceFollowUpsPendingAt: null } })',
    },
    {
      what: 'the settlement fence, operand read off a fence object',
      code: 'await db.accountingSyncLog.updateMany({ where: { id: fence.id, backReferenceFollowUpsPendingAt: fence.followUpsPendingAt }, data: { backReferenceCheckedAt: now() } })',
    },
    {
      what: 'the claim fence, operand aliased from the row',
      code: 'const observed = row.backReferenceFollowUpsPendingAt; await db.accountingSyncLog.updateMany({ where: { id: row.id, backReferenceFollowUpsPendingAt: observed }, data: claim })',
    },
    {
      what: 'the mint, which is an ASSIGNMENT and not a predicate',
      code: 'function followUpObligationClaim(now: Date) { return { backReferenceFollowUpsPendingAt: now } }',
    },
    {
      what: 'selecting the column',
      code: 'await db.accountingSyncLog.findFirst({ select: { backReferenceFollowUpsPendingAt: true } })',
    },
    {
      what: 'a null equality test written plainly',
      code: 'await db.accountingSyncLog.findMany({ where: { backReferenceFollowUpsPendingAt: null } })',
    },
    {
      // THE OTHER HALF OF r10, and the reason the fix follows a local function's return instead of
      // simply refusing every unreadable clause that names the column. The protocol's own backlog
      // predicate IS built by a helper, and a rule that refused this would refuse the code it exists
      // to protect — which is how a rule stops being run.
      what: 'a LOCAL HELPER returning the protocol\'s own existence predicate as a whole where clause',
      code: 'function owedWhere() { return { backReferenceFollowUpsPendingAt: { not: null } } }\n'
        + 'await db.accountingSyncLog.findMany({ where: owedWhere() })',
    },
    {
      what: 'a local helper returning the equality fence as a whole where clause',
      code: 'const fenceWhere = (id, generation) => ({ id, backReferenceFollowUpsPendingAt: generation })\n'
        + 'await db.accountingSyncLog.updateMany({ where: fenceWhere(row.id, generation), data: { backReferenceFollowUpsPendingAt: null } })',
    },
  ]
  for (const { what, code } of allowed) {
    assert.deepEqual(
      markerClockReads(code, 'control.ts'), [],
      `the scan refused ${what}, which is the protocol's own use:\n${code}`,
    )
  }
})

// ---------------------------------------------------------------------------
// o3d-0bfh r11 (Codex HIGH) — THE CONTRACT COVERS THE STRINGS IT IS POINTED AT.
//
// r10 grew THE ONE LIST from three patterns to eleven and ran it over the registry strings, the
// exception inbox, help-docs/xero-sync.md, lib/connectors/quickbooks/sync-processor.ts and
// lib/domain/accounting/back-reference.ts. Through that same round the XERO processor shipped
//
//     "Re-run the invoice sync for this reference, or register the receipt in Xero by hand."
//
// on the connector where the automatic retry actually exists — so the instruction races a queued
// re-enqueue and produces a second, undeduplicable payment. Two of the eleven patterns match that
// sentence. Neither ever saw it, because the scan named two files and this was in a third.
//
// So the list is now pointed at the PRODUCERS: every activity string an operator can receive on
// this path, taken from the function that composes it, plus a whole-file scan of BOTH connector
// sync-processors so a string nobody thought to extract cannot hide behind the ones that were.
// ---------------------------------------------------------------------------

/**
 * EVERY OPERATOR-FACING STRING THIS PATH CAN PRODUCE, taken from its producer at runtime.
 *
 * Not from the constants they are built out of, and not from a source scan: a source scan cannot
 * see a sentence composed at call time, and a constant scan cannot see one composed from two safe
 * halves. `mustEscalate` marks the strings that have to say what to do INSTEAD, so "delete the
 * sentence and say nothing" is not a passing fix.
 */
function activityProducers(): Array<{ what: string; text: string; mustEscalate: boolean }> {
  const produced: Array<{ what: string; text: string; mustEscalate: boolean }> = []

  // 1. THE XERO RETAINED-OBLIGATION ACTIVITY — the producer this finding is about, at runtime.
  produced.push({
    what: 'xeroRetainedFollowUpObligationDescription (the xero_followup_obligation_retained activity)',
    text: xeroRetainedFollowUpObligationDescription('log-xero-1'),
    mustEscalate: true,
  })

  // 2. THE SHARED RECOVERY NOTE, for every connector the registry declares AND the fallback — this
  //    is the string every console.error on the release path composes, and the one the Xero
  //    activity above now interpolates instead of writing prose of its own.
  for (const connector of [...Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY), UNDECLARED_CONNECTOR]) {
    produced.push({
      what: `followUpObligationRecoveryNote for ${connector}`,
      text: followUpObligationRecoveryNote(followUpObligationRecoveryFor(connector)),
      mustEscalate: false,
    })
  }

  // 3. THE SWEEP'S OWN RETAINED-OBLIGATION ACTIVITY (o3d-0bfh r12, Codex HIGH) — the THIRD file to
  //    carry this instruction. Walked for every connector plus the fallback rather than for the one
  //    the sweep is bound to today, because the producer is connector-parameterised and a second
  //    binding would otherwise reach it unexercised.
  for (const connector of [...Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY), UNDECLARED_CONNECTOR]) {
    produced.push({
      what: `sweepRetainedFollowUpObligationDescription for ${connector} `
        + `(the ${connector}_backreference_followups_retained activity)`,
      text: sweepRetainedFollowUpObligationDescription({
        connector,
        connectorLabel: connector === 'xero' ? 'Xero' : connector,
        row: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1' },
      }),
      mustEscalate: true,
    })
  }

  // 4. THE COMPACTED-TOMBSTONE DISCARD ANNOUNCEMENT — the same rows, the same sweep, and the FOURTH
  //    producer of an instruction about outstanding follow-ups. It said "check whether it is missing
  //    and re-drive it manually", which is the hand settlement the whole issue is about: the
  //    interrupted pass writes each follow-up as its own sync row, so one for the discarded part can
  //    already be PENDING or FAILED in the queue.
  //
  //    Every PHASE and both CLASSIFICATION BASES are walked, because the instruction is composed
  //    after the branch and a basis-specific tail would otherwise go unread. The `type-table` basis
  //    is the dangerous one: it OVER-reports, so it can name a payment registration a row never owed.
  for (const phase of ['repaired', 'already-applied', 'processor-short-circuit'] as CompactedFollowUpLossPhase[]) {
    for (const basis of ['row-record', 'type-table', 'unrecognised-key'] as const) {
      produced.push({
        what: `buildCompactedFollowUpLossActivity (${phase}, ${basis})`,
        text: buildCompactedFollowUpLossActivity({
          connectorLabel: 'Xero',
          activityActionPrefix: 'xero',
          phase,
          row: {
            id: 'log-compacted-1',
            type: 'SALES_INVOICE',
            referenceType: 'SalesOrder',
            referenceId: 'so-1',
            externalTransactionId: 'XINV-1',
            backReferenceEvidenceCompactedAt: new Date('2026-01-01T00:00:00.000Z'),
            followUpObligations: basis === 'row-record'
              ? ['payment-registration', 'invoice-pdf']
              : basis === 'unrecognised-key'
                ? ['a-follow-up-this-build-does-not-know']
                : undefined,
          },
        }).description,
        mustEscalate: true,
      })
    }
  }

  // 5. THE PAYMENT-MAPPING REFUSAL (o3d-batch-ret r7, Codex MEDIUM) — THE FIFTH PRODUCER, and the
  //    one r6 wrote WITHOUT pointing this list at it. It lives in
  //    lib/domain/accounting/followup-enqueue-outcome.ts, which is in neither the producer walk nor
  //    the whole-file scan below, so its sentence reached operators on both connectors judged by
  //    nothing. That is r10's failure and r12's failure, for the fifth time and in a fifth file.
  //
  //    BOTH CLAUSE FORMS are walked for EVERY connector, because the producer takes its recovery
  //    half as an ARGUMENT — which is exactly how r6 came to pass a clause that is true of the
  //    retained-marker sweep at a call site where it is false. The registry form is what Xero
  //    passes (two drivers, so it must stay driver-agnostic); the retry form is what QuickBooks
  //    passes (one driver, the processor's own retry of the posted parent).
  for (const connector of [...Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY), UNDECLARED_CONNECTOR]) {
    const atRest = followUpObligationRecoveryNote(followUpObligationRecoveryFor(connector))
    const refusal = (recovery: string) => paymentAccountRefusalMessage({
      connector,
      referenceType: 'SalesOrder',
      referenceId: 'so-1',
      missing: 'no payment account map is configured',
      configure: 'Set up a bank account for each payment method under Settings → Accounting → Payment Account Mapping.',
      recovery,
    })
    produced.push({
      what: `paymentAccountRefusalMessage for ${connector}, registry clause `
        + `(the ${connector}_payment_skipped activity)`,
      text: refusal(atRest),
      mustEscalate: false,
    })
    produced.push({
      what: `paymentAccountRefusalMessage for ${connector}, posted-row retry clause `
        + `(the ${connector}_payment_skipped activity)`,
      // 5 is MAX_RETRIES on both connectors; the number is not what this list judges, the prose is.
      text: refusal(postedRowFollowUpRetryNote({ connector, maxRetries: 5, atRest })),
      mustEscalate: false,
    })
  }

  // 6. THE UNREADABLE-AMOUNT REFUSAL (o3d-batch-ret r8, Codex HIGH) — THE SIXTH PRODUCER, in the
  //    same file as the fifth, and the one r7 would have shipped judged by nothing had this list
  //    not been pointed at it. It is a DIFFERENT sentence from the mapping refusal: there is no
  //    setting to correct, so its remedy is escalation and it must SAY so — `mustEscalate` is true
  //    here and false for the mapping refusal, whose remedy is a screen an operator can go to.
  //
  //    Walked for every registry connector plus the undeclared fallback, because the recovery half
  //    arrives as an ARGUMENT here exactly as it does above, and the r6 lesson is that an argument
  //    is where a clause true of one call site gets passed to one where it is false.
  for (const connector of [...Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY), UNDECLARED_CONNECTOR]) {
    produced.push({
      what: `unreadablePaymentAmountRefusalMessage for ${connector} `
        + `(the ${connector}_payment_skipped activity, reason payment_amount_unreadable)`,
      text: unreadablePaymentAmountRefusalMessage({
        connector,
        referenceType: 'SalesOrder',
        referenceId: 'so-1',
        detail: '`_paymentAmount` is the string "not-a-number", which is not a finite amount',
        recovery: followUpObligationRecoveryNote(followUpObligationRecoveryFor(connector)),
      }),
      mustEscalate: true,
    })
  }
  return produced
}

/** How many strings {@link activityProducers} must yield — stated, so a dropped producer is loud. */
const EXPECTED_ACTIVITY_PRODUCERS =
  // the Xero processor's retained-obligation activity
  1
  // the shared recovery note, and the sweep's retained-obligation activity, for every registry
  // connector plus the undeclared fallback
  + (Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY).length + 1) * 2
  // the compacted-tombstone discard, over three phases and three classification bases
  + 9
  // o3d-batch-ret r7: the payment-mapping refusal, in BOTH clause forms, for every registry
  // connector plus the undeclared fallback
  + (Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY).length + 1) * 2
  // o3d-batch-ret r8: the unreadable-amount refusal, for every registry connector plus the fallback
  + (Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY).length + 1)

test('[o3d-0bfh r11] every activity string an operator can receive is judged by THE ONE LIST, taken from its producer', () => {
  // Route: xeroRetainedFollowUpObligationDescription() — the function that composes the
  // `xero_followup_obligation_retained` activity description — plus
  // followUpObligationRecoveryNote() for every registry connector and the undeclared fallback.
  //
  // Mutation: restore either half of the shipped sentence — "Re-run the invoice sync for this
  // reference" or "register the receipt in Xero by hand" — to the Xero producer and this fails
  // naming the producer. Drop the escalation and the escalate assertion fails, so removing the
  // instruction without replacing it is not a passing fix either.
  const produced = activityProducers()
  assert.equal(
    produced.length, EXPECTED_ACTIVITY_PRODUCERS,
    'the Xero activity, the shared note and the sweep activity for every registry connector and the '
      + 'fallback, the compacted-tombstone discard over every phase and basis, and the payment-mapping '
      + 'refusal in both clause forms for every connector and the fallback, and the unreadable-amount '
      + 'refusal for each of them',
  )
  for (const { what, text, mustEscalate } of produced) {
    assert.ok(text.length > 0, `${what} must actually produce a string, or this scan reads nothing`)
    assertNoBannedInstruction(what, text)
    if (mustEscalate) assert.match(text, /ESCALATE/i, `${what} must say what to do instead: escalate`)
  }

  // NON-VACUITY, on the exact producer the finding named: THE ONE LIST must be able to reject the
  // sentence that shipped. Composed from the shipped string so the control cannot rot into a test
  // of a hardcoded paragraph.
  const shipped = xeroRetainedFollowUpObligationDescription('log-xero-1')
  for (const phrase of [
    ' Re-run the invoice sync for this reference',
    ' Or register the receipt in Xero by hand',
    ' This still has to be re-driven by hand',
  ]) {
    assert.throws(
      () => assertNoBannedInstruction('the mutated Xero activity description', shipped + phrase),
      /banned operator instruction/,
      `THE ONE LIST must reject "${phrase.trim()}" in the Xero activity description — this is the surface `
        + 'that shipped it through the round that grew the list to eleven',
    )
  }

  // AND THE UNSETTLED-OUTCOME CONTROL Codex asked for: this producer is reached ONLY when the
  // deferred receipts are NOT settled, so the string above IS the unsettled outcome. It must name
  // the outstanding receipt — otherwise "make it safe" could be satisfied by making it say nothing.
  assert.match(shipped, /receipt recorded before this invoice is still not registered/)
  assert.match(shipped, /deliberately left marked as owing follow-ups/)
  // ...and it must say what DOES re-drive it, from the registry rather than from prose here.
  assert.match(
    shipped, /a later sweep re-reads the marker and re-enqueues them idempotently/,
    'the recovery half must be the registry\'s declared fact for this connector, not a sentence written in the processor',
  )

  // ---- THE r12 PRODUCER, THE SAME WAY (Codex HIGH). ----
  //
  // Route: sweepRetainedFollowUpObligationDescription() — the function that composes the
  // `<connector>_backreference_followups_retained` activity the SWEEP writes. Mutation: restore
  // either half of the shipped sentence ("so the next sweep retries them", "Register the receipt in
  // Xero by hand if it does not clear") and this fails naming the producer.
  const sweep = sweepRetainedFollowUpObligationDescription({
    connector: 'xero',
    connectorLabel: 'Xero',
    row: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1' },
  })
  for (const phrase of [
    ' Register the receipt in Xero by hand if it does not clear',
    ' Re-run the invoice sync for this reference',
    ' This still has to be re-driven by hand',
  ]) {
    assert.throws(
      () => assertNoBannedInstruction('the mutated sweep activity description', sweep + phrase),
      /banned operator instruction/,
      `THE ONE LIST must reject "${phrase.trim()}" in the sweep's retained-obligation activity — this is the `
        + 'surface that shipped it through the round that pointed the contract at producers',
    )
  }
  // It is the UNSETTLED outcome, so it must still name the outstanding receipt rather than fall
  // silent, and its recovery half must be the REGISTRY's fact about this connector.
  assert.match(sweep, /a receipt recorded before this document is still not registered against it in Xero/)
  assert.match(sweep, /deliberately left marked as owing follow-ups/)
  assert.match(
    sweep, /a later sweep re-reads the marker and re-enqueues them idempotently/,
    'the recovery half must come from the registry, not from a sentence written in the sweep',
  )
  // And on a connector with NO consumer the same producer says so instead of promising the sweep.
  const sweepUndeclared = sweepRetainedFollowUpObligationDescription({
    connector: UNDECLARED_CONNECTOR,
    connectorLabel: UNDECLARED_CONNECTOR,
    row: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1' },
  })
  assert.match(sweepUndeclared, /NOTHING re-enqueues them on this connector/)

  // ---- AND THE COMPACTED-TOMBSTONE DISCARD (o3d-0bfh r12). ----
  //
  // Route: buildCompactedFollowUpLossActivity().description. Mutation: restore "check whether it is
  // missing and re-drive it manually" and this fails naming the producer.
  const compacted = buildCompactedFollowUpLossActivity({
    connectorLabel: 'Xero',
    activityActionPrefix: 'xero',
    phase: 'repaired',
    row: {
      id: 'log-compacted-1',
      type: 'SALES_INVOICE',
      referenceType: 'SalesOrder',
      referenceId: 'so-1',
      externalTransactionId: 'XINV-1',
      backReferenceEvidenceCompactedAt: new Date('2026-01-01T00:00:00.000Z'),
      followUpObligations: ['payment-registration', 'invoice-pdf'],
    },
  }).description
  assert.throws(
    () => assertNoBannedInstruction(
      'the mutated compacted-tombstone discard', `${compacted} Check whether it is missing and re-drive it manually.`,
    ),
    /banned operator instruction/,
    'THE ONE LIST must reject the sentence this producer shipped for eleven rounds',
  )
  // It still NAMES what was lost — "stop saying anything" is not a passing fix — and refuses the
  // hand settlement in as many words.
  assert.match(compacted, /the payment registration can no longer be enqueued/)
  assert.match(compacted, /Nothing here authorises settling that by hand/)
})

test('[o3d-0bfh r11/r12] every FILE that writes about a retained obligation is scanned whole, so an unextracted string cannot hide behind an extracted one', () => {
  // The producer test above can only judge the producers somebody named. This one judges the files,
  // for exactly the reason r10 and r11 both failed: r10's list was pointed at two connector files
  // and the sentence was in a third, and r11's producer walk named the Xero processor while the
  // SWEEP — a fourth file — was still telling an operator to register the receipt by hand.
  //
  // Route: the four modules that compose operator prose about an outstanding follow-up obligation —
  // both connector sync-processors, the sweep, and the compacted-tombstone announcement — as
  // executable source with comments stripped and string CONTENTS kept.
  //
  // DELIBERATELY NOT SCANNED: lib/domain/accounting/follow-up-obligation-registry.ts. Its remedy
  // splits the exception-inbox SECTION TITLE across a string concatenation ("...with nothing to " +
  // "re-drive them"), and the exemption in the second pattern is a lookbehind that a file scan
  // cannot see across the `+`. The registry is judged at RUNTIME instead, by remedySurfaces() above,
  // where the two halves are one string — which is the whole reason the contract is pointed at
  // producers and only backed up by file scans.
  //
  // Mutation: put "Re-run the invoice sync for this reference, or register the receipt in Xero by
  // hand." back into the Xero processor, or "Register the receipt in Xero by hand if it does not
  // clear." back into the sweep, and this fails naming the file.
  const sources = [
    readSource(path.join(REPO_ROOT, 'lib', 'connectors', 'xero', 'sync-processor.ts')),
    readSource(path.join(REPO_ROOT, 'lib', 'connectors', 'quickbooks', 'sync-processor.ts')),
    readSource(path.join(REPO_ROOT, 'lib', 'domain', 'accounting', 'back-reference-sweep.ts')),
    readSource(path.join(REPO_ROOT, 'lib', 'domain', 'accounting', 'compacted-followup-loss.ts')),
    // The LOADER the inbox renders from. It authors no sentence — it spreads the describer's output
    // — and that is asserted below rather than assumed, because a remedy written here would reach an
    // operator through a surface the r9 UI scan does not read.
    readSource(path.join(REPO_ROOT, 'app', 'actions', 'sync-exceptions.ts')),
    // o3d-batch-ret r7 — THE FIFTH FILE. `paymentAccountRefusalMessage` and
    // `postedRowFollowUpRetryNote` compose the sentence an operator reads when a requested payment
    // could not be queued, on BOTH connectors, and r6 shipped it into a module this scan did not
    // name and the producer walk did not call. Both are now in the walk above; the file is scanned
    // too, for the reason r12 gives — an unextracted string must not be able to hide behind an
    // extracted one.
    readSource(path.join(REPO_ROOT, 'lib', 'domain', 'accounting', 'followup-enqueue-outcome.ts')),
  ]
  for (const source of sources) assertNoBannedInstruction(source.rel, source.code)

  // CONTROLS: the scanner read the files it names, and the Xero one carries the REPLACEMENT rather
  // than merely having lost the sentence.
  assert.match(sources[0]!.code, /xeroRetainedFollowUpObligationDescription/, 'the Xero producer must be the thing there')
  assert.match(
    sources[0]!.code, /followUpObligationRecoveryNote\(followUpObligationRecoveryFor\(XERO_CONNECTOR\)\)/,
    'and its recovery guidance must come from the registry',
  )
  assert.match(sources[1]!.code, /HOW FAR IT GOT IS NOT KNOWN FROM HERE/)
  // And the r12 files carry their REPLACEMENTS rather than merely having lost the sentence.
  assert.match(
    sources[2]!.code, /sweepRetainedFollowUpObligationDescription\(\{ connector, connectorLabel, row \}\)/,
    'the sweep must compose its activity from the named producer, not from prose written at the call site',
  )
  assert.match(
    sources[2]!.code, /followUpObligationRecoveryNote\(followUpObligationRecoveryFor\(connector\)\)/,
    'and its recovery guidance must come from the registry',
  )
  assert.match(sources[3]!.code, /Nothing here authorises settling that by hand/)
  assert.match(
    sources[4]!.code, /describeFollowUpObligationBacklogRow\(row\)/,
    'the exception-inbox loader must pass the registry describer through, not compose a remedy of its own',
  )
  // And the r7 file carries its producers rather than prose written at a call site: the refusal
  // message, and the retry clause whose registry half arrives as an argument.
  assert.match(sources[5]!.code, /export function paymentAccountRefusalMessage/)
  assert.match(sources[5]!.code, /export function postedRowFollowUpRetryNote/)
  // r8: and the third producer in that file, which says what the other two cannot — that there is
  // nothing to configure and no retry that repairs it.
  assert.match(sources[5]!.code, /export function unreadablePaymentAmountRefusalMessage/)
  assert.match(
    sources[5]!.code, /\$\{input\.atRest\}/,
    'the at-rest half must be interpolated from the caller\'s registry answer, never restated here',
  )
})

// ---------------------------------------------------------------------------
// o3d-0bfh r13 (Codex HIGH) — THE DEFERRED ENQUEUE PATH JOINS THE CONTRACT, WITHOUT BLANKET-BANNING
// THE FILE.
//
// r12 filed the question and left it: lib/domain/accounting/invoice-payment-enqueue.ts carried
// eleven operator strings naming a hand remedy, and whether that was safe depended on whether the
// deferred re-drive reaches the branch — which nobody had established. Codex answered it: the
// pinned-invoice-moved branch is reachable ONLY with `postedUnder`, which only
// `registerDeferredOrderReceipts` supplies, and every refusal it produces makes that function answer
// `settled: false`, on which the connector RETAINS the follow-up obligation. So a hand-made payment
// there races exactly the work the retained marker exists to schedule.
//
// AND THE OPPOSITE IS STILL TRUE FOR THE OTHER BRANCHES, which is why this file is NOT added to the
// whole-file scan above. An operator-entered receipt refused for capacity or currency has no
// obligation marker, no queued row and nothing that will ever revisit it; banning a hand
// registration there would strand a customer's payment permanently. THE ONE LIST is scoped to
// RETAINED obligations, and the enqueue path is only sometimes in one.
//
// So the enforcement is structural instead of textual, in two halves:
//
//   • every remedy sentence in that module comes from ONE producer, `invoicePaymentRemedyNote`,
//     and the source check below proves no second one exists outside it;
//   • that producer, and every description composed out of it, is walked HERE at runtime in the
//     DEFERRED state and judged by THE ONE LIST, while the `none` state is asserted to keep its hand
//     remedy so the deliberate exemption is a pinned decision rather than an oversight.
// ---------------------------------------------------------------------------

/** Every refusal `decideInvoicePaymentRegistration` can return — stated, so a new one is loud. */
const INVOICE_PAYMENT_REFUSALS = [
  'SYNC_DISABLED',
  'DOCUMENT_NOT_POSTED',
  'CURRENCY_MISMATCH',
  'NO_BANK_ACCOUNT',
  'UNRESOLVED_PAYMENT_ATTEMPT',
  'LEDGER_AMOUNT_UNKNOWN',
  'LEDGER_AMOUNT_ASSERTED',
  'SETTLED_ON_RETIRED_DOCUMENT',
  'WOULD_OVERPAY',
] as const

/** The connectors the enqueue producers are walked for: every registry entry plus the fallback. */
const REDRIVE_CONNECTORS = [...Object.keys(ACCOUNTING_FOLLOW_UP_RECOVERY), UNDECLARED_CONNECTOR]

/**
 * EVERY OPERATOR STRING THE ENQUEUE PATH PRODUCES WHILE AN OBLIGATION IS OUTSTANDING.
 *
 * Taken from the producers at runtime, for every connector the registry declares AND the undeclared
 * fallback, because the remedy half is the registry's answer for the PINNED connector and a walk of
 * the one connector bound today would leave the other branches unexercised.
 */
function deferredEnqueueProducers(): Array<{ what: string; text: string }> {
  const produced: Array<{ what: string; text: string }> = []
  const money = { orderReference: 'SO-1', amount: 100, currency: 'GBP' }

  for (const connector of REDRIVE_CONNECTORS) {
    const redrive = { redrive: 'deferred' as const, connector }
    produced.push({
      what: `invoicePaymentRemedyNote (deferred, ${connector})`,
      text: invoicePaymentRemedyNote(redrive),
    })

    // Every refusal `reportRefusal` can write, in the state the deferred re-drive puts it in.
    // SYNC_DISABLED produces no notice at all, which is asserted rather than skipped.
    for (const refusal of INVOICE_PAYMENT_REFUSALS) {
      const notice = describeInvoicePaymentRefusal({
        refused: { register: false, refusal, alreadyRegistered: 40, ledgerTotal: 120, detail: 'INV-OLD' },
        orderCurrency: 'EUR',
        method: 'card',
        redrive,
        ...money,
      })
      if (refusal === 'SYNC_DISABLED') {
        assert.equal(notice, null, 'SYNC_DISABLED reports nothing — nothing was expected to post')
        continue
      }
      assert.ok(notice, `${refusal} must produce a notice, or this walk reads nothing`)
      produced.push({ what: `describeInvoicePaymentRefusal ${refusal} (deferred, ${connector})`, text: notice.description })
    }

    for (const phase of ['before-queue', 'while-queueing'] as const) {
      produced.push({
        what: `invoicePaymentDocumentMovedDescription ${phase} (${connector})`,
        text: invoicePaymentDocumentMovedDescription({
          phase, postedInvoiceId: 'INV-1', currentInvoiceId: 'INV-9', connector, ...money,
        }),
      })
    }
    for (const alreadyQueued of [true, false]) {
      produced.push({
        what: `invoicePaymentConnectorMovedDescription alreadyQueued=${alreadyQueued} (${connector})`,
        text: invoicePaymentConnectorMovedDescription({
          pinnedConnector: connector, wroteFor: 'somewhere-else', alreadyQueued, ...money,
        }),
      })
    }
    produced.push({
      what: `invoicePaymentPostingContextChangedDescription (deferred, ${connector})`,
      text: invoicePaymentPostingContextChangedDescription({ redrive, ...money }),
    })
    produced.push({
      what: `invoicePaymentNotQueuedDescription (deferred, ${connector})`,
      text: invoicePaymentNotQueuedDescription({ redrive, ...money }),
    })
    produced.push({
      what: `deferredReceiptsUnlinkedDescription (${connector})`,
      text: deferredReceiptsUnlinkedDescription({ connector, postedInvoiceId: 'INV-1', receipts: 2 }),
    })
    produced.push({
      what: `deferredReceiptsDocumentMovedDescription (${connector})`,
      text: deferredReceiptsDocumentMovedDescription({ connector, postedInvoiceId: 'INV-1', currentInvoiceId: 'INV-9' }),
    })
    produced.push({
      what: `deferredReceiptsFailedDescription (${connector})`,
      text: deferredReceiptsFailedDescription({ connector, error: 'ECONNRESET' }),
    })
  }

  // The third state, which r12 did not see at all: the invoice has not posted, so this receipt has
  // no sync row and the deferred re-drive at the next SALES_INVOICE post is what registers it.
  produced.push({
    what: 'invoicePaymentRemedyNote (invoice-post)',
    text: invoicePaymentRemedyNote({ redrive: 'invoice-post' }),
  })
  // And the FOURTH, added in r14: the durable obligation state could not be read, so a recovery is
  // assumed to exist. Both forms — a connector guess and none at all — because a state that carries
  // an optional field can be reached with it absent, and the walk must judge the string that is
  // actually emitted then.
  for (const connector of [...REDRIVE_CONNECTORS, null]) {
    produced.push({
      what: `invoicePaymentRemedyNote (recovery-unknown, ${connector ?? 'no connector'})`,
      text: invoicePaymentRemedyNote({ redrive: 'recovery-unknown', connector }),
    })
  }
  return produced
}

/** How many strings the walk must yield — stated, so a dropped producer is loud. */
const EXPECTED_DEFERRED_ENQUEUE_PRODUCERS =
  // per connector: the remedy note, the eight refusals less the silent SYNC_DISABLED, two
  // document-moved phases, two connector-moved arms, the posting-context change, the queue failure,
  // and the deferred wrapper's own three messages
  REDRIVE_CONNECTORS.length * (1 + (INVOICE_PAYMENT_REFUSALS.length - 1) + 2 + 2 + 1 + 1 + 3)
  // plus the pre-post state, which has no connector
  + 1
  // plus the unreadable-state remedy, for every connector and for none (o3d-0bfh r14)
  + REDRIVE_CONNECTORS.length + 1

test('[o3d-0bfh r13] every enqueue string written while an obligation is outstanding is judged by THE ONE LIST', () => {
  // Route: the producers in lib/domain/accounting/invoice-payment-enqueue.ts, at runtime, in the
  // DEFERRED redrive state — i.e. the state `registerDeferredOrderReceipts` puts every one of them
  // in — for every registry connector plus the undeclared fallback.
  //
  // Mutation: restore "Re-run the invoice sync for this order, or register the payment in the ledger
  // by hand." to `invoicePaymentRemedyNote`'s deferred branch, or to any one of the descriptions,
  // and this fails naming the producer. Drop the escalation and the escalate assertion fails, so
  // "say nothing at all" is not a passing fix either.
  const produced = deferredEnqueueProducers()
  assert.equal(
    produced.length, EXPECTED_DEFERRED_ENQUEUE_PRODUCERS,
    'every enqueue producer, for every registry connector and the fallback, plus the pre-post state',
  )
  for (const { what, text } of produced) {
    assert.ok(text.length > 0, `${what} must actually produce a string, or this scan reads nothing`)
    assertNoBannedInstruction(what, text)
    assert.match(text, /ESCALATE/, `${what} must say what to do instead of settling by hand: escalate`)
  }

  // NON-VACUITY on the exact sentences that shipped, composed from the shipped strings so the
  // control cannot rot into a test of a hardcoded paragraph.
  const shipped = invoicePaymentRemedyNote({ redrive: 'deferred', connector: 'xero' })
  for (const phrase of [
    ' Re-run the invoice sync for this order',
    ' Or register the payment in Xero by hand',
    ' This still has to be re-driven by hand',
  ]) {
    assert.throws(
      () => assertNoBannedInstruction('the mutated deferred enqueue remedy', shipped + phrase),
      /banned operator instruction/,
      `THE ONE LIST must reject "${phrase.trim()}" in the deferred enqueue remedy`,
    )
  }
  // And the deferred remedy's recovery half is the REGISTRY's fact about the pinned connector, on
  // both sides of the declaration — not a sentence written in the enqueue module.
  assert.match(shipped, /a later sweep re-reads the marker and re-enqueues them idempotently/)
  assert.match(
    invoicePaymentRemedyNote({ redrive: 'deferred', connector: 'quickbooks' }),
    /NOTHING re-enqueues them on this connector/,
  )
  assert.match(
    invoicePaymentRemedyNote({ redrive: 'deferred', connector: UNDECLARED_CONNECTOR }),
    /NOTHING re-enqueues them on this connector/,
    'an undeclared connector must not inherit the sweep answer here either',
  )
})

test('[o3d-0bfh r13] the UNPINNED refusal deliberately KEEPS its hand remedy, because nothing will come back for it', () => {
  // THE OTHER HALF OF THE DECISION, pinned as a test so a later round does not "tidy" it away.
  //
  // An operator-entered receipt refused for capacity, currency or a missing bank-account mapping has
  // no follow-up obligation, no queued row and no re-drive ahead of it. Refusing hand settlement
  // there would leave a customer's payment unregistered for good, which is strictly worse than the
  // double-payment risk the deferred branches carry — there is no double to risk.
  //
  // Route: invoicePaymentRemedyNote({ redrive: 'none' }) and the WOULD_OVERPAY description composed
  // out of it. Mutation: make the `none` branch refuse hand settlement and this fails.
  const alone = invoicePaymentRemedyNote({ redrive: 'none' })
  assert.match(alone, /register it in the accounting connector by hand/i)
  assert.doesNotMatch(alone, /HAND SETTLEMENT IS REFUSED/)

  const notice = describeInvoicePaymentRefusal({
    refused: { register: false, refusal: 'WOULD_OVERPAY', alreadyRegistered: 40, ledgerTotal: 120 },
    orderReference: 'SO-1',
    amount: 100,
    currency: 'GBP',
    orderCurrency: 'GBP',
    method: 'card',
    redrive: { redrive: 'none' },
  })
  assert.ok(notice)
  assert.match(notice.description, /register it in the accounting connector by hand/i)

  // AND THE STATE MACHINE THAT DECIDES WHICH OF THE THREE APPLIES, which is where the r12 question
  // was actually answered. A pin means the deferred re-drive is the caller; no pin and no document
  // means the post that triggers it is still ahead; no pin and a posted document means nothing is
  // coming.
  //
  // o3d-0bfh r14: every one of these is the state with NO deferred recovery outstanding, which is
  // now said rather than assumed — the third argument is required precisely so this exemption has to
  // be claimed.
  const noRecovery = { state: 'none' } as const
  assert.deepEqual(
    invoicePaymentRedriveFor({ connector: 'xero', accountingInvoiceId: 'INV-1' }, 'WOULD_OVERPAY', noRecovery),
    { redrive: 'deferred', connector: 'xero' },
  )
  assert.deepEqual(invoicePaymentRedriveFor(null, 'DOCUMENT_NOT_POSTED', noRecovery), { redrive: 'invoice-post' })
  assert.deepEqual(invoicePaymentRedriveFor(null, 'WOULD_OVERPAY', noRecovery), { redrive: 'none' })
  assert.deepEqual(invoicePaymentRedriveFor(null, null, noRecovery), { redrive: 'none' })
})

test('[o3d-0bfh r13] the enqueue module writes NO remedy sentence outside the one producer', () => {
  // The structural half. The producer walk above can only judge the producers somebody named, and
  // the whole-file scan that catches the rest cannot be pointed at this file — it would ban the
  // legitimate unpinned hand remedy along with everything else. So instead: EXCISE
  // `invoicePaymentRemedyNote`, the one function allowed to say what a human should do, and require
  // that nothing in the remainder of the module says anything of the kind.
  //
  // That is what makes "every message ends in the producer's output" a property rather than a habit:
  // a sentence typed at a call site cannot be reached by the runtime walk, but it cannot survive
  // this either.
  //
  // Mutation: put "or register the payment in the ledger by hand" back onto any refusal message and
  // this fails; the r13 fix removed thirteen such sites.
  const source = readSource(path.join(REPO_ROOT, 'lib', 'domain', 'accounting', 'invoice-payment-enqueue.ts'))
  const from = source.code.indexOf('export function invoicePaymentRemedyNote(')
  assert.ok(from > 0, 'the one remedy producer must be there, or this test is excising nothing')
  const to = source.code.indexOf('\n}\n', from)
  assert.ok(to > from, 'and it must be a complete function')
  const rest = source.code.slice(0, from) + source.code.slice(to)

  // The excision is real: the remedy sentences ARE in the part that was cut.
  assert.match(source.code.slice(from, to), /by hand/i)
  assert.match(source.code.slice(from, to), /HAND SETTLEMENT IS REFUSED HERE/)

  assertNoBannedInstruction(`${source.rel} (outside invoicePaymentRemedyNote)`, rest)
  assert.doesNotMatch(
    rest, /by hand/i,
    'no operator remedy may be written at a call site in this module — it comes from invoicePaymentRemedyNote',
  )

  // And the producers really are what the module reports through.
  assert.match(rest, /describeInvoicePaymentRefusal\(\{/)
  assert.match(rest, /invoicePaymentDocumentMovedDescription\(\{/)
  assert.match(rest, /deferredReceiptsUnlinkedDescription\(\{/)
})

// ---------------------------------------------------------------------------
// o3d-0bfh r14 (Codex HIGH) — THE THREE-STATE VALUE WAS A PROPERTY OF THE CALL, AND THE QUESTION IT
// ANSWERS IS A PROPERTY OF THE RECEIPT.
//
// r13 derived "will anything come back for this receipt?" from whether THIS INVOCATION was handed a
// `postedUnder`. That is not the same question, and Codex found the interleaving where they differ:
// the SALES_INVOICE post claims its follow-up obligation and writes the back-reference; an operator
// records a receipt in the window before `registerDeferredOrderReceipts` reads the payments; the
// unpinned call sees a POSTED document, so it is not DOCUMENT_NOT_POSTED, refuses for something both
// paths share such as NO_BANK_ACCOUNT, and licenses a hand settlement — while the deferred pass then
// selects the very same receipt under its pin, leaves it unregistered and RETAINS the obligation for
// the sweep. The operator's payment races the registration the marker exists to schedule.
//
// The fix consults the DURABLE STATE instead: is a follow-up obligation live for this receipt's
// order? That state is written strictly before the window opens (the claim commits in the SYNCED
// transaction, ahead of the back-reference write) and cleared only when the deferred pass reports
// the receipts settled, so it covers the whole window. The tests below hold the classifier to it,
// hold the module to consulting it rather than inventing an answer, and pin the failure direction.
// ---------------------------------------------------------------------------

/** A double for the one query the durable read makes, recording the predicate it was given. */
function obligationClient(
  answer: Array<{ connector: string }> | Error,
  seen: Array<Record<string, unknown>>,
): DeferredReceiptRecoveryClient {
  return {
    accountingSyncLog: {
      async findMany(args) {
        seen.push(args.where)
        if (answer instanceof Error) throw answer
        return answer
      },
    },
  }
}

/** The refusal the interleaving actually lands on: reachable from BOTH paths, so r13 called it `none`. */
const SHARED_REFUSAL = 'NO_BANK_ACCOUNT' as const

function refusalNotice(redrive: Parameters<typeof invoicePaymentRemedyNote>[0]): string {
  const notice = describeInvoicePaymentRefusal({
    refused: { register: false, refusal: SHARED_REFUSAL },
    orderReference: 'SO-1',
    amount: 100,
    currency: 'GBP',
    orderCurrency: 'GBP',
    method: 'card',
    redrive,
  })
  assert.ok(notice, 'NO_BANK_ACCOUNT must produce a notice, or this test reads nothing')
  return notice.description
}

test('[o3d-0bfh r14] an UNPINNED call for a receipt that already has a deferred recovery offers no hand remedy', async () => {
  // Route: readDeferredReceiptRecovery(orderId, connector, client) -> { state: 'held' } ->
  // invoicePaymentRedriveFor(null, 'NO_BANK_ACCOUNT', recovery) -> { redrive: 'deferred' } ->
  // invoicePaymentRemedyNote -> describeInvoicePaymentRefusal — i.e. exactly the chain the unpinned
  // caller runs while the SALES_INVOICE post's obligation is still outstanding.
  //
  // Mutation: drop the `recovery.state === 'held'` arm from `invoicePaymentRedriveFor` (which is
  // r13's shipped classifier verbatim) and this fails on the first assertion — the notice reverts to
  // "register it in the accounting connector by hand". Make the reader return `{ state: 'none' }` on
  // a non-empty result and it fails the same way.
  const seen: Array<Record<string, unknown>> = []
  const recovery = await readDeferredReceiptRecovery('order-1', 'xero', obligationClient([{ connector: 'xero' }], seen))
  assert.deepEqual(recovery, { state: 'held', connector: 'xero' })

  const redrive = invoicePaymentRedriveFor(null, SHARED_REFUSAL, recovery)
  assert.deepEqual(redrive, { redrive: 'deferred', connector: 'xero' })

  const description = refusalNotice(redrive)
  assert.match(description, /HAND SETTLEMENT IS REFUSED HERE/)
  assert.doesNotMatch(description, /register it in the accounting connector by hand/i)
  assertNoBannedInstruction('the unpinned notice while an obligation is outstanding', description)
  assert.match(description, /ESCALATE/)

  // THE QUESTION IS ASKED ABOUT THE RECEIPT'S ORDER, not about the caller, and the marker is tested
  // for EXISTENCE ONLY — it is a generation, and any other operator on it is the r7 defect.
  assert.equal(seen.length, 1, 'the durable state must actually have been read')
  assert.deepEqual(seen[0], deferredReceiptRecoveryWhere('order-1', 'xero'))
  assert.deepEqual(seen[0], {
    // EXHAUSTIVE, and read from the connector registry rather than spelt here — it is only present
    // so the read can use @@index([connector, referenceType, referenceId]), and a list that named
    // fewer connectors than exist would answer `none` for an obligation held by the one it omitted.
    connector: { in: ACCOUNTING_CONNECTORS.map((connector) => connector.id) },
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    backReferenceFollowUpsPendingAt: { not: null },
  })
  // ...and a connector outside the registry is added rather than dropped: the direction that costs
  // money is a live obligation the query did not look for.
  assert.deepEqual(
    (deferredReceiptRecoveryWhere('order-1', UNDECLARED_CONNECTOR) as { connector: { in: string[] } }).connector.in,
    [...ACCOUNTING_CONNECTORS.map((connector) => connector.id), UNDECLARED_CONNECTOR],
  )
  assert.deepEqual(markerClockReads(JSON.stringify(deferredReceiptRecoveryWhere('order-1', 'xero'))), [])

  // NON-VACUITY. The same unpinned call, same refusal, with NO obligation outstanding, still keeps
  // the hand remedy — so the assertion above is about the durable state and not about the wording of
  // NO_BANK_ACCOUNT. Without this an "always refuse" classifier would pass the test it is meant to
  // fail, and would strand every genuinely unrecoverable receipt.
  const none = await readDeferredReceiptRecovery('order-1', 'xero', obligationClient([], seen))
  assert.deepEqual(none, { state: 'none' })
  assert.deepEqual(invoicePaymentRedriveFor(null, SHARED_REFUSAL, none), { redrive: 'none' })
  assert.match(refusalNotice({ redrive: 'none' }), /register it in the accounting connector by hand/i)

  // AND A CONNECTOR THE ACTIVE ONE IS NOT. The obligation belongs to whichever connector claimed it;
  // a re-drive pinned to that one selects this receipt just the same, because it has no sync row on
  // any ledger. The remedy must therefore be that connector's registry answer, not the active one's.
  const elsewhere = await readDeferredReceiptRecovery('order-1', 'xero', obligationClient([{ connector: 'quickbooks' }], seen))
  assert.deepEqual(elsewhere, { state: 'held', connector: 'quickbooks' })
  assert.match(
    refusalNotice(invoicePaymentRedriveFor(null, SHARED_REFUSAL, elsewhere)),
    /NOTHING re-enqueues them on this connector/,
  )
})

test('[o3d-0bfh r14] a durable state that cannot be READ fails toward assuming a recovery exists', async () => {
  // Route: the read throws -> { state: 'unreadable' } -> { redrive: 'recovery-unknown' } ->
  // invoicePaymentRemedyNote's fourth branch.
  //
  // Mutation: return `{ state: 'none' }` from the catch in `readDeferredReceiptRecovery` — the
  // tempting simplification, since it restores r13's behaviour exactly — and this fails: the notice
  // starts offering a hand settlement again on a database nobody could ask.
  const seen: Array<Record<string, unknown>> = []
  const unreadable = await readDeferredReceiptRecovery('order-1', 'xero', obligationClient(new Error('connection reset'), seen))
  assert.deepEqual(unreadable, { state: 'unreadable', connector: 'xero' })
  assert.equal(seen.length, 1, 'the read must have been attempted, not skipped')

  for (const refusal of INVOICE_PAYMENT_REFUSALS) {
    if (refusal === 'SYNC_DISABLED') continue
    const redrive = invoicePaymentRedriveFor(null, refusal, unreadable)
    // DOCUMENT_NOT_POSTED already refuses hand settlement on its own account; every other refusal
    // must land in the unknown state rather than in `none`.
    assert.notDeepEqual(redrive, { redrive: 'none' }, `${refusal} must not be classified as unrecoverable`)
    assert.match(invoicePaymentRemedyNote(redrive), /HAND SETTLEMENT IS REFUSED HERE/, refusal)
  }

  // The unknown state promises nothing about what WILL come back — it cannot — but it still has to
  // pass THE ONE LIST and still has to say what a human should do instead.
  for (const connector of ['xero', 'quickbooks', UNDECLARED_CONNECTOR, null]) {
    const text = invoicePaymentRemedyNote({ redrive: 'recovery-unknown', connector })
    assertNoBannedInstruction(`the unreadable-state remedy (${connector ?? 'no connector'})`, text)
    assert.match(text, /ESCALATE/)
    assert.doesNotMatch(text, /a later sweep re-reads the marker/, 'it must not promise a sweep it has not established')
  }
})

test('[o3d-0bfh r14] the enqueue module classifies from the durable read and from nothing else', () => {
  // The structural half, and the reason the third parameter is REQUIRED rather than defaulted: a
  // default is how "a property of the call" gets back in one keystroke at a time.
  //
  // Mutation: pass `{ state: 'none' }` at the call site instead of the read, or give
  // `invoicePaymentRedriveFor` a default third argument, and the assertions below fail.
  const source = readSource(path.join(REPO_ROOT, 'lib', 'domain', 'accounting', 'invoice-payment-enqueue.ts'))

  // The classifier takes the recovery, and takes it without a default.
  assert.match(
    source.code,
    /export function invoicePaymentRedriveFor\(\s*pinned: PostedInvoiceEvidence \| null,\s*refusal: InvoicePaymentRegistrationRefusal \| null,\s*recovery: DeferredReceiptRecovery,\s*\)/,
    'the recovery must be a required parameter of the classifier',
  )

  // Exactly ONE call of it in the module, and its third argument is the durable read.
  const calls = source.code.split('invoicePaymentRedriveFor(').length - 1
  assert.equal(calls, 2, 'the declaration and exactly one call — a second call site is a second opinion')
  assert.match(
    source.code,
    /invoicePaymentRedriveFor\(pinned, refusal, await deferredRecovery\(\)\)/,
    'the one call must classify from the durable read',
  )
  assert.match(
    source.code,
    /recoveryRead \?\?= readDeferredReceiptRecovery\(params\.orderId, preferredConnector, db\)/,
    'and that read must be the query against this ORDER, not a value assembled locally',
  )

  // And inside the enqueue itself, every redrive handed to a producer comes from that one classifier.
  const from = source.code.indexOf('export async function registerInvoicePaymentWithLedger(')
  assert.ok(from > 0)
  const to = source.code.indexOf('\n}\n', from)
  assert.ok(to > from)
  const body = source.code.slice(from, to)
  const redrives = body.match(/redrive: [^,\n]+/g) ?? []
  assert.ok(redrives.length >= 3, `only ${redrives.length} redrive arguments found — the scan is reading nothing`)
  for (const site of redrives) {
    assert.match(site, /^redrive: await redriveFor\(/, `a redrive was decided somewhere other than the classifier: ${site}`)
  }
})
