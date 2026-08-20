/**
 * Detector behind tests/security/server-action-guard-coverage.test.ts.
 *
 * Extracted from that test (o3d-hic9) so the detection RULES can be exercised
 * against fixture sources in server-action-guard-detector.test.ts, instead of
 * only against the live app/actions tree. A guard whose own logic is untested
 * is how o3d-1fel survived: the `isDelegatingFacade` heuristic silently
 * classified an unguarded `return db.accountingAccount.findMany(...)` as a
 * guarded delegation, and nothing ever asserted otherwise.
 *
 * ---------------------------------------------------------------------------
 * o3d-512h round 3 — RESOLVE, DON'T NAME-MATCH.
 *
 * Codex round 3 found the rules below crediting things they had not verified,
 * in four places. Two of them were here:
 *
 *   * a `return someHelper()` body was credited as a guarded DELEGATION without
 *     anyone ever looking at someHelper — the escape hatch was the shape of the
 *     body, not any property of the delegate;
 *   * a guard was credited whenever its NAME appeared as an identifier anywhere
 *     in the body, called or not. Round 2 patched the single concise-arrow case
 *     (`async () => requireAuth`); every other way to name without calling —
 *     `const g = requireAuth`, `typeof requireAuth`, `guards.push(requireAuth)`,
 *     a dead `if (false) { requireAuth() }` — still passed.
 *
 * And the tree had already been bitten by the general case: app/actions/
 * allocation.ts declared a module-local `requireAuth` that shadowed the imported
 * one and checked only that a user id existed — no session-invalidation check,
 * no 2FA check, no role check. Three endpoints sat behind it, and a rule that
 * matches names could never have said so.
 *
 * Both are now answered by one mechanism, ./module-graph.ts: a call counts as a
 * guard only when its callee RESOLVES — through imports, aliases, namespaces and
 * re-export chains — to a declaration on the pinned list below, or to a function
 * that itself resolves to one. An unresolvable callee (`connector.getAccounts()`,
 * `db.user.findMany()`) is NOT VERIFIED, and not-verified is treated as
 * not-guarded. That subsumes the delegation hatch: a real facade is credited
 * because its delegate was read and found guarded, not because of its shape.
 *
 * ---------------------------------------------------------------------------
 * o3d-512h round 4 — THE SAME MECHANISM, APPLIED TO WHAT IT HAD NOT REACHED.
 *
 * Codex round 4 found three more instances of "credited without being verified",
 * and all three are answered by extending resolution rather than by patching the
 * shape that got past it:
 *
 *   * a resolved guard was credited from ANYWHERE in the body, including a branch
 *     that may not run and a `try` whose `catch` swallows the refusal. Round 3's
 *     own report named this and left it. Position is now verified the same way
 *     identity is — see collectExecutedCalls — and the one conditional position
 *     that IS sound (an unforgeable `Symbol()` sentinel) is verified by resolving
 *     the sentinel, not by recognising the idiom;
 *   * the secret-read rule still entered on a NAME match, so an aliased import of
 *     a real reader never reached the resolver at all. The resolver is now the
 *     entry condition — see readsSettingSecret;
 *   * the model-surface pin was described as if it constrained SELF-SCOPING. It
 *     does not and cannot: which tables an endpoint touches is a static fact, and
 *     whether a row belongs to the caller is a runtime one. The claim is
 *     corrected where it is made, and the property it overclaimed is proved where
 *     it is decidable — by execution, in
 *     tests/security/authentication-only-self-scoping.test.ts.
 *
 * ---------------------------------------------------------------------------
 * o3d-512h round 5 — THE MACHINERY NEEDED THE DISCIPLINE IT ENFORCES.
 *
 * Codex round 5 found the same failure three more times, and every instance was
 * in the verification code itself rather than in the app:
 *
 *   * resolution answered a call site with the MODULE-SCOPE binding, so a guard
 *     name shadowed by a local, a parameter or a destructured argument resolved
 *     to the imported primitive. Round 4's fixture asserted a shadow "counts for
 *     nothing" — it pinned the one kind of shadow `locals` can see. Resolution is
 *     now position-aware (module-graph.ts:hasLexicalShadow), and an intervening
 *     binding makes the answer NOT VERIFIED;
 *   * the sentinel check required a `const` initialised with a call to something
 *     SPELLED `Symbol` — a name match, in the rule written to replace a name
 *     match. A local or imported `Symbol` satisfied it, and the value it produces
 *     is one a client can send. The global is now verified as a global, and the
 *     binding must be `const` (see isBuiltinGlobal);
 *   * position analysis answered whether a guard runs and never when, so a guard
 *     after the write was credited (see firstDataMutationPosition).
 *
 * The fourth finding of the round is against the self-scoping proof rather than
 * this file: it searched the whole query argument for the caller's id instead of
 * the query's CONSTRAINT, so an id in `data` or `select` counted as scoping. Its
 * answer lives in ./recording-db.ts:queryConstraint.
 *
 * Not named *.test.ts on purpose — `npm run test:unit` globs tests/**\/*.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'

import {
  calleeRootName,
  createRepoGraph,
  declarationBody,
  hasLexicalShadow,
  type Declaration,
  type ModuleGraph,
} from './module-graph'

export { calleeRootName }

/**
 * What a guard actually establishes.
 *
 * 'authentication' answers "is someone signed in"; 'authorization' answers "may
 * THIS principal do this". They are not interchangeable, which is the whole
 * lesson of o3d-512h.
 */
export type GuardKind = 'authentication' | 'authorization'

/**
 * The guards, BY DECLARATION SITE rather than by name.
 *
 * `file:name` identity is what makes a shadowing local (allocation.ts's private
 * `requireAuth`) or an aliased import (`import { requireAuth as ok }`) resolve
 * honestly. A name that resolves anywhere else is not on this list and earns
 * nothing.
 */
export const BASE_GUARD_DECLARATIONS: Record<string, Record<string, GuardKind>> = {
  'lib/auth/server.ts': {
    requireAuth: 'authentication',
    getSession: 'authentication',
    requireFreshAuth: 'authentication',
    requireApiAuth: 'authentication',
    requireRole: 'authorization',
    requireAdmin: 'authorization',
    requireFreshAdmin: 'authorization',
    requirePermission: 'authorization',
    requireFreshPermission: 'authorization',
    requireInternalUser: 'authorization',
    authorizePage: 'authorization',
    requireApiAdmin: 'authorization',
    requireApiFreshAdmin: 'authorization',
  },
  'lib/auth/session-gates.ts': {
    requireApiAuthSession: 'authentication',
    requireFreshAuthSession: 'authentication',
    requireApiFreshAuthSession: 'authentication',
    requireRoleSession: 'authorization',
    requireApiAdminSession: 'authorization',
    requireApiFreshAdminSession: 'authorization',
  },
  'lib/security/supplier-portal-boundary.ts': {
    // Not a gate on WHO is calling — a gate on WHOSE ROW this is. On the supplier
    // surface that is the only control that means anything, because every
    // supplier holds every supplier_portal permission.
    assertSupplierOwnsResource: 'authorization',
  },
}

/**
 * Guards that are declared LOCALLY to one module and cannot resolve to the list
 * above, pinned individually with the reason each is accepted.
 *
 * This list is the deliberate, reviewable residue of "resolve, don't name-match":
 * two entries, each read and justified, instead of a name that anything in the
 * tree could have claimed. Adding to it is adding a guard nobody else can audit,
 * so it needs the same argument an allowlist entry does.
 */
export const LOCAL_GUARD_DECLARATIONS: Record<string, { kind: GuardKind; reason: string }> = {
  'app/actions/supplier-portal.ts:requireSupplier': {
    kind: 'authorization',
    reason:
      'round 4: now refuses through the SHARED lib/auth/session-state.ts:sessionAccessDenial '
      + '(revoked/deactivated/force-logged-out/version-bumped sessions, and second-factor-pending '
      + 'ones) before checking role === SUPPLIER and a bound supplierId. Until round 4 it checked '
      + 'only role+supplierId — the shadowing-requireAuth defect, in the guard round 3 kept. '
      + 'Every caller null-checks it, every query is scoped to ctx.supplierId, and the row-level '
      + 'control is assertSupplierOwnsResource on top',
  },
  'app/actions/passkey.ts:getVerifiedSession': {
    kind: 'authentication',
    reason:
      'getSession plus an explicit TOTP-verified check; deliberately authentication ONLY, since '
      + 'managing your own passkeys is self-scoped by session.user.id',
  },
}

export function guardKindOfDeclaration(decl: Declaration): GuardKind | null {
  const base = BASE_GUARD_DECLARATIONS[decl.file]?.[decl.name]
  if (base) return base
  return LOCAL_GUARD_DECLARATIONS[`${decl.file}:${decl.name}`]?.kind ?? null
}

/**
 * Data clients that are NOT an authorization boundary. A call into one of these
 * is the action doing the work itself, so there is no delegate whose guard it
 * could be inheriting (o3d-1fel). Kept as a hard never-credit rule even though
 * resolution would reject them anyway — a Prisma call must never be mistaken for
 * a hand-off, whatever else changes here.
 */
export const DATA_CLIENT_ROOTS = new Set(['db', 'prisma', 'tx', 'client'])

/**
 * A thin facade whose body just returns a call to another action —
 * e.g. `return getWcSyncSettings()`, with the db-rooted case excluded (o3d-1fel).
 *
 * NOTE (round 3): this shape NO LONGER GRANTS CREDIT on its own. It described a
 * body, and a description of a body says nothing about whether the delegate
 * guards anything. A facade is credited today because `guardKindsOfBody` resolved
 * its delegate and found a guard there. The predicate is kept — exported and
 * tested — because the db-rooted exclusion it encodes is still the rule the
 * resolver enforces, and because deleting a guard's history is how the next
 * reviewer loses the reason it exists.
 */
export function isDelegatingFacadeBody(body: ts.ConciseBody | undefined): boolean {
  if (!body) return false

  // An arrow's CONCISE body (`async () => getWcSyncSettings()`) is the returned
  // expression itself — there is no ReturnStatement to find.
  let expr: ts.Expression | undefined
  if (!ts.isBlock(body)) {
    expr = body
  } else {
    const statements = body.statements
    if (statements.length !== 1) return false
    const only = statements[0]
    if (!ts.isReturnStatement(only) || !only.expression) return false
    expr = only.expression
  }

  if (ts.isAwaitExpression(expr)) expr = expr.expression
  if (!ts.isCallExpression(expr)) return false
  const root = calleeRootName(expr.expression)
  return root === null || !DATA_CLIENT_ROOTS.has(root)
}

export function isUseServer(source: string): boolean {
  return /^\s*['"]use server['"]/.test(source)
}

// ---------------------------------------------------------------------------
// The verified guard walk
// ---------------------------------------------------------------------------

/** How far a guard may hide behind wrappers before we stop believing in it. */
const MAX_GUARD_DEPTH = 3

type Verifier = {
  graph: ModuleGraph
  memo: Map<string, Set<GuardKind>>
  writeMemo: Map<string, boolean>
  active: Set<string>
}

const verifiers = new WeakMap<ModuleGraph, Verifier>()

function verifierFor(graph: ModuleGraph): Verifier {
  let v = verifiers.get(graph)
  if (!v) {
    v = { graph, memo: new Map(), writeMemo: new Map(), active: new Set() }
    verifiers.set(graph, v)
  }
  return v
}

function collectCalls(body: ts.ConciseBody): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) calls.push(n)
    ts.forEachChild(n, visit)
  }
  // A concise arrow body IS the expression, so it must be visited itself rather
  // than only its children — `async () => requirePermission('sync')` is a call,
  // and `async () => requireAuth` is NOT one, which is the distinction the whole
  // rule turns on.
  if (ts.isBlock(body)) ts.forEachChild(body, visit)
  else visit(body)
  return calls
}

// ---------------------------------------------------------------------------
// Round 4, Codex finding 2 — DOES THE GUARD ACTUALLY RUN?
// ---------------------------------------------------------------------------

/**
 * The calls that PROVABLY execute whenever the body executes, and whose refusal
 * PROVABLY reaches the caller.
 *
 * Round 3 fixed WHICH declaration a call resolves to and left WHERE the call
 * sits unexamined — its own report said so: "the guard walk credits a resolved
 * call anywhere in the body, including inside a branch that may not run". That
 * is the same defect as the one it fixed, one level along: a rule crediting
 * something it has not verified. `if (process.env.SKIP) { await requireAdmin() }`
 * resolves perfectly and gates nothing.
 *
 * So this is the same answer, applied to position instead of identity: a call is
 * credited only from a position where execution is not in question. Everything
 * else is NOT VERIFIED, and not-verified is not-guarded — the direction that
 * turns the build red rather than quiet.
 *
 * Not credited, and why:
 *   * `if` / `switch` branches, ternary arms, the right side of `&&`, `||`, `??`,
 *     optional calls (`g?.()`) — may not run;
 *   * loop bodies — may run zero times;
 *   * function and arrow bodies — deferred to a caller that may never come, and
 *     `[…].map(() => requireAdmin())` never awaits it anyway;
 *   * statements after a `return`/`throw` — unreachable, and TypeScript does not
 *     make unreachable code an error;
 *   * a `try` block whose `catch` can FALL THROUGH, or whose `finally` returns.
 *     `try { await requireAdmin() } catch {}` swallows the refusal and carries
 *     straight on into the body, which is worse than no guard because it reads
 *     like one;
 *   * a call whose result nothing waits for — see resultIsWaitedFor.
 *
 * Still credited, because they do gate:
 *   * the condition of an `if`/`switch` (it is evaluated to decide the branch);
 *   * a `try` block whose `catch` cannot fall through — `try { await requireAdmin() }
 *     catch { return [] }` is app/actions/users.ts:getUsers, a real refusal
 *     written as a catch, and a rule that flagged it would be answered with an
 *     allowlist entry rather than a fix;
 *   * a `try` with no `catch` at all, and a `finally` block.
 */
function catchCannotFallThrough(clause: ts.CatchClause): boolean {
  return blockCompletesAbruptly(clause.block)
}

/** True when control cannot reach the end of this block: every path returns or throws. */
function blockCompletesAbruptly(block: ts.Block): boolean {
  const statements = block.statements
  if (statements.length === 0) return false
  return statementCompletesAbruptly(statements[statements.length - 1])
}

function statementCompletesAbruptly(st: ts.Statement): boolean {
  if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return true
  if (ts.isBreakStatement(st) || ts.isContinueStatement(st)) return true
  if (ts.isBlock(st)) return blockCompletesAbruptly(st)
  if (ts.isIfStatement(st)) {
    // Both arms must exist and both must be abrupt, or control falls through.
    return !!st.elseStatement
      && statementCompletesAbruptly(st.thenStatement)
      && statementCompletesAbruptly(st.elseStatement)
  }
  if (ts.isTryStatement(st)) {
    if (st.finallyBlock && blockCompletesAbruptly(st.finallyBlock)) return true
    if (!blockCompletesAbruptly(st.tryBlock)) return false
    return !st.catchClause || blockCompletesAbruptly(st.catchClause.block)
  }
  return false
}

/**
 * Is this call's result WAITED FOR before the body carries on?
 *
 * An async guard that is called and not awaited has started a refusal the
 * endpoint does not wait for: execution continues into the read while the
 * permission check is still pending, and the rejection surfaces later as an
 * unhandled rejection rather than as a denial. `requirePermission('x')` on its
 * own line therefore gates nothing, and crediting it is the same mistake as
 * crediting a branch that does not run.
 *
 * Credited: `await g()`, `return g()` (the caller awaits it), a concise arrow
 * body `async () => g()`, and the same through parentheses / `as` casts.
 * Anything else — a bare expression statement, a value stashed in a variable, an
 * argument to another call — is not verified here.
 */
function resultIsWaitedFor(call: ts.CallExpression): boolean {
  let node: ts.Node = call
  let parent: ts.Node | undefined = call.parent
  while (parent) {
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)) {
      node = parent
      parent = parent.parent
      continue
    }
    if (ts.isAwaitExpression(parent)) return true
    if (ts.isReturnStatement(parent)) return true
    // `async () => requirePermission('sync')` — the concise body IS the result.
    if (ts.isArrowFunction(parent) && parent.body === node) return true
    return false
  }
  return false
}

const isFunctionLikeNode = (n: ts.Node): boolean =>
  ts.isArrowFunction(n)
  || ts.isFunctionExpression(n)
  || ts.isFunctionDeclaration(n)
  || ts.isMethodDeclaration(n)
  || ts.isClassDeclaration(n)
  || ts.isClassExpression(n)
  || ts.isGetAccessorDeclaration(n)
  || ts.isSetAccessorDeclaration(n)

/**
 * THE UNFORGEABLE-SENTINEL BRANCH (round 4).
 *
 * Eight endpoints in this tree put their guard behind a condition on purpose:
 *
 *   if (options?.internalBypassToken !== INTERNAL_ACTION_BYPASS) {
 *     await requirePermission('sales.process')
 *   }
 *
 * That is a deliberate, documented control (o3d-43oz, o3d-e1yb): the sentinel is
 * a module-level `Symbol()`, and a Server Action's arguments arrive deserialized
 * from the wire, where a symbol cannot be represented. A network caller can
 * therefore never make the comparison match, so the branch that runs the guard
 * is the branch EVERY remote caller takes. The predecessor of that code was a
 * `skipPermissionCheck?: boolean`, which a client could simply send — and the
 * difference between the two is the whole point.
 *
 * The rule verifies exactly that difference, by resolution and nothing else: the
 * sentinel operand must resolve, through the module graph, to a `const`
 * initialized with a call to `Symbol`. A boolean flag, a string constant, or a
 * name that merely reads like a capability token resolves to no such thing and
 * earns no credit, so the o3d-43oz shape stays a violation.
 *
 * Polarity is checked, not assumed: credit goes to the branch taken when the
 * sentinel did NOT match — the `!==` arm, `!(x === S)`, or `!a && !b` over two
 * such tests, including through a local `const` that holds the comparison. The
 * matching arm is an internal caller that has already proved itself by holding
 * a value the network cannot express, and it is never credited as a guard.
 */
function isSymbolSentinel(
  file: string,
  expr: ts.Expression,
  graph: ModuleGraph | undefined,
): boolean {
  if (!graph) return false
  const decl = ts.isIdentifier(expr)
    ? graph.resolve(file, expr.text, expr)
    : ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && ts.isIdentifier(expr.name)
      ? graph.resolveMember(file, expr.expression.text, expr.name.text, expr.expression)
      : null
  if (!decl || !ts.isVariableDeclaration(decl.node)) return false
  // A `let` or `var` holding a Symbol can be reassigned to something a client can
  // send, so the const-ness is part of the control, not a stylistic detail.
  const list = decl.node.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false
  const init = decl.node.initializer
  if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return false
  if (init.expression.text !== 'Symbol') return false
  return isBuiltinGlobal(decl.file, init.expression, graph)
}

/**
 * o3d-512h round 5, Codex finding 2 — WHOSE `Symbol` IS THIS?
 *
 * The whole force of the sentinel argument is a property of the BUILT-IN
 * `Symbol`: its result has no wire representation, so a deserialized argument can
 * never equal it. Round 4 verified the shape — a `const` initialised with a call
 * to something spelled `Symbol` — and stopped there, which is the name match this
 * branch exists to refuse. A module is free to write
 *
 *   const Symbol = (s: string) => s          // or: import { Symbol } from './compat'
 *   const INTERNAL_ACTION_BYPASS = Symbol('internal')
 *
 * and every guard behind that sentinel would have been credited while a client
 * could send the string `'internal'` and take the bypass arm.
 *
 * So the global is verified as a global: nothing in the declaring module may bind
 * the name at module scope, and nothing may shadow it at the initialiser's
 * position. `bindsAtModuleScope` is asked rather than `resolve`, because an
 * import the graph cannot follow resolves to null exactly as an untouched global
 * does — and answering "null, therefore built-in" is how this defect got in.
 */
function isBuiltinGlobal(file: string, ident: ts.Identifier, graph: ModuleGraph): boolean {
  if (graph.bindsAtModuleScope(file, ident.text)) return false
  return !hasLexicalShadow(ident, ident.text)
}

type SentinelPolarity = 'miss' | 'match' | null

const flipPolarity = (p: SentinelPolarity): SentinelPolarity =>
  p === 'miss' ? 'match' : p === 'match' ? 'miss' : null

function sentinelPolarity(
  file: string,
  expr: ts.Expression,
  graph: ModuleGraph | undefined,
  localConsts: Map<string, ts.Expression>,
  depth = 0,
): SentinelPolarity {
  if (depth > 4) return null
  const recur = (e: ts.Expression) => sentinelPolarity(file, e, graph, localConsts, depth + 1)

  if (ts.isParenthesizedExpression(expr)) return recur(expr.expression)
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return flipPolarity(recur(expr.operand))
  }
  // `const isInternal = options?.internalBypassToken === INTERNAL_ACTION_BYPASS`
  // then `if (!isInternal)`: the test is one statement away, not one node.
  if (ts.isIdentifier(expr)) {
    const bound = localConsts.get(expr.text)
    return bound ? recur(bound) : null
  }
  if (!ts.isBinaryExpression(expr)) return null

  switch (expr.operatorToken.kind) {
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return isSymbolSentinel(file, expr.left, graph) || isSymbolSentinel(file, expr.right, graph)
        ? 'miss'
        : null
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return isSymbolSentinel(file, expr.left, graph) || isSymbolSentinel(file, expr.right, graph)
        ? 'match'
        : null
    case ts.SyntaxKind.AmpersandAmpersandToken: {
      // `!bypassPermission && !authOnly` — true only when NEITHER sentinel matched.
      const left = recur(expr.left)
      const right = recur(expr.right)
      if (left === 'miss' && right === 'miss') return 'miss'
      if (left === 'match' && right === 'match') return 'match'
      return null
    }
    case ts.SyntaxKind.BarBarToken: {
      // `x === S1 || x === S2` is a match test; the OR of two misses says only
      // that ONE of them missed, which proves nothing, so it earns nothing.
      const left = recur(expr.left)
      const right = recur(expr.right)
      return left === 'match' && right === 'match' ? 'match' : null
    }
    default:
      return null
  }
}

export function collectExecutedCalls(
  file: string,
  body: ts.ConciseBody,
  graph?: ModuleGraph,
): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  /** `const` bindings seen so far on the executed path, for sentinel polarity. */
  const localConsts = new Map<string, ts.Expression>()

  const expression = (node: ts.Node | undefined): void => {
    if (!node) return

    if (isFunctionLikeNode(node)) return // deferred: may never be invoked

    if (ts.isCallExpression(node)) {
      // `g?.()` is skipped when g is nullish, so the call is conditional — but
      // the callee expression is still evaluated.
      if (!node.questionDotToken && resultIsWaitedFor(node)) calls.push(node)
      expression(node.expression)
      for (const arg of node.arguments) expression(arg)
      return
    }

    if (ts.isConditionalExpression(node)) {
      expression(node.condition) // arms are conditional by definition
      return
    }

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken
        || op === ts.SyntaxKind.BarBarToken
        || op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        expression(node.left) // the right operand may be short-circuited away
        return
      }
      expression(node.left)
      expression(node.right)
      return
    }

    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && node.questionDotToken
    ) {
      expression(node.expression) // the rest of an optional chain may be skipped
      return
    }

    ts.forEachChild(node, expression)
  }

  const statements = (list: readonly ts.Statement[]): void => {
    for (const st of list) {
      statement(st)
      if (statementCompletesAbruptly(st)) return // anything after this is dead code
    }
  }

  const statement = (st: ts.Statement): void => {
    if (ts.isBlock(st)) return statements(st.statements)
    if (ts.isLabeledStatement(st)) return statement(st.statement)

    if (ts.isIfStatement(st)) {
      expression(st.expression)
      // The one conditional position that IS verified — see isSymbolSentinel.
      const polarity = sentinelPolarity(file, st.expression, graph, localConsts)
      if (polarity === 'miss') statement(st.thenStatement)
      else if (polarity === 'match' && st.elseStatement) statement(st.elseStatement)
      return
    }
    if (ts.isSwitchStatement(st)) return expression(st.expression)

    if (ts.isTryStatement(st)) {
      // A `finally` that returns discards an exception in flight, so it swallows
      // the refusal exactly as a fall-through catch does.
      const finallySwallows = !!st.finallyBlock && blockCompletesAbruptly(st.finallyBlock)
      if (!finallySwallows && (!st.catchClause || catchCannotFallThrough(st.catchClause))) {
        statements(st.tryBlock.statements)
      }
      if (st.finallyBlock) statements(st.finallyBlock.statements)
      return
    }

    // Loops: the body may run zero times, and the guard would be inside it.
    if (
      ts.isForStatement(st) || ts.isForInStatement(st) || ts.isForOfStatement(st)
      || ts.isWhileStatement(st) || ts.isDoStatement(st)
    ) return

    if (ts.isVariableStatement(st)) {
      const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0
      for (const decl of st.declarationList.declarations) {
        expression(decl.initializer)
        // Only `const`: a `let` holding the sentinel test can be reassigned
        // between the test and the branch, so it proves nothing about the branch.
        if (isConst && ts.isIdentifier(decl.name) && decl.initializer) {
          localConsts.set(decl.name.text, decl.initializer)
        }
      }
      return
    }

    if (ts.isExpressionStatement(st)) return expression(st.expression)
    if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return expression(st.expression)

    // Declarations, `debugger`, empty statements: nothing that can be a guard.
  }

  if (ts.isBlock(body)) statements(body.statements)
  else expression(body) // a concise arrow body IS the expression, and always runs

  return calls
}

// ---------------------------------------------------------------------------
// Round 5, Codex finding 3 — DOES THE GUARD RUN *BEFORE* THE DAMAGE?
// ---------------------------------------------------------------------------

/**
 * Prisma operations that CHANGE something.
 *
 * Round 4 answered "does the guard run" and left "when" unasked, and the two are
 * not the same question:
 *
 *   export async function deleteThing(id: string) {
 *     await db.thing.delete({ where: { id } })   // already gone
 *     await requireAdmin()                        // credited by position analysis
 *   }
 *
 * Every rule in this file said that endpoint was guarded. The row is deleted
 * before the refusal is ever raised, and the refusal the caller receives is
 * indistinguishable from one where nothing happened — which makes it worse than
 * no guard, because the denial reads as proof the write did not land.
 *
 * Narrow on purpose: MUTATIONS, not reads. A read placed before a guard is a
 * disclosure question this rule does not decide (the secret-read rule and the
 * self-scoping proof cover that ground), and widening this to every `db.` access
 * would turn a rule with no false positives today into one answered by allowlist
 * entries. What is claimed is exactly what is checked: no credited guard sits
 * after a write.
 */
const MUTATING_PRISMA_OPS = new Set([
  'create', 'createMany', 'createManyAndReturn',
  'update', 'updateMany', 'updateManyAndReturn',
  'upsert', 'delete', 'deleteMany',
])

const RAW_MUTATION_METHODS = new Set(['$executeRaw', '$executeRawUnsafe'])

/** `db.thing.delete(...)` / `db.$executeRaw(...)` — a call that writes. */
function isDataMutationCall(call: ts.CallExpression): boolean {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return false
  const root = calleeRootName(callee)
  if (root === null || !DATA_CLIENT_ROOTS.has(root)) return false
  if (RAW_MUTATION_METHODS.has(callee.name.text)) return true
  return MUTATING_PRISMA_OPS.has(callee.name.text)
}

/**
 * Source position of the first write in this body, or Infinity.
 *
 * Deliberately over-reporting: EVERY mutation in the body counts, including one
 * inside a branch, a loop or a `$transaction` callback. A write that might happen
 * before the guard is still a write the guard did not gate, and this rule's
 * errors must land on the side that turns the build red. It is the mirror of
 * collectExecutedCalls, which under-credits for the same reason.
 *
 * WHAT IT MEASURES, said plainly: `getStart()` is a SOURCE OFFSET, not an
 * execution order. For straight-line code the two agree, and that is the shape
 * this rule is about. Where they can disagree — a write inside a closure defined
 * above the guard and invoked below it — the rule refuses credit for a guard it
 * cannot place. That is a false POSITIVE (a red build on code that is fine), and
 * it is the direction to be wrong in; the live tree produces none today, and one
 * would be answered by moving the guard above the closure, not by an allowlist.
 */
export function firstDataMutationPosition(body: ts.ConciseBody | undefined): number {
  if (!body) return Infinity
  let first = Infinity
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && isDataMutationCall(n)) {
      first = Math.min(first, n.getStart())
    }
    ts.forEachChild(n, visit)
  }
  if (ts.isBlock(body)) ts.forEachChild(body, visit)
  else visit(body)
  return first
}

/**
 * Does this declaration write, itself or through anything the graph can follow?
 *
 * The endpoint's own body is not the only place a write can be. A helper called
 * before the guard writes just as permanently as an inline `db.thing.delete`, and
 * a rule that only read the endpoint's text would be answered by moving one line
 * into a function — a shape check, which is what round 3 abolished.
 *
 * LIMIT, stated: an UNRESOLVABLE callee is not counted as a write. That is the
 * opposite of the direction the guard walk takes with an unresolvable callee, and
 * deliberately so — here, treating the unknown as a write would refuse credit to
 * a correctly guarded endpoint (a false positive, a red build on good code) every
 * time a guard sat below any call the graph cannot follow, which is most of them.
 * So this half under-reports: it catches a laundered write it can see, and says
 * nothing about one it cannot.
 */
function declarationWrites(decl: Declaration, v: Verifier, depth: number): boolean {
  if (depth > MAX_GUARD_DEPTH) return false
  const key = `writes:${decl.file}:${decl.name}:${depth}`
  const cached = v.writeMemo.get(key)
  if (cached !== undefined) return cached
  if (v.active.has(key)) return false // recursion: prove nothing, claim nothing
  v.active.add(key)
  try {
    const body = declarationBody(decl)
    if (!body) return false
    if (firstDataMutationPosition(body) < Infinity) {
      v.writeMemo.set(key, true)
      return true
    }
    for (const call of collectCalls(body)) {
      const root = calleeRootName(call.expression)
      if (root !== null && DATA_CLIENT_ROOTS.has(root)) continue
      const target = v.graph.resolveCallTarget(decl.file, call.expression)
      if (!target) continue
      if (declarationWrites(target, v, depth + 1)) {
        v.writeMemo.set(key, true)
        return true
      }
    }
    v.writeMemo.set(key, false)
    return false
  } finally {
    v.active.delete(key)
  }
}

/**
 * The guard kinds a body PROVABLY establishes: every call that PROVABLY EXECUTES
 * (collectExecutedCalls) and whose callee RESOLVES to a pinned guard declaration,
 * or to a function that reaches one within MAX_GUARD_DEPTH wrappers.
 *
 * Both halves are verification. Round 3 added the second; round 4 added the
 * first, because a guard that resolves perfectly and sits in a branch nothing
 * takes is credit given for work not done.
 *
 * Round 5 adds a third: the call must also sit BEFORE the first write in the body
 * (firstDataMutationPosition). "Does it run" and "does it run in time" are
 * different questions, and only the first had ever been asked — so
 * `await db.thing.delete(...)` followed by `await requireAdmin()` was a guarded
 * endpoint by every rule in this file. Reads before a guard are deliberately NOT
 * covered here; that limit is stated at firstDataMutationPosition rather than
 * left for a reader to discover.
 *
 * Without a graph nothing resolves, so nothing is credited. That is the correct
 * failure direction for a rule whose job is to have no false negatives, and it
 * is why the fixtures in server-action-guard-detector.test.ts build a fixture
 * graph rather than passing bare sources.
 */
export function guardKindsOfBody(
  file: string,
  body: ts.ConciseBody | undefined,
  graph: ModuleGraph | undefined,
  depth = 0,
): Set<GuardKind> {
  const kinds = new Set<GuardKind>()
  if (!body || !graph || depth > MAX_GUARD_DEPTH) return kinds
  const v = verifierFor(graph)
  const executed = collectExecutedCalls(file, body, graph)

  // Everything the body reaches, resolved once: what each call is, and whether it
  // is a guard. The guard question is asked FIRST because a guard is not a write
  // even when its own body records the refusal — a denial that logs itself would
  // otherwise disqualify itself.
  const resolved = executed.map((call) => {
    const root = calleeRootName(call.expression)
    if (root !== null && DATA_CLIENT_ROOTS.has(root)) return { call, target: null, kinds: new Set<GuardKind>() }
    const target = graph.resolveCallTarget(file, call.expression)
    if (!target) return { call, target: null, kinds: new Set<GuardKind>() }
    const direct = guardKindOfDeclaration(target)
    const kinds = direct ? new Set<GuardKind>([direct]) : guardKindsOfDeclaration(target, v, depth + 1)
    return { call, target, kinds }
  })

  let firstWrite = firstDataMutationPosition(body)
  for (const entry of resolved) {
    if (!entry.target || entry.kinds.size > 0) continue
    if (entry.call.getStart() >= firstWrite) continue
    if (declarationWrites(entry.target, v, depth + 1)) firstWrite = entry.call.getStart()
  }

  for (const entry of resolved) {
    // A guard that runs after the row is already written gated nothing (round 5).
    if (entry.call.getStart() > firstWrite) continue
    for (const kind of entry.kinds) kinds.add(kind)
  }

  return kinds
}

function guardKindsOfDeclaration(decl: Declaration, v: Verifier, depth: number): Set<GuardKind> {
  if (depth > MAX_GUARD_DEPTH) return new Set()
  const key = `${decl.file}:${decl.name}:${depth}`
  const cached = v.memo.get(key)
  if (cached) return cached
  if (v.active.has(key)) return new Set() // recursion: prove nothing, claim nothing
  v.active.add(key)
  try {
    const kinds = guardKindsOfBody(decl.file, declarationBody(decl), v.graph, depth)
    v.memo.set(key, kinds)
    return kinds
  } finally {
    v.active.delete(key)
  }
}

function isAllowlisted(allowlist: Record<string, string>, file: string, name: string): boolean {
  return allowlist[`${file}:${name}`] !== undefined || allowlist[`${file}:*`] !== undefined
}

const isExportedNode = (n: ts.Node): boolean =>
  !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))

const isAsyncNode = (n: ts.Node): boolean =>
  !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))

/** One exported, async, callable endpoint in a `'use server'` module. */
export type ExportedServerAction = {
  name: string
  /** Block body, or an arrow's concise expression body. */
  body: ts.ConciseBody | undefined
}

/**
 * Every exported async endpoint in a `'use server'` source.
 *
 * o3d-512h: this used to look at FunctionDeclaration only, so
 * `export const doIt = async () => { … }` — an equally addressable endpoint, and
 * the obvious way to add one — was invisible to every rule below. The branch
 * report justified that with "there are none today", which is exactly the
 * argument a guard exists to stop anyone from having to make: the guard's job is
 * to catch what the next sweep misses, and it cannot do that for a syntax it
 * does not parse.
 *
 * `export default async function …` is deliberately NOT collected: a default
 * export is not a callable Server Action name in Next.js's action protocol.
 */
export function exportedServerActions(sf: ts.SourceFile): ExportedServerAction[] {
  const actions: ExportedServerAction[] = []

  ts.forEachChild(sf, (node) => {
    if (
      ts.isFunctionDeclaration(node)
      && node.name
      && node.body
      && isExportedNode(node)
      && isAsyncNode(node)
    ) {
      actions.push({ name: node.name.text, body: node.body })
      return
    }

    // `export const a = async () => {}, b = async function () {}` — every
    // declarator in the statement is its own export, so each is its own endpoint.
    if (ts.isVariableStatement(node) && isExportedNode(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        const init = decl.initializer
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue
        if (!isAsyncNode(init)) continue
        actions.push({ name: decl.name.text, body: init.body })
      }
    }
  })

  return actions
}

/** Unguarded exported server actions in one source, as `file:name`. */
export function scanSource(
  file: string,
  source: string,
  allowlist: Record<string, string> = {},
  graph?: ModuleGraph,
): string[] {
  if (!isUseServer(source)) return []
  const violations: string[] = []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

  for (const action of exportedServerActions(sf)) {
    if (!action.body) continue
    const kinds = guardKindsOfBody(file, action.body, graph)
    if (kinds.size === 0 && !isAllowlisted(allowlist, file, action.name)) {
      violations.push(`${file}:${action.name}`)
    }
  }
  return violations
}

/**
 * Helpers that hand back a SETTING VALUE, decrypting the keys in
 * SENSITIVE_SETTING_KEYS on the way out (lib/settings-store.ts).
 */
export const SETTINGS_SECRET_READERS = new Set([
  'getSettingValue', 'getSettingValues', 'deserializeSettingValue', 'decryptSettingValue',
])

const SETTINGS_STORE_FILE = 'lib/settings-store.ts'

/**
 * Endpoints that read a stored secret behind AUTHENTICATION ONLY (o3d-512h).
 *
 * The coverage rule above only ever asked "is there a guard at all", which is why
 * the first sweep of this branch walked past app/actions/company.ts:
 * getEmailSettings: it had `requireAuth`, so it was never a violation, while
 * returning the decrypted SMTP configuration to every signed-in role. Reading a
 * credential is an AUTHORIZATION question, so authentication alone is not an
 * answer to it.
 *
 * Deliberately narrow: it triggers on the settings-store readers, which decrypt,
 * and not on `db.setting.*` — plenty of endpoints legitimately read non-secret
 * settings (numbering prefixes, branding colours, FX health) under an
 * authentication gate, and a rule that flagged those would be answered with an
 * allowlist instead of a fix.
 *
 * Round 3 claimed the reader was "matched by RESOLUTION … so an aliased import of
 * the real one does [trip it]". Codex round 4, finding 3: it did not. Resolution
 * was only ever reached for an identifier whose TEXT was already one of the
 * reader names, so the name match was still the entry condition and
 * `import { getSettingValue as readSetting }` was invisible — the exact evasion
 * the resolver was built to close, left open in the one rule that never adopted
 * it. The resolver is now the entry condition, in both directions:
 *
 *   * every call target and every identifier in the body is RESOLVED, and a
 *     binding landing on lib/settings-store.ts's decrypting readers counts as a
 *     read whatever it is called locally (`readSetting`, `store.getSettingValue`);
 *   * an identifier that MATCHES a reader name but resolves elsewhere — the local
 *     helper of the same name — does not count, as before.
 *
 * SCOPE, stated rather than implied: this rule looks at the endpoint's OWN body.
 * It is not transitive, and that is a deliberate limit, not an oversight. The
 * readers are key-blind — `getSettingValue('public_app_url')` decrypts nothing —
 * so following every resolvable callee would flag ordinary configuration reads
 * (app/actions/passkey.ts reaches getSettingValue through getPublicAppUrl) and be
 * answered with allowlist entries, which is how a rule stops meaning anything.
 * A helper that wraps a reader and is called from an authentication-only
 * endpoint is therefore NOT caught here; what covers that case is the pinned
 * Prisma surface below, which IS transitive and names `setting` when it is
 * reached.
 */
/** True when this declaration IS one of the decrypting settings-store readers. */
function isSecretReaderDeclaration(decl: Declaration | null): boolean {
  return !!decl && decl.file === SETTINGS_STORE_FILE && SETTINGS_SECRET_READERS.has(decl.name)
}

/**
 * Does this body read a stored setting value? Resolved, not name-matched.
 *
 * Fail-closed in two places, deliberately:
 *   * with NO graph, a bare name match counts — the rule must not go quiet
 *     because resolution was unavailable;
 *   * with a graph, an identifier that matches a reader name but resolves to
 *     NOTHING counts too, so a module the graph does not cover is treated as a
 *     read rather than waved through.
 */
export function readsSettingSecret(
  file: string,
  body: ts.ConciseBody | undefined,
  graph?: ModuleGraph,
): boolean {
  if (!body) return false
  let found = false

  const visit = (n: ts.Node) => {
    if (found) return

    // `store.getSettingValue(...)`, `readSetting(...)` — the call target is what
    // the resolver is best at, so ask it first.
    if (ts.isCallExpression(n) && graph && isSecretReaderDeclaration(graph.resolveCallTarget(file, n.expression))) {
      found = true
      return
    }

    if (ts.isIdentifier(n)) {
      if (!graph) {
        if (SETTINGS_SECRET_READERS.has(n.text)) { found = true; return }
      } else {
        // Every identifier, not only the ones already spelled like a reader:
        // that name test was the aliasing hole (round 4, finding 3).
        const decl = graph.resolve(file, n.text, n)
        if (isSecretReaderDeclaration(decl)) { found = true; return }
        if (!decl && SETTINGS_SECRET_READERS.has(n.text)) { found = true; return }
      }
    }

    ts.forEachChild(n, visit)
  }

  if (ts.isBlock(body)) ts.forEachChild(body, visit)
  else visit(body)
  return found
}

export function scanSecretReadingActions(
  file: string,
  source: string,
  allowlist: Record<string, string> = {},
  graph?: ModuleGraph,
): string[] {
  if (!isUseServer(source)) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const violations: string[] = []

  for (const action of exportedServerActions(sf)) {
    if (!action.body) continue

    if (!readsSettingSecret(file, action.body, graph)) continue
    const kinds = guardKindsOfBody(file, action.body, graph)
    if (!kinds.has('authorization') && !isAllowlisted(allowlist, file, action.name)) {
      violations.push(`${file}:${action.name}`)
    }
  }
  return violations
}

/**
 * A rule: given one file's key + source + allowlist, the violations in it.
 * Both directory walkers take one so every rule sees exactly the same tree —
 * a rule that scanned a narrower tree than the others would be a gap by
 * construction.
 */
export type SourceScanner = (
  file: string,
  source: string,
  allowlist: Record<string, string>,
  graph?: ModuleGraph,
) => string[]

/** Scans every non-test .ts directly in `dir`. Keys violations by BASENAME. */
export function scanActionsDir(
  dir: string,
  allowlist: Record<string, string>,
  scanner: SourceScanner = scanSource,
  graph?: ModuleGraph,
  keyPrefix = '',
): string[] {
  const violations: string[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
    const full = path.join(dir, entry)
    const source = readFileSync(full, 'utf8')
    // The graph is keyed by repo-relative path; the allowlist and the reported
    // violations are keyed by basename, as they have been since round 1.
    const graphKey = keyPrefix ? `${keyPrefix}/${entry}` : entry
    violations.push(...scanner(entry, source, allowlist, graph ? rekey(graph, entry, graphKey) : undefined))
  }
  return violations
}

/**
 * A view of the graph in which the scanner's short key (`settings.ts`) behaves as
 * the real repo key (`app/actions/settings.ts`).
 *
 * The alternative was to change every allowlist key and every pinned inventory
 * entry from a basename to a path, which would have made this round's diff a
 * rename of 80 lines with the actual change hidden inside it.
 */
function rekey(graph: ModuleGraph, shortKey: string, realKey: string): ModuleGraph {
  const map = (file: string) => (file === shortKey ? realKey : file)
  const view: ModuleGraph = {
    files: () => graph.files(),
    source: (f) => graph.source(map(f)),
    sourceFile: (f) => graph.sourceFile(map(f)),
    bindsAtModuleScope: (f, n) => graph.bindsAtModuleScope(map(f), n),
    resolve: (f, n, at) => graph.resolve(map(f), n, at),
    resolveMember: (f, ns, m, at) => graph.resolveMember(map(f), ns, m, at),
    resolveCallTarget: (f, c) => graph.resolveCallTarget(map(f), c),
    referrers: (f, n, p) => graph.referrers(map(f), n, p),
  }
  // Share the underlying verifier memo: the view and the graph resolve to the
  // same declarations, so caching twice would only be slower.
  const v = verifierFor(graph)
  verifiers.set(view, v)
  return view
}

const SKIP_DIRS = new Set(['node_modules', '.next', 'generated', '.git'])

/**
 * Every OTHER `'use server'` module in the tree (o3d-hic9).
 *
 * app/actions/ is where server actions are supposed to live, but the directive
 * is what creates the endpoint, not the directory — and scanning only
 * app/actions/ meant a `'use server'` module anywhere else was invisible to the
 * guard. lib/connectors/woocommerce/products.ts was exactly that.
 *
 * Keys violations by repo-relative POSIX path, since basenames are not unique
 * outside app/actions.
 */
export function scanUseServerOutsideActions(
  root: string,
  scanRoots: string[],
  allowlist: Record<string, string>,
  scanner: SourceScanner = scanSource,
  graph?: ModuleGraph,
): string[] {
  const actionsDir = path.join(root, 'app', 'actions')
  const violations: string[] = []

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
      if (path.dirname(full) === actionsDir) continue // covered by scanActionsDir
      const source = readFileSync(full, 'utf8')
      if (!isUseServer(source)) continue
      const rel = path.relative(root, full).split(path.sep).join('/')
      violations.push(...scanner(rel, source, allowlist, graph))
    }
  }

  for (const r of scanRoots) walk(path.join(root, r))
  return violations
}

/**
 * Every exported endpoint whose only gate is AUTHENTICATION (o3d-512h round 2).
 *
 * Not a violation rule — an authentication gate is the right answer for a
 * self-scoped endpoint (your own profile, your own passkeys). It is an INVENTORY,
 * pinned by server-action-guard-coverage.test.ts so the set cannot change
 * silently.
 *
 * Round 3: the classification is now made by resolution, so an endpoint cannot
 * leave this inventory by acquiring a LOCAL function that merely shares a name
 * with an authorization guard.
 */
export function scanAuthenticationOnlyActions(
  file: string,
  source: string,
  _allowlist: Record<string, string> = {},
  graph?: ModuleGraph,
): string[] {
  void _allowlist
  if (!isUseServer(source)) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: string[] = []

  for (const action of exportedServerActions(sf)) {
    if (!action.body) continue
    const kinds = guardKindsOfBody(file, action.body, graph)
    if (kinds.has('authentication') && !kinds.has('authorization')) {
      found.push(`${file}:${action.name}`)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// What an endpoint RETURNS — the half the inventory could not see (round 3)
// ---------------------------------------------------------------------------

/**
 * The Prisma models an endpoint reaches, transitively, through every callee the
 * graph can resolve.
 *
 * Codex round 3, finding 3: the inventory pinned WHICH endpoints are
 * authentication-only and said nothing about WHAT they return, so an endpoint
 * could start serving privileged rows without ever leaving the list — which is
 * the exact question the inventory was built to force. It is also the half that
 * defeated every single-file rule: settings.ts:getAccountCodes and
 * purchase-orders.ts:getBillPaymentAccounts reached the stored chart of accounts
 * through a helper two modules away, and nothing in their own source looked like
 * an accounting read.
 *
 * Resolution answers it. `db.<model>` / `tx.<model>` accesses are collected from
 * the endpoint's own body and from every function it can reach, so the pin in the
 * coverage test is a statement about the data surface rather than about the gate.
 * Unresolvable callees are simply not followed — the pin under-reports rather
 * than inventing reach, and the endpoints it covers are the handful whose bodies
 * a reviewer can check by eye.
 *
 * WHAT IT CANNOT DO — Codex round 4, finding 4, stated plainly rather than
 * papered over. This pins WHICH models an endpoint reaches. It does not pin, and
 * cannot pin, that a read is SCOPED TO THE CALLER. `db.user.findUnique` appears
 * identically whether the argument is `{ where: { id: session.user.id } }` or
 * `{ where: { id } }` from the request, and deciding which one a `where` object
 * assembled two modules away amounts to is a runtime question about a value, not
 * a static question about a call. Anything this file pinned in the name of
 * self-scoping would be a proxy for the property rather than the property. So
 * the property is proved where it is decidable — by RUNNING each
 * authentication-only endpoint as an external principal and inspecting the
 * `where` clauses it actually issued:
 * tests/security/authentication-only-self-scoping.test.ts.
 *
 * ALL calls are followed here, not only the ones collectExecutedCalls credits: a
 * conditional read is still a read, and a REACH pin must over-report where the
 * guard walk must under-credit.
 */
export function reachedPrismaModels(
  file: string,
  body: ts.ConciseBody | undefined,
  graph: ModuleGraph,
  seen = new Set<string>(),
): string[] {
  const models = new Set<string>()
  if (!body) return []

  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(n)
      && ts.isIdentifier(n.expression)
      && DATA_CLIENT_ROOTS.has(n.expression.text)
      && ts.isIdentifier(n.name)
    ) {
      models.add(n.name.text)
    }
    ts.forEachChild(n, visit)
  }
  if (ts.isBlock(body)) ts.forEachChild(body, visit)
  else visit(body)

  for (const call of collectCalls(body)) {
    const root = calleeRootName(call.expression)
    if (root !== null && DATA_CLIENT_ROOTS.has(root)) continue
    const target = graph.resolveCallTarget(file, call.expression)
    if (!target) continue
    const key = `${target.file}:${target.name}`
    if (seen.has(key)) continue
    seen.add(key)
    for (const m of reachedPrismaModels(target.file, declarationBody(target), graph, seen)) {
      models.add(m)
    }
  }

  return [...models].sort()
}

/** `key -> sorted models reached`, for every endpoint named. */
export function prismaSurfaceOf(
  entries: Array<{ key: string; file: string; name: string }>,
  graph: ModuleGraph,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const { key, file, name } of entries) {
    const source = graph.source(file)
    if (source === undefined) {
      out[key] = ['<file not in graph>']
      continue
    }
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const action = exportedServerActions(sf).find((a) => a.name === name)
    out[key] = action
      ? reachedPrismaModels(file, action.body, graph)
      : ['<export not found>']
  }
  return out
}

export { createRepoGraph }
export type { ModuleGraph, Declaration }
