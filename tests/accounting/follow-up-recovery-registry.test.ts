import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import {
  ACCOUNTING_FOLLOW_UP_RECOVERY,
  CONNECTORS_WITHOUT_FOLLOW_UP_CONSUMER,
  FOLLOW_UP_OBLIGATION_AGE_COLUMNS,
  FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN,
  buildFollowUpObligationBacklogWhere,
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

/** Follow identifiers and parenthesised/`as` wrappers to the expression they actually name. */
function resolve(expression: ts.Expression, bindings: Map<string, ts.Expression>, seen = new Set<string>()): ts.Expression {
  let current: ts.Expression = expression
  for (;;) {
    if (ts.isParenthesizedExpression(current)) { current = current.expression; continue }
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) { current = current.expression; continue }
    if (ts.isIdentifier(current) && !seen.has(current.text)) {
      const bound = bindings.get(current.text)
      if (bound) { seen.add(current.text); current = bound; continue }
    }
    return current
  }
}

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
function readsMarker(expression: ts.Expression, bindings: Map<string, ts.Expression>): boolean {
  const resolved = resolve(expression, bindings)
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
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
): string | null {
  const resolved = resolve(value, bindings)
  if (depth > 4) return `${MARKER}: a predicate nested deeper than this scan will follow — state it plainly`
  if (ts.isConditionalExpression(resolved)) {
    return judgeMarkerValue(resolved.whenTrue, bindings, sourceFile, depth + 1)
      ?? judgeMarkerValue(resolved.whenFalse, bindings, sourceFile, depth + 1)
  }
  // Not an object at all: `null`, `true` in a select, a Date, a generation carried in a variable —
  // an assignment or a compare-and-set operand, which is the protocol's own use.
  if (!ts.isObjectLiteralExpression(resolved)) return null
  for (const property of resolved.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = resolve(property.expression, bindings)
      if (!ts.isObjectLiteralExpression(spread)) {
        return `${MARKER}: ${property.getText(sourceFile)} — a spread this scan cannot resolve to an object literal`
      }
      const verdict = judgeMarkerValue(spread, bindings, sourceFile, depth + 1)
      if (verdict) return verdict
      continue
    }
    const key = keyOf(property, bindings)
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
      const verdict = judgeMarkerValue(property.initializer, bindings, sourceFile, depth + 1)
      if (verdict) return verdict
    }
  }
  return null
}

/**
 * Every way this file treats the obligation generation as a point on a clock.
 *
 * Three separate questions, because they are three separate routes and r7 asked only the first:
 * a Prisma predicate on the column, a JavaScript comparison of a value read from it, and raw SQL.
 */
function markerClockReads(code: string, fileName = 'scan.ts'): string[] {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const bindings = localBindings(sourceFile)
  const offences: string[] = []

  const visit = (node: ts.Node): void => {
    // 1. A PRISMA PREDICATE keyed on the marker — including an aliased value, a spread and a
    //    computed key, none of which the text scan could see.
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        const key = keyOf(property, bindings)
        if (key !== MARKER) continue
        const value = ts.isShorthandPropertyAssignment(property)
          ? property.name
          : (ts.isPropertyAssignment(property) ? property.initializer : null)
        if (value === null) continue
        const verdict = judgeMarkerValue(value, bindings, sourceFile)
        if (verdict) offences.push(verdict)
      }
    }
    // 2. A DIRECT JAVASCRIPT COMPARISON of a value read from the column. `<` and friends, and `-`,
    //    which is how an "age" is computed before being compared somewhere else entirely.
    if (ts.isBinaryExpression(node) && RANGE_TOKENS.has(node.operatorToken.kind)) {
      if (readsMarker(node.left, bindings) || readsMarker(node.right, bindings)) {
        offences.push(`direct comparison: ${node.getText(sourceFile).replace(/\s+/g, ' ')}`)
      }
    }
    // 3. RAW SQL naming the column next to a comparison. Prisma's $queryRaw is not covered by
    //    anything above, and it is the one route where the predicate is a string by design.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = node.getText(sourceFile)
      if (text.includes(MARKER) && /<|>|\bBETWEEN\b|\bINTERVAL\b/i.test(text)) {
        offences.push(`raw SQL: ${text.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return offences
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

/** Every operator-facing string this branch is responsible for, and where it is rendered. */
function remedySurfaces(): Array<{ what: string; text: string }> {
  const quickbooks = followUpObligationRecoveryFor('quickbooks')
  const undeclared = followUpObligationRecoveryFor('sage')
  assert.equal(quickbooks.consumer, 'none')
  assert.equal(undeclared.consumer, 'none')
  if (quickbooks.consumer !== 'none' || undeclared.consumer !== 'none') return []
  return [
    { what: "the QuickBooks registry remedy (exception inbox + every retained-obligation log line)", text: quickbooks.operatorRemedy },
    { what: 'the UNDECLARED-connector fallback remedy', text: undeclared.operatorRemedy },
    { what: 'FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN', text: FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN },
  ]
}

test('[o3d-0bfh r8] no operator-facing remedy authorises creating a payment, and each one escalates instead', () => {
  // Route: followUpObligationRecoveryFor(...).operatorRemedy and
  // FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN — the three strings the exception inbox and the
  // connector's log lines are built from (describeFollowUpObligationBacklogRow reads the first).
  //
  // Mutation: put r7's "create ONLY what is verifiably absent" back into either remedy and the
  // authorisation assertion fails on that surface; drop "escalate" and the escalation assertion
  // fails, which is what stops the fix being "delete the sentence and say nothing".
  const surfaces = remedySurfaces()
  assert.equal(surfaces.length, 3, 'all three surfaces must be under test')
  for (const { what, text } of surfaces) {
    assert.doesNotMatch(
      text, /\bcreate (only|ONLY)\b/,
      `${what} tells an operator to create what is "verifiably absent". Remote absence is not proof that creation `
        + 'is safe: a payment can be PENDING in the local queue while QuickBooks shows none.',
    )
    assert.doesNotMatch(
      // The lookbehind exempts the exception-inbox SECTION TITLE ("...with nothing to re-drive
      // them"), which is a statement that nothing will, not an instruction that somebody should.
      text, /(?<!nothing to )re-?driv(e|en) (it|them|this|the)\b|register the receipt in QuickBooks by hand|re-run the invoice sync/i,
      `${what} recommends a direct re-drive on a money path`,
    )
    assert.match(text, /escalat/i, `${what} must say what to do instead of creating: escalate`)
  }

  // And the QuickBooks remedy has to explain WHY reading first is not enough, or the next round
  // reinstates it as an obvious improvement.
  const [quickbooks] = surfaces
  assert.match(quickbooks.text, /PENDING/, 'it names the state the queued payment is actually in')
  assert.match(quickbooks.text, /INVOICE_PAYMENT[\s\S]*INVOICE_PDF/, 'and the enqueue ORDER that creates the window')
  assert.match(quickbooks.text, /DO NOT CREATE/, 'and it refuses in as many words')
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
