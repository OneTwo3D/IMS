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
 * ---------------------------------------------------------------------------
 * o3d-512h round 6 — ONE MISSED INPUT, AND TWO EXEMPTIONS WIDER THAN THEIR REASON.
 *
 * Codex round 6 raised four, and the first is different in kind from every
 * finding of the five rounds before it:
 *
 *   * A NAMED EXPORT DECLARATION was invisible to every scanner here.
 *     `export { wipeEverything }` publishes exactly the endpoint
 *     `export async function wipeEverything` does, and it carries no export
 *     MODIFIER — which is the only thing exportedServerActions looked at. Not the
 *     coverage rule, not the inventory, not the secret-read rule, not the Prisma
 *     surface pin: none of them were ever handed the node. Every other finding in
 *     this branch has been a property judged too generously, and a rule that
 *     judges wrongly can at least be argued with. A rule that never sees the
 *     endpoint reports it green forever. Fixed at the input, by resolution, at
 *     exportedServerActions.
 *   * The write-laundering exemption (round 5) let ANY callee that reaches a
 *     guard carry a write past a later check. Narrowed to PINNED guard
 *     declarations, which is what it was for — see guardKindsOfBody.
 *   * `isBuiltinGlobal` asked `bindsAtModuleScope`, which asked two maps that
 *     index only identifier declarations. `const { Symbol } = compat` took the
 *     name without appearing in either, and the sentinel behind it was certified
 *     as the built-in. Fixed in module-graph.ts:moduleBindings.
 *   * The self-scoping predicate matched the constraint by SUBSTRING, so
 *     `where: { NOT: { userId } }` — the complement of scoping — counted as
 *     scoping. Answered in ./recording-db.ts:constraintCarries.
 *
 * ---------------------------------------------------------------------------
 * o3d-512h round 7 — THE INPUT, NOT THE JUDGEMENT.
 *
 * Round 6 answered "a scanner that cannot see an endpoint is worse than one that
 * judges it wrongly" by adding a fifth recognised export shape. Codex round 7
 * says the shape list is itself the defect, and it is right — a collector that
 * enumerates the forms someone thought of drops the rest in silence, and every
 * round of this branch has ended with a new form nobody had thought of.
 *
 *   * THE MODULE NOBODY OPENED. `isUseServer` required the directive at
 *     character zero. A directive prologue may sit behind comments and behind
 *     other directives, and every rule here begins by asking that question — so a
 *     `'use server'` module written with a licence header on top was skipped at
 *     the door, unread rather than misjudged. It is read as a prologue now.
 *   * THE ENDPOINT THAT IS NOT AN EXPORT. An inline `'use server'` function body
 *     inside a page component is a registered server reference with a public id
 *     and wire-controlled arguments — the form Next's own documentation reaches
 *     for first — and no rule in this file had ever been handed one. See
 *     inlineServerActions / scanTreeForInlineServerActions.
 *   * THE RESIDUAL. exportedServerActions is now EXHAUSTIVE: every top-level
 *     export produces an entry, and anything not established to be an async
 *     function is NOT VERIFIED rather than dropped. That closes `export default`
 *     (a claim four rounds old, withdrawn — `default` is an export name and Next
 *     publishes it), wrapped and destructured exports, classes, enums, namespace
 *     re-exports, and the sync re-export the tree already contains.
 *   * WHOSE WRITE IS EXEMPT — again. Round 6 narrowed the write exemption to a
 *     PINNED guard declaration and then exempted everything that declaration
 *     writes. Being on the guard list is an argument about what a function
 *     ESTABLISHES, not about what it changes. The exemption is now a statement
 *     about MODELS (AUDITED_CONTROL_WRITE_MODELS), and the live tree is pinned at
 *     "no pinned guard writes anything at all".
 *   * NO WILDCARD-SHAPED HATCH. Round 6 made an unfollowable `export *` a
 *     violation clearable by `file:*` — a blanket exemption for every export of a
 *     module, offered as the cure for not knowing what the module exports. Stars
 *     are FOLLOWED through the graph instead, and the residue is not allowlistable
 *     at all.
 *
 * ---------------------------------------------------------------------------
 * o3d-512h round 9 — TWO OF ROUND 8'S RULES WERE NOT YET GENERAL.
 *
 * Round 8 shipped on the argument that its fixes were structural: one file
 * predicate, one export enumerator, one write-position rule. Codex round 9 found
 * two of those three still stated too narrowly, and in both cases the answer is
 * to finish the generalisation rather than to patch the next site.
 *
 *   * THE FUNCTION IS NOT ONLY ITS BODY. Every rule here walked a `ConciseBody`.
 *     A function's PARAMETER DEFAULT INITIALIZERS execute before the body and are
 *     not in that node, so `async function purge(id, _ = db.thing.deleteMany(…))`
 *     was a fully guarded endpoint by every rule in this file. That is round 8's
 *     own finding one step out — it established that a call's SOURCE OFFSET and
 *     its EXECUTION ORDER can disagree, and answered the one case it found with a
 *     range check. The disagreement is answered at the INPUT now: every walk takes
 *     the function's EXECUTABLE REGION (see executableRegions), and source offsets
 *     order it correctly because a parameter list precedes its body.
 *     `collectExecutedCalls` is deliberately not extended — a default initializer
 *     runs only when its argument is omitted, so a guard in one earns nothing.
 *   * AN UNFINISHED WALK IS NOT A NEGATIVE ANSWER. Round 8 made exactly this
 *     correction to the model walk and left the WRITE walk it was modelled on
 *     alone. `declarationWrites` returned a bare `false` for "no write found",
 *     "hit MAX_GUARD_DEPTH" and "no readable body" alike, and the caller read all
 *     three as no-write. The depth cut is gone (a budget for how far a GUARD may
 *     hide says nothing about how far a WRITE may), what remains unfinished is
 *     recorded in `v.incompleteWrites`, and the caller asks
 *     `declarationWriteIsRuledOut`. An unresolvable callee — a place the walk
 *     never STARTED — is still the stated limit it always was.
 *   * THE OTHER LIST, CHECKED AGAINST THE INSTALLED PRISMA.
 *     `MUTATING_PRISMA_OPS` is a literal whose failure direction grants credit: a
 *     write operation nobody added reads as a READ. It is now a CLASSIFICATION
 *     checked against the operations the generated client actually declares
 *     (assertPrismaOperationsClassified, ./installed-prisma.ts), so an operation
 *     on neither side stops the suite by name instead of widening the hole.
 *
 * ROUND 10 — TWO RECOGNISERS WIDENED, AND ONE LIMIT MEASURED RATHER THAN GUESSED.
 *   * THE CALL RECOGNISER, NOT THE VOCABULARY. Round 9 derived WHICH operations
 *     write. It left "is this a call on the data client?" as
 *     `ts.isPropertyAccessExpression`, which is one of the two spellings the
 *     language has, so `db['purchaseOrder']['deleteMany'](…)` was not a write at
 *     all and the guard after it kept full credit. Every member-name question in
 *     these two files now goes through `accessedMemberName` (./module-graph.ts),
 *     which reads dot AND subscript notation and returns UNREADABLE_MEMBER — never
 *     null — for a name that is not in the source.
 *   * …AND THEN NOT A CALL RECOGNISER AT ALL. Fixing the notation still left the
 *     rule keyed on `isCallExpression`, and that is one of several ways to invoke
 *     a function: `db.$executeRaw\`DELETE …\`` (a tagged template, the idiomatic
 *     Prisma raw query and 28 live uses in this repo), `.call`, `.apply`,
 *     `Reflect.apply`, `.bind()()`, and `const wipe = db.x.deleteMany; wipe(…)`
 *     all wrote past a fully credited guard. The set of ways to invoke a value is
 *     not closed and enumerating it is the move that has lost every round. What is
 *     closed is the other side — to invoke an operation, something must first READ
 *     IT OFF THE CLIENT — so the write position is now set by a REFERENCE to a
 *     writing operation, called or not (isDataMutationAccess). Destructuring off
 *     the client fails closed; an alias of the client is followed rather than
 *     failed (dataClientRootsIn).
 *   * THE UNRESOLVABLE CALLEE, MEASURED. Round 9 ranked this the widest
 *     credit-granting hole left. Closing it means defaulting an unresolvable
 *     callee to "might write", and the blast radius of that was measured on this
 *     tree rather than estimated: 1338 distinct unresolvable callees appear before
 *     a credited guard in app/actions alone, and 836 of them survive even after
 *     restricting to callees the graph had a NAME for — `Math.max`, `Object.keys`,
 *     `Promise.all`, `JSON.parse`, `schema.safeParse`, `.map`/`.filter` on locals.
 *     Defaulting to "write" would red-build almost every correctly guarded
 *     endpoint in the repo. Separating those from a real write needs value flow —
 *     whether the receiver of an unresolvable call can hold the Prisma client —
 *     which this walk does not have. So the limit STANDS, deliberately, and this
 *     is the number the next round should argue against rather than re-derive.
 *
 * Not named *.test.ts on purpose — `npm run test:unit` globs tests/**\/*.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'

import { installedPrismaModelOperations } from './installed-prisma'
import {
  UNREADABLE_MEMBER,
  accessedMemberName,
  accessedObject,
  calleeRootName,
  createRepoGraph,
  declarationBody,
  hasLexicalShadow,
  isModuleFileName,
  probeFileName,
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

/**
 * Is this module a `'use server'` module?
 *
 * o3d-512h round 7, Codex finding 1. The regex below requires the directive at
 * character zero, and a directive prologue does not have to be there: comments
 * come before it, and so may other directives. All three of
 *
 *   // eslint-disable-next-line …          /* Copyright … *\/           'use strict'
 *   'use server'                           'use server'                 'use server'
 *
 * are `'use server'` modules that publish every export as an HTTP endpoint, and
 * every rule in this file was skipping them at the door — `scanSource`,
 * `scanSecretReadingActions` and `scanAuthenticationOnlyActions` all return `[]`
 * on the first line. That is the round-6 lesson one layer further out: a rule
 * that judges an endpoint wrongly can be argued with; a rule that never sees the
 * module reports it green forever.
 *
 * So the prologue is read as a prologue. The regex is kept as a fast path for the
 * common spelling, and the substring test keeps the cost of the fallback off the
 * ~800 files in the tree that never mention it.
 */
export function isUseServer(source: string, file = 'directive-probe.ts'): boolean {
  if (/^\s*['"]use server['"]/.test(source)) return true
  if (!source.includes('use server')) return false
  // ROUND 8: the probe must be parsed with the source's own SCRIPT KIND. TypeScript
  // takes that from the file name, and a `.tsx` module parsed as `.ts` reads `<T>`
  // as a type assertion — a different grammar, a different statement list, and a
  // directive prologue answered from a misparse.
  const sf = ts.createSourceFile(probeFileName(file), source, ts.ScriptTarget.Latest, true)
  return hasUseServerPrologue(sf.statements)
}

/** Does a directive prologue — the leading run of bare string statements — say `use server`? */
function hasUseServerPrologue(statements: readonly ts.Statement[]): boolean {
  for (const st of statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteralLike(st.expression)) return false
    if (st.expression.text === 'use server') return true
  }
  return false
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
  /** declaration -> the Prisma models it mutates transitively (round 7). */
  modelMemo: Map<string, Set<string>>
  /**
   * Declarations whose mutated-model set could NOT be established completely
   * (round 8), keyed `file:name` exactly as `modelMemo` is.
   *
   * The inverse store, and per-graph for the same reason the memo is: a key in
   * `modelMemo` has an answer, a key here has one nobody may build an exemption
   * on. Two graphs in one process resolve `lib/auth/server.ts:requireAuth` to
   * different declarations, so a global set would carry a fixture's verdict into
   * the live tree.
   */
  incompleteModels: Set<string>
  /**
   * Declarations whose WRITE question could not be established (round 9), keyed
   * `file:name` exactly as `writeMemo` is — the same inverse store round 8 gave
   * the model walk, for the same reason. A key in `writeMemo` has an answer; a
   * key here has one nobody may credit a guard on.
   */
  incompleteWrites: Set<string>
  active: Set<string>
}

const verifiers = new WeakMap<ModuleGraph, Verifier>()

function verifierFor(graph: ModuleGraph): Verifier {
  let v = verifiers.get(graph)
  if (!v) {
    v = {
      graph,
      memo: new Map(),
      writeMemo: new Map(),
      modelMemo: new Map(),
      incompleteModels: new Set(),
      incompleteWrites: new Set(),
      active: new Set(),
    }
    verifiers.set(graph, v)
  }
  return v
}

/**
 * o3d-512h round 9, Codex finding 1 — THE FUNCTION IS NOT ONLY ITS BODY.
 *
 * Every rule in this file has been handed a `ts.ConciseBody` and has read that
 * body as "the code this endpoint runs". It is not: a function's PARAMETER
 * DEFAULT INITIALIZERS run first, before the first statement of the body, and
 * they are not in the body node at all. So
 *
 *   export async function purge(id: string, _ = db.purchaseOrder.deleteMany({ where: { id } })) {
 *     await requirePermission('purchasing.manage')
 *   }
 *
 * was a fully credited, guarded endpoint by every rule here: `dataMutationPositions`
 * never saw the delete, `firstWrite` stayed at Infinity, and the permission check
 * kept full credit over rows that were gone before the body started.
 *
 * And this is reachable from the wire, not a curiosity. In the installed Next
 * (16.2.10), server/app-render/action-handler.js decodes the POST body with
 * `boundActionArguments = await decodeReply(actionData, serverModuleMap, …)` and
 * then invokes the export as `action.apply(null, args)`. The caller therefore
 * controls the argument LIST, including its LENGTH — `apply` with a shorter array
 * leaves the remaining parameters `undefined`, which is precisely the condition
 * that fires a default initializer. Omitting an argument is not a shape anyone has
 * to be tricked into sending; it is a shape a caller chooses.
 *
 * This is round 8's finding one step further out, and it is worth naming as the
 * same fact. Round 8 established that a call's SOURCE OFFSET and its EXECUTION
 * ORDER can disagree — "a call starts before its arguments do, while the
 * arguments evaluate first" — and answered that one case with a range check.
 * Parameter initializers are the same disagreement between what a rule reads and
 * what actually runs, so the answer is at the INPUT rather than at another
 * comparison: the region every rule walks is now the function's EXECUTABLE
 * REGION — its parameter initializers, then its body — and not the body alone.
 *
 * Source offsets order this correctly with no special case: a parameter list
 * precedes the body it belongs to, so an initializer write is at a lower offset
 * than every guard in the body, which is exactly where it executes.
 *
 * `collectExecutedCalls` is deliberately NOT extended. A default initializer runs
 * only when its argument is `undefined`, so a GUARD in one is conditional and
 * earns nothing — the same polarity as everywhere else here: writes are counted
 * wherever they might happen, guards are credited only where execution is not in
 * question.
 */
function preBodyNodes(body: ts.ConciseBody): ts.Node[] {
  const fn = body.parent as ts.Node | undefined
  if (!fn || !ts.isFunctionLike(fn)) return []
  if ((fn as ts.FunctionLikeDeclaration).body !== body) return []
  const out: ts.Node[] = []
  const fromBinding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) return
    for (const el of name.elements) {
      // `[, a = expr]` — an elision binds nothing and initializes nothing.
      if (ts.isOmittedExpression(el)) continue
      if (el.initializer) out.push(el.initializer)
      // `{ [db.thing.deleteMany({…}) ? 'a' : 'b']: x }` — a COMPUTED property name
      // in a binding pattern is evaluated to work out which property to read, and
      // it is evaluated wherever the pattern is: here, before the body.
      if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) {
        out.push(el.propertyName.expression)
      }
      fromBinding(el.name)
    }
  }
  for (const param of fn.parameters) {
    if (param.initializer) out.push(param.initializer)
    // `{ id, _ = db.thing.deleteMany() }` — a destructuring default is an
    // initializer too, and it is not on the ParameterDeclaration.
    fromBinding(param.name)
  }
  return out
}

/**
 * Everything that runs when this function is called, in execution order: the
 * parameter default initializers, then the body.
 *
 * The one place any rule here turns a function into nodes to walk. A rule that
 * walked `body` directly would be reading the body-only region again.
 */
function executableRegions(body: ts.ConciseBody): ts.Node[] {
  const regions = preBodyNodes(body)
  // A concise arrow body IS the expression, so it must be visited itself rather
  // than only its children — `async () => requirePermission('sync')` is a call,
  // and `async () => requireAuth` is NOT one, which is the distinction the whole
  // rule turns on.
  if (ts.isBlock(body)) regions.push(...body.statements)
  else regions.push(body)
  return regions
}

function collectCalls(body: ts.ConciseBody): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) calls.push(n)
    ts.forEachChild(n, visit)
  }
  for (const region of executableRegions(body)) visit(region)
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
  // Round 10, finding 1: resolution reads both notations, so `NS['SENTINEL']`
  // resolves exactly as `NS.SENTINEL` does. Under-crediting here would cost a
  // correctly-sentinelled internal caller its exemption rather than grant one.
  const member = accessedMemberName(expr)
  const object = accessedObject(expr)
  const decl = ts.isIdentifier(expr)
    ? graph.resolve(file, expr.text, expr)
    : member !== null && member !== UNREADABLE_MEMBER && object !== null && ts.isIdentifier(object)
      ? graph.resolveMember(file, object.text, member, object)
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
export const MUTATING_PRISMA_OPS = new Set([
  'create', 'createMany', 'createManyAndReturn',
  'update', 'updateMany', 'updateManyAndReturn',
  'upsert', 'delete', 'deleteMany',
])

/**
 * The model operations that do NOT write. Not "everything not above" — the two
 * together are a CLASSIFICATION of the operations Prisma actually has, and
 * assertPrismaOperationsClassified checks that they cover it.
 */
export const NON_MUTATING_PRISMA_OPS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'count', 'aggregate', 'groupBy',
])

/**
 * o3d-512h round 9 — THE OTHER LIST, CHECKED AGAINST THE INSTALLED PRISMA.
 *
 * `MUTATING_PRISMA_OPS` is a literal, and this branch's whole history is lists
 * losing. Today it is complete: the installed client declares exactly seventeen
 * model operations and these nine are the writing ones. But "today it is
 * complete" is the argument this file exists to stop anyone from making, and the
 * failure direction is the bad one — a write operation nobody added would be read
 * as a READ, and a guard placed after it would keep full credit.
 *
 * Inverting the list (anything unrecognised is a write) is the obvious answer and
 * it is the wrong one here: `isDataMutationCall` fires on any `X.y.z()` whose root
 * identifier is `db`/`prisma`/`tx`/`client`, and `client` is a very ordinary name
 * for something that is not Prisma at all. Defaulting to "write" would put red
 * builds on correctly guarded endpoints for calls into unrelated SDKs.
 *
 * So the classification is CHECKED instead of guessed: every operation the
 * installed client declares on a model delegate must be on one side or the other,
 * and an operation on neither stops the suite with its name in the message. A
 * Prisma upgrade that adds one cannot widen the hole quietly; it fails, and
 * somebody classifies it.
 */
let operationsChecked = false

function assertPrismaOperationsClassified(): void {
  if (operationsChecked) return
  operationsChecked = true
  const unclassified = [...installedPrismaModelOperations()]
    .filter((op) => !MUTATING_PRISMA_OPS.has(op) && !NON_MUTATING_PRISMA_OPS.has(op))
    .sort()
  if (unclassified.length > 0) {
    throw new Error(
      'tests/security/server-action-guard-scan.ts: the installed Prisma client declares model '
      + `operation(s) this file has not classified as writing or reading: ${unclassified.join(', ')}. `
      + 'Add each to MUTATING_PRISMA_OPS or NON_MUTATING_PRISMA_OPS with the reason. Until then the '
      + 'write-position rule would treat them as reads, and a guard placed after one would keep '
      + 'credit for a write it did not gate.',
    )
  }
}

const RAW_MUTATION_METHODS = new Set(['$executeRaw', '$executeRawUnsafe'])

/**
 * o3d-512h round 10, Codex finding 1 — THE VOCABULARY WAS DERIVED, THE CALL
 * RECOGNISER WAS NOT.
 *
 * Round 9 made the OPERATION list a fact read off the installed client, so no
 * operation Prisma has can be missing from it. It left the question one step
 * earlier untouched: is this expression a call on the data client at all? That
 * was `ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)`,
 * and JavaScript has a second spelling for member access:
 *
 *   await db['purchaseOrder']['deleteMany']({ where: { id } })
 *   await requirePermission('purchasing.manage')     // kept FULL credit
 *
 * The callee is an ElementAccessExpression, the predicate said "not a member
 * access", the write position stayed at Infinity, and the permission check was
 * credited over rows that were already gone. A derived vocabulary behind a
 * recogniser narrower than the language is a complete list of things that are
 * never looked up.
 *
 * So the recogniser is `accessedMemberName` (./module-graph.ts), which reads BOTH
 * notations and returns UNREADABLE_MEMBER for a name that is not in the source.
 * An unreadable operation on a data-client root is treated as a WRITE — the same
 * fail-on-unrecognised rule the classification check applies one level up.
 *
 * Why an unreadable name may default to "write" here when round 9 argued an
 * unrecognised NAME may not: the two defaults answer different questions. Round 9
 * refused to make every `client.somethingOrdinary()` a write, because a dotted
 * call with a readable name into an unrelated SDK is everywhere in an ordinary
 * codebase. `client[expr](…)` — a computed member call on a binding named exactly
 * `db`/`prisma`/`tx`/`client` — is not. An AST sweep of app/, lib/ and
 * components/ found ZERO element-access expressions of ANY kind rooted at those
 * four names, so failing closed costs nothing today, and when it does cost
 * something it costs a red build on a shape someone had to write on purpose.
 */
function isDataMutationAccess(node: ts.Node, roots: ReadonlySet<string>): boolean {
  assertPrismaOperationsClassified()
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false
  const member = accessedMemberName(node)
  if (member === null) return false
  const root = calleeRootName(node)
  if (root === null || !roots.has(root)) return false
  if (member === UNREADABLE_MEMBER) return true
  if (RAW_MUTATION_METHODS.has(member)) return true
  return MUTATING_PRISMA_OPS.has(member)
}

/**
 * o3d-512h round 10 — A WRITE IS A REFERENCE TO A WRITING OPERATION, NOT A CALL
 * SHAPE.
 *
 * Fixing the notation (finding 1) left the rule still keyed on `isCallExpression`,
 * and a `CallExpression` is only one of the ways JavaScript invokes a function.
 * Every one of these ran a delete past a guard that kept full credit, and the
 * first is not exotic at all — it is the idiomatic Prisma raw query, used 28 times
 * in this repo:
 *
 *   await db.$executeRaw`DELETE FROM "PurchaseOrder" WHERE id = ${id}`  // TaggedTemplate
 *   await db.purchaseOrder.deleteMany.call(db.purchaseOrder, { … })
 *   await db.purchaseOrder.deleteMany.apply(db.purchaseOrder, [ … ])
 *   await Reflect.apply(db.purchaseOrder.deleteMany, db.purchaseOrder, [ … ])
 *   await db.purchaseOrder.deleteMany.bind(db.purchaseOrder)({ … })
 *   const wipe = db.purchaseOrder.deleteMany; await wipe({ … })
 *
 * Enumerating `.call`, `.apply`, `.bind`, `Reflect.apply`, tagged templates and
 * whatever is next is the losing move this branch keeps re-learning — the list of
 * ways to invoke a value is not closed. What IS closed is the other side: to
 * invoke `deleteMany` at all, something must first READ IT OFF THE CLIENT. So the
 * rule stops asking how the call is spelled and asks only whether a writing
 * operation is REACHED, called or not.
 *
 * The cost is a false positive on a mutating operation mentioned and never
 * invoked before a guard. On this tree that is zero occurrences — the 28 hits are
 * all `tx.$executeRaw` tagged templates, which are writes.
 *
 * TWO SHAPES REACH AN OPERATION WITHOUT NAMING IT, and both fail closed:
 *   * DESTRUCTURING (`const { deleteMany } = db.purchaseOrder`, `const { purchaseOrder } = db`)
 *     pulls a value out of the client with no member access to see. What comes out
 *     and where it is called cannot be tracked here, so taking any binding pattern
 *     off a data client is a write. Zero occurrences in this tree.
 *   * AN ALIAS (`const po = db.purchaseOrder; await po.deleteMany(…)`) moves the
 *     client into a name this file does not know. That one is not failed closed —
 *     it is FOLLOWED: `dataClientRootsIn` adds the alias to the root set, so
 *     `po.deleteMany` is a write and `po.findMany` is still a read. Flagging the
 *     alias itself would have been a red build on the one live instance
 *     (lib/connectors/shopping-webhook-inbox.ts) for no gain.
 */
function isDataClientDestructure(node: ts.Node, roots: ReadonlySet<string>): boolean {
  if (!ts.isVariableDeclaration(node) && !ts.isParameter(node) && !ts.isBindingElement(node)) {
    // `({ deleteMany } = db.purchaseOrder)` — destructuring as an ASSIGNMENT.
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left))
    ) {
      const root = calleeRootName(node.right)
      return root !== null && roots.has(root) && isBareClientReference(node.right)
    }
    return false
  }
  if (ts.isIdentifier(node.name) || !node.initializer) return false
  const root = calleeRootName(node.initializer)
  return root !== null && roots.has(root) && isBareClientReference(node.initializer)
}

/**
 * The expression is the client (or one of its delegates) ITSELF, not a value it
 * returned. `const { id } = await db.thing.findFirst()` destructures a ROW.
 */
function isBareClientReference(expr: ts.Expression): boolean {
  return ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)
}

/**
 * A binding whose TYPE says it holds a Prisma client.
 *
 * `DATA_CLIENT_ROOTS` is a list of NAMES, and this branch's history is lists
 * losing. It survives here because it is not the only answer: a helper that takes
 * the client under a name nobody listed —
 *
 *   async function purge(c: Prisma.TransactionClient, id: string) {
 *     await c.purchaseOrder.deleteMany({ where: { id } })
 *   }
 *
 * — is recognised by its ANNOTATION instead. `PrismaClient` and
 * `TransactionClient` are type names the generated client exports, so this reads
 * the same source of truth ./installed-prisma.ts does, one level up: whatever the
 * parameter is called, a thing typed as the client is the client.
 *
 * Measured on this tree: every parameter annotated with a Prisma client type is
 * called `tx` (71) or `client` (2), both already on the name list — so this adds
 * nothing today and removes the naming CONVENTION as a load-bearing assumption,
 * which is the part that would otherwise be one rename away from a silent hole.
 */
function isPrismaClientTypeNode(type: ts.TypeNode | undefined): boolean {
  if (!type) return false
  const text = type.getText()
  return /\bPrismaClient\b/.test(text) || /\bTransactionClient\b/.test(text)
}

/**
 * The names that hold the data client, or one of its delegates, inside this
 * region — `DATA_CLIENT_ROOTS`, plus every binding TYPED as a client, plus every
 * local alias of one, to a fixpoint so `const a = db; const b = a` is followed.
 */
function dataClientRootsIn(
  regions: readonly ts.Node[],
  body?: ts.ConciseBody,
): ReadonlySet<string> {
  const roots = new Set(DATA_CLIENT_ROOTS)

  // The enclosing function's OWN parameters are not inside its regions — the
  // regions are its initializers and its body — so they are read from the body's
  // parent, which is the function-like declaration itself.
  const owner = body?.parent
  if (owner && ts.isFunctionLike(owner)) {
    for (const param of owner.parameters) {
      if (ts.isIdentifier(param.name) && isPrismaClientTypeNode(param.type)) roots.add(param.name.text)
    }
  }

  for (;;) {
    let grew = false
    const add = (name: string) => {
      if (roots.has(name)) return
      roots.add(name)
      grew = true
    }
    const visit = (n: ts.Node) => {
      if ((ts.isParameter(n) || ts.isVariableDeclaration(n)) && ts.isIdentifier(n.name)) {
        if (isPrismaClientTypeNode(n.type)) add(n.name.text)
      }
      if (
        ts.isVariableDeclaration(n)
        && ts.isIdentifier(n.name)
        && n.initializer
        && isBareClientReference(n.initializer)
      ) {
        const root = calleeRootName(n.initializer)
        if (root !== null && roots.has(root)) add(n.name.text)
      }
      ts.forEachChild(n, visit)
    }
    for (const region of regions) visit(region)
    if (!grew) return roots
  }
}

/**
 * The Prisma model a mutating call writes: `db.thing.delete(…)` -> `thing`,
 * `db.$executeRaw(…)` -> `$executeRaw`. `<unknown>` when the shape is a mutation
 * but the model cannot be named — which is never on the audited list below, so
 * the unknown fails closed.
 */
function mutatedModelOfAccess(node: ts.Node, roots: ReadonlySet<string>): string | null {
  if (!isDataMutationAccess(node, roots)) return null
  const access = node as ts.PropertyAccessExpression | ts.ElementAccessExpression
  const member = accessedMemberName(access)
  // Round 10, finding 1: an unreadable operation is a mutation, and a mutation
  // whose model cannot be named is `<unknown>` — never audited, so the pinned-guard
  // exemption cannot be claimed for it.
  if (member === null || member === UNREADABLE_MEMBER) return '<unknown>'
  if (RAW_MUTATION_METHODS.has(member)) return member
  const owner = accessedObject(access)
  if (owner === null) return '<unknown>'
  const model = accessedMemberName(owner)
  if (model === null || model === UNREADABLE_MEMBER) return '<unknown>'
  return model
}

/**
 * o3d-512h round 7, Codex finding 3 — WHICH of a pinned guard's writes are the
 * control's?
 *
 * Round 6 narrowed the write-laundering exemption from "any callee that reaches a
 * guard" to "a PINNED guard declaration", because a denial that records itself is
 * still a denial and the write question would otherwise disqualify the guard that
 * asked it. But "pinned" was then treated as a property of the DECLARATION rather
 * than of the write, so the exemption still covered every write the guard makes:
 *
 *   // lib/auth/server.ts
 *   export async function requirePermission(p: string) {
 *     …refuse if not permitted…
 *     await db.salesOrder.deleteMany({ where: { draft: true } })   // exempt
 *   }
 *
 * A guard is trusted to write its own audit trail. It is not trusted to carry
 * arbitrary business writes past the checks that follow it, and being on the
 * pinned list is not an argument that it does not — the pinned list is about what
 * a declaration ESTABLISHES, not about what it changes.
 *
 * So the exemption is a statement about MODELS, and the list is short, named and
 * reviewable rather than a wildcard: the tables an authorization control writes
 * as part of being an authorization control. Anything else a guard writes is a
 * business write, and its call site sets the write position exactly as an
 * ordinary helper's does — which costs the guards AFTER it their credit, and
 * turns the build red.
 *
 * LIMIT, stated: this is a table-level judgement. A guard writing a business
 * payload INTO `activityLog` is still exempt, because "is this row an audit
 * record" is a question about a value. What is claimed is what is checked — the
 * models, not the rows — and the live tree is pinned at "no pinned guard mutates
 * anything at all" by server-action-guard-coverage.test.ts, so even an exempt
 * write cannot appear without a reviewed diff.
 */
export const AUDITED_CONTROL_WRITE_MODELS: Record<string, string> = {
  activityLog:
    'the denial/audit row a guard writes when it refuses — the case round 6 was right about: '
    + 'a denial that records itself is still a denial',
  session:
    'a session touch (rotation, last-seen, revocation) IS the session gate doing its work; '
    + 'lib/auth/session-gates.ts exists to make exactly these decisions',
}

/**
 * Every Prisma model this declaration mutates, itself or through anything the
 * graph can follow — INCLUDING through other pinned guards, because a guard that
 * calls a guard that wipes rows has laundered the wipe just the same.
 *
 * ROUND 8: no depth parameter. This walk used to inherit MAX_GUARD_DEPTH, which
 * is a budget for how far a GUARD may hide behind wrappers and says nothing about
 * how far a WRITE may — and a walk that stops early returns the empty set, which
 * is indistinguishable from "writes nothing" to the caller that grants the
 * exemption. There is a cycle guard and a memo, so following every resolvable
 * callee costs one visit per reachable declaration. Where the walk genuinely
 * cannot finish it says so, in `v.incompleteModels`.
 */
function mutatedModelsOfDeclaration(decl: Declaration, v: Verifier): Set<string> {
  const key = `${decl.file}:${decl.name}`
  const cached = v.modelMemo.get(key)
  if (cached) return cached
  const models = new Set<string>()
  // ROUND 8, Codex finding 3 — AN ANSWER THAT WAS NEVER ESTABLISHED.
  //
  // Round 7 asked "does this guard write outside the audited surface" and read
  // the answer off an EMPTY model set. Every way this walk could fail to find a
  // write produced that same empty set: a body it could not read, a recursion
  // cut, and — the one that mattered — a depth cut at MAX_GUARD_DEPTH, which is a
  // budget for how far a GUARD may hide behind wrappers and has nothing to do
  // with how far a WRITE may. "I found nothing" was returned as "there is
  // nothing", to a caller whose next move was to grant an exemption.
  //
  // So the walk reports its own completeness, and it no longer stops at a depth.
  // There is a cycle guard and a memo, so following every resolvable callee costs
  // one visit per reachable declaration; the depth limit bought nothing here
  // except the silence above. What remains incomplete — a cycle, an unreadable
  // body — is reported as incomplete, and the exemption requires completeness.
  if (v.active.has(`models:${key}`)) {
    // A cycle: this frame cannot contribute, and the answer it is part of is not
    // established. Not cached — the outer frame's result is the one to keep.
    v.incompleteModels.add(key)
    return models
  }
  v.active.add(`models:${key}`)
  let complete = true
  try {
    const body = declarationBody(decl)
    if (!body) {
      // A declaration with no body the graph can read writes an unknown set.
      v.incompleteModels.add(key)
      return models
    }
    // The executable region, not the body: a guard whose parameter default
    // initializer writes has written just as permanently (round 9, finding 1).
    const regions = executableRegions(body)
    const clientRoots = dataClientRootsIn(regions, body)
    const visit = (n: ts.Node) => {
      const model = mutatedModelOfAccess(n, clientRoots)
      if (model) models.add(model)
      // A destructure off the client hands out an operation this walk cannot name
      // (round 10), so the model it writes is unknown — and unknown is not audited.
      if (isDataClientDestructure(n, clientRoots)) models.add('<unknown>')
      ts.forEachChild(n, visit)
    }
    for (const region of regions) visit(region)

    for (const call of collectCalls(body)) {
      const root = calleeRootName(call.expression)
      if (root !== null && DATA_CLIENT_ROOTS.has(root)) continue
      const target = v.graph.resolveCallTarget(decl.file, call.expression)
      // An unresolvable callee is the LIMIT this walk shares with
      // declarationWrites, and it is stated in both places rather than only one:
      // neither can see a write behind a value the graph cannot follow. Making it
      // incomplete here would make every pinned guard non-exempt on the strength
      // of a `headers()` call, which is not what the exemption is about.
      if (!target) continue
      const inner = mutatedModelsOfDeclaration(target, v)
      for (const m of inner) models.add(m)
      if (v.incompleteModels.has(`${target.file}:${target.name}`)) complete = false
    }
    if (complete) v.modelMemo.set(key, models)
    else v.incompleteModels.add(key)
    return models
  } finally {
    v.active.delete(`models:${key}`)
  }
}

/**
 * Does this pinned guard write anything OUTSIDE the audited control surface?
 *
 * True means the exemption does not apply: the guard is carrying a business write
 * and is treated as an ordinary writing helper at its call site.
 *
 * ROUND 8: true ALSO means "this could not be established". The exemption is a
 * claim that a guard's writes are all part of the control, and a claim nobody
 * checked is not a weaker version of a claim that was checked — it is the same
 * "credited without being verified" this whole branch has been unwinding, sitting
 * in the one rule whose job is to hand out credit.
 */
function guardWritesBusinessData(decl: Declaration, v: Verifier): boolean {
  const models = mutatedModelsOfDeclaration(decl, v)
  if (v.incompleteModels.has(`${decl.file}:${decl.name}`)) return true
  for (const model of models) {
    if (!Object.prototype.hasOwnProperty.call(AUDITED_CONTROL_WRITE_MODELS, model)) return true
  }
  return false
}

/** The models a pinned guard mutates, for the live-tree pin in the coverage test. */
export function guardWriteSurface(graph: ModuleGraph): Record<string, string[]> {
  const v = verifierFor(graph)
  const out: Record<string, string[]> = {}
  const record = (file: string, name: string) => {
    // `resolve` first: two pinned guards are module-LOCAL and are not exported at
    // all (supplier-portal.ts:requireSupplier, passkey.ts:getVerifiedSession).
    const decl = graph.resolve(file, name) ?? graph.resolveExportedName(file, name)
    if (!decl) {
      out[`${file}:${name}`] = ['<declaration not found>']
      return
    }
    const models = [...mutatedModelsOfDeclaration(decl, v)].sort()
    if (models.length > 0) out[`${file}:${name}`] = models
  }
  for (const [file, names] of Object.entries(BASE_GUARD_DECLARATIONS)) {
    for (const name of Object.keys(names)) record(file, name)
  }
  for (const key of Object.keys(LOCAL_GUARD_DECLARATIONS)) {
    const sep = key.lastIndexOf(':')
    record(key.slice(0, sep), key.slice(sep + 1))
  }
  return out
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
  let first = Infinity
  for (const at of dataMutationPositions(body)) first = Math.min(first, at)
  return first
}

/**
 * Every source offset in this function's EXECUTABLE REGION at which a write
 * happens — its parameter default initializers as well as its body (round 9,
 * finding 1). A parameter list precedes the body, so an initializer write lands
 * at a lower offset than every guard in the body, which is where it runs.
 */
function dataMutationPositions(body: ts.ConciseBody | undefined): number[] {
  if (!body) return []
  const at: number[] = []
  const regions = executableRegions(body)
  const clientRoots = dataClientRootsIn(regions, body)
  const visit = (n: ts.Node) => {
    // Round 10: a REFERENCE to a writing operation, not a call shape — see
    // isDataMutationAccess for why the list of ways to invoke a value is not one
    // this file can close.
    if (isDataMutationAccess(n, clientRoots) || isDataClientDestructure(n, clientRoots)) at.push(n.getStart())
    ts.forEachChild(n, visit)
  }
  for (const region of regions) visit(region)
  return at
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
 *
 * ---------------------------------------------------------------------------
 * o3d-512h round 9, Codex finding 2 — AN UNFINISHED WALK IS NOT A NEGATIVE ANSWER.
 *
 * Round 8 made exactly this correction to the MODEL walk: "every way this walk
 * could fail to find a write produced that same empty set … 'I found nothing' was
 * returned as 'there is nothing', to a caller whose next move was to grant an
 * exemption." The same sentence was true here, in the walk the model walk was
 * modelled on, and it survived round 8 because only one of the two was looked at.
 *
 * There are exactly two kinds of `false` this function can return, and they are
 * not the same fact:
 *
 *   * ESTABLISHED — the body was read, every resolvable callee was followed to
 *     the end, and no write was found;
 *   * NOT ESTABLISHED — the walk stopped early. Three ways it could: a depth cut
 *     at MAX_GUARD_DEPTH, a recursion cut, and a declaration whose body could not
 *     be read at all. All three returned the same bare `false`, and the caller
 *     read it as "this helper carries no write" and left the guards after it with
 *     full credit. `await w1(id)` where w1 → w2 → w3 → w4 → `db.thing.deleteMany`
 *     was a guarded endpoint, because MAX_GUARD_DEPTH is a budget for how far a
 *     GUARD may hide behind wrappers and has nothing whatever to do with how far
 *     a WRITE may.
 *
 * So, as in round 8: the depth cut is gone (there is a cycle guard and a memo, so
 * following every resolvable callee costs one visit per reachable declaration),
 * what remains unfinished is RECORDED in `v.incompleteWrites`, and the caller
 * asks `declarationWriteIsRuledOut` rather than `!declarationWrites`.
 *
 * Note which way the two limits point, because they look alike and are not. An
 * unresolvable callee is a place the walk never STARTED — the stated limit above,
 * shared with the model walk, and still not a write. An incomplete walk is one
 * that started and did not finish, and a guard may not be credited over it.
 */
function declarationWrites(decl: Declaration, v: Verifier): boolean {
  const key = `${decl.file}:${decl.name}`
  const cached = v.writeMemo.get(key)
  if (cached !== undefined) return cached
  if (v.active.has(`writes:${key}`)) {
    // A cycle: this frame cannot contribute, and the answer it is part of is not
    // established. Not cached — the outer frame's result is the one to keep.
    v.incompleteWrites.add(key)
    return false
  }
  v.active.add(`writes:${key}`)
  let complete = true
  try {
    const body = declarationBody(decl)
    if (!body) {
      // Resolved to a declaration, but nothing to read: `export const helper =
      // wrap(async () => db.thing.deleteMany(…))` names a real declaration whose
      // writes are behind a call this walk cannot enter. Unknown, not none.
      v.incompleteWrites.add(key)
      return false
    }
    if (firstDataMutationPosition(body) < Infinity) {
      v.writeMemo.set(key, true)
      return true
    }
    for (const call of collectCalls(body)) {
      const root = calleeRootName(call.expression)
      if (root !== null && DATA_CLIENT_ROOTS.has(root)) continue
      const target = v.graph.resolveCallTarget(decl.file, call.expression)
      if (!target) continue
      // A pinned guard's AUDITED writes are the control's (round 6): if they
      // counted here, every helper that calls a guard would inherit them and the
      // narrowed exemption in guardKindsOfBody would be worth nothing.
      //
      // Round 7, finding 3: the exemption is about the models, not about the
      // declaration. A guard that writes business data launders it through a
      // wrapper exactly as an ordinary helper does, so the wrapper must inherit
      // that write — or the rule is inconsistent one call deep in the direction
      // that hides the laundering.
      if (guardKindOfDeclaration(target) !== null && !guardWritesBusinessData(target, v)) continue
      if (declarationWrites(target, v)) {
        v.writeMemo.set(key, true)
        return true
      }
      if (v.incompleteWrites.has(`${target.file}:${target.name}`)) complete = false
    }
    if (complete) v.writeMemo.set(key, false)
    else v.incompleteWrites.add(key)
    return false
  } finally {
    v.active.delete(`writes:${key}`)
  }
}

/**
 * Is this declaration ESTABLISHED to carry no write?
 *
 * The question every caller of `declarationWrites` actually has. `false` from
 * that function means "no write was found", which is only an answer when the walk
 * finished — see the note above.
 */
function declarationWriteIsRuledOut(decl: Declaration, v: Verifier): boolean {
  if (declarationWrites(decl, v)) return false
  return !v.incompleteWrites.has(`${decl.file}:${decl.name}`)
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

  // ROUND 8, Codex finding 3 — WHICH CALLS CAN CARRY A WRITE.
  //
  // The write position used to be read off `resolved`, which is
  // collectExecutedCalls — the calls that PROVABLY EXECUTE. That set exists to
  // UNDER-credit guards, and using it to find writes inverts its polarity: a
  // helper whose write may or may not happen is excluded, so
  //
  //   if (force) { await wipeHelper(id) }        // db.purchaseOrder.deleteMany
  //   await requirePermission('purchasing.manage')
  //
  // left `firstWrite` at Infinity and the permission check kept full credit, on
  // rows that were already gone when it ran. The inline spelling of exactly that
  // — `if (force) { await db.purchaseOrder.deleteMany(…) }` — has been a violation
  // since round 5, because firstDataMutationPosition deliberately over-reports
  // every mutation in the body, branch or not. A rule that flags the write and
  // clears the same write moved one call away is a rule answered by extracting a
  // function.
  //
  // So the write question is asked of EVERY call in the body, and the two halves
  // now err in the same direction: guards are credited only from a position where
  // execution is not in question, and writes are counted wherever they might
  // happen at all.
  const writeAt = dataMutationPositions(body)
  let firstWrite = writeAt.reduce((a, b) => Math.min(a, b), Infinity)
  for (const call of collectCalls(body)) {
    if (call.getStart() >= firstWrite) continue
    const root = calleeRootName(call.expression)
    if (root !== null && DATA_CLIENT_ROOTS.has(root)) continue
    const target = graph.resolveCallTarget(file, call.expression)
    if (!target) continue
    const entry = { call, target }
    // ROUND 6, Codex finding 3 — WHOSE WRITE IS EXEMPT?
    //
    // Round 5 exempted any callee that reaches a guard (`entry.kinds.size > 0`),
    // to protect a denial that records itself. That exemption is far wider than
    // the thing it protects: ANY helper that calls a guard and then writes was
    // exempt, so
    //
    //   await authAndWipe(id)             // requireAuth(), then db.thing.delete
    //   await requirePermission('sales.delete')
    //
    // laundered the write past the authorization check — the row was gone under
    // authentication alone, and the endpoint was credited with both kinds. That
    // is the same laundering round 5 closed for UNGUARDED helpers, left open for
    // guarded ones by the very clause meant to keep the rule honest.
    //
    // So the exemption is narrowed to what it was for: a PINNED guard
    // declaration, whose body is on the reviewed list in this file and whose
    // writes (a session touch, a denial log) are part of the audited control.
    // A helper that merely CALLS a guard is ordinary code, and its writes are
    // writes. Its own guard is still credited — the position it sets is its own
    // call site, and a call at exactly `firstWrite` is not "after" it.
    //
    // ROUND 7, Codex finding 3 — WHOSE WRITE, not WHOSE DECLARATION.
    //
    // Round 6 read "pinned" off the declaration and then exempted everything that
    // declaration writes. Being on the guard list is an argument about what a
    // function ESTABLISHES; it is not an argument that the function changes only
    // its own audit trail. A pinned guard that also deletes rows still carries
    // those deletions past every check after it, which is the same laundering
    // one name further in. The exemption is now a statement about MODELS —
    // AUDITED_CONTROL_WRITE_MODELS — so a guard writing business data sets the
    // write position like any other helper.
    if (
      guardKindOfDeclaration(entry.target) !== null
      && !guardWritesBusinessData(entry.target, v)
    ) continue
    // ROUND 9, Codex finding 2 — a walk that did not finish is not a "no". A
    // callee whose writes could not be established sets the write position
    // exactly as a callee known to write does: the guards after it are credited
    // over something nobody checked, which is the whole defect this branch has
    // been unwinding.
    if (!declarationWriteIsRuledOut(entry.target, v)) {
      writeAt.push(entry.call.getStart())
      firstWrite = Math.min(firstWrite, entry.call.getStart())
    }
  }

  for (const entry of resolved) {
    // A guard that runs after the row is already written gated nothing (round 5).
    if (entry.call.getStart() > firstWrite) continue
    // ROUND 8 — THE ONE PLACE OFFSET AND EXECUTION ORDER MUST DISAGREE.
    //
    // `firstWrite` is a source offset, and a call starts before its own arguments
    // do while the arguments EVALUATE first. So a write parked inside a guard's
    // argument list sits at a LATER offset than the guard it defeats:
    //
    //   await requirePermission(await db.purchaseOrder.deleteMany({ where: { id } }) ? 'a' : 'b')
    //
    // The rows are gone before requirePermission is entered, and every offset
    // comparison in this function said the guard came first. A write inside a
    // guard's own source range is therefore never something that guard gated —
    // which leaves the case the write-exemption depends on untouched, because a
    // write in a guard's BODY is recorded at the guard's own call offset, not
    // strictly inside it.
    const from = entry.call.getStart()
    const to = entry.call.getEnd()
    if (writeAt.some((at) => at > from && at < to)) continue
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

/**
 * o3d-512h round 7, Codex finding 5 — NO WILDCARD-SHAPED HATCH.
 *
 * An export the scanner could not read is not the same kind of finding as an
 * export it read and found unguarded, and it must not be clearable the same way.
 * Round 6 made an unfollowable `export * from '…'` a violation and left `file:*`
 * able to suppress it — so the documented way to clear "nobody has enumerated
 * what this module publishes" was to exempt every export of the module, present
 * and future, on a reason written before any of them existed. That is not a
 * fail-closed rule with a safety valve; it is a fail-closed rule with a hole
 * shaped exactly like the thing it refuses to reason about.
 *
 * So:
 *   * a star re-export the graph cannot enumerate is NOT ALLOWLISTABLE AT ALL.
 *     There is no name to write an entry against and no way to make a claim about
 *     a set nobody has seen. The fix is to name the exports
 *     (`export { a, b } from '…'`), which turns them into ordinary endpoints the
 *     rules can judge — and the graph now FOLLOWS every star into the covered
 *     tree, so this only fires for a module genuinely outside it;
 *   * any other unverified export can be cleared only by an entry naming it
 *     exactly. `file:*` does not reach it. A wildcard is a claim about exports
 *     you can see; these are the ones you cannot.
 */
function isUnverifiedAllowlisted(
  allowlist: Record<string, string>,
  file: string,
  action: ExportedServerAction,
): boolean {
  if (action.unverified === 'star') return false
  return allowlist[`${file}:${action.name}`] !== undefined
}

const isExportedNode = (n: ts.Node): boolean =>
  !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))

const isAsyncNode = (n: ts.Node): boolean =>
  !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))

/**
 * Why an export of a `'use server'` module could not be judged.
 *
 * o3d-512h round 7, Codex finding 1. Every one of these used to be silence: the
 * collector recognised four shapes and dropped everything else on the floor, so a
 * module could publish a callable the scanners never saw and be reported green
 * forever. They are now outcomes, and every one of them is a violation.
 */
export type UnverifiedExport =
  /** A named export whose declaration the graph could not reach. */
  | 'unresolved'
  /** Published, but not established to be an async function — so not established NOT to be one. */
  | 'not-a-function'
  /** `export * from '…'` into a module the graph cannot enumerate. */
  | 'star'

/** One export of a `'use server'` module: an endpoint, or a reason it could not be judged. */
export type ExportedServerAction = {
  /** The name the endpoint is published under — `export { a as b }` publishes `b`. */
  name: string
  /** Block body, or an arrow's concise expression body. */
  body: ts.ConciseBody | undefined
  /**
   * The module the body is DECLARED in, when that is not the scanned file
   * (`export { handler } from './elsewhere'`). Resolution inside the body must be
   * done against this file, not against the module that re-publishes it.
   */
  file?: string
  /**
   * The export exists and could NOT be established to be a guarded-able endpoint.
   * An export nothing has read is not an export anything can vouch for, so callers
   * treat this as a violation rather than skipping it.
   */
  unverified?: UnverifiedExport
}

/** Every locally declared callable in a module, exported or not, by name. */
type LocalCallable = { body: ts.ConciseBody | undefined; isAsync: boolean }

function localCallables(sf: ts.SourceFile): Map<string, LocalCallable> {
  const out = new Map<string, LocalCallable>()
  ts.forEachChild(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      out.set(node.name.text, { body: node.body, isAsync: isAsyncNode(node) })
      return
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        const init = decl.initializer
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue
        out.set(decl.name.text, { body: init.body, isAsync: isAsyncNode(init) })
      }
    }
  })
  return out
}

/** Is the declaration this resolved to an `async` callable? */
function declarationIsAsync(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return isAsyncNode(node)
  // `export default async function () {}` / `export default async () => {}` have
  // no binding declaration between the export and the function (round 7).
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return isAsyncNode(node)
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = node.initializer
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return isAsyncNode(init)
  }
  return false
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
 * ROUND 7 WITHDRAWS a claim that stood here for four rounds: "`export default
 * async function …` is deliberately NOT collected: a default export is not a
 * callable Server Action name in Next.js's action protocol." That was asserted,
 * never established, and it is wrong in the direction that costs everything —
 * `default` is an export NAME, `import action from './actions'` is how a form
 * action is usually written, and the module's default export is registered and
 * addressable exactly as a named one is. `default` is collected.
 *
 * ---------------------------------------------------------------------------
 * o3d-512h round 6, Codex finding 2 — THE ENDPOINT NO SCANNER COULD SEE.
 *
 * Everything above keys off the `export` MODIFIER, and a named export
 * declaration carries no modifier:
 *
 *   async function wipeEverything(id: string) { await db.thing.deleteMany(…) }
 *   export { wipeEverything }                     // or: export { wipeEverything as wipe }
 *
 * That publishes exactly the same HTTP endpoint as `export async function`, and
 * NOTHING saw it — not the coverage rule, not the authentication-only inventory,
 * not the secret-read rule, not the Prisma-surface pin. Every other finding in
 * six rounds has been a property judged too generously; this one is an input
 * never presented, which is worse: a scanner that judges wrongly can be argued
 * with, and a scanner that cannot see the endpoint reports it green forever.
 *
 * Resolution answers it, as it has answered everything else here:
 *   * `export { local }` / `export { local as published }` — the local
 *     declaration is right there, so the body is taken from it and published
 *     under the exported name;
 *   * `export { imported }` and `export { x } from './m'` — the name is resolved
 *     through the graph to its declaring module, and the body is scanned in THAT
 *     module (`file`), because that is where its identifiers resolve;
 *   * anything the graph cannot follow is reported rather than dropped.
 *
 * ---------------------------------------------------------------------------
 * o3d-512h round 7, Codex finding 1 — THE RESIDUAL IS THE HOLE.
 *
 * Round 6 fixed one missed input by adding a fifth recognised shape. Codex round
 * 7 says the shape list is the defect: a collector that enumerates the forms it
 * knows drops everything else on the floor, silently, and "there are none today"
 * is the argument this file exists to stop anyone from making. `export default`,
 * `export const a = withAudit(async …)`, `export const { a, b } = …`,
 * `export * as ns from '…'`, an exported class with an async method, a sync
 * re-export — every one of them is a name a `'use server'` module publishes, and
 * every one of them left this function with nothing to say.
 *
 * So the collection is EXHAUSTIVE and the default is NOT VERIFIED. Every
 * top-level export of the module produces an entry:
 *
 *   * established to be an async function whose body was read  -> an endpoint;
 *   * a type-only export                                        -> nothing (it
 *     binds no value, so it publishes no endpoint);
 *   * anything else                                             -> `unverified`,
 *     which callers treat as a violation.
 *
 * Note the direction of the residual. The claim is NOT "this is an endpoint"; it
 * is "this module publishes this name and nobody established what it is". A
 * `'use server'` module may only export async functions, so the residual is
 * either a `next build` error — flagged, since that constraint is one this
 * scanner cannot check — or an endpoint no rule here can judge. Both are things
 * to be told about.
 *
 * The tree contains exactly one:
 * `app/actions/categories.ts: export { buildProductCategoryPathDisplay }`, a
 * re-export of a SYNCHRONOUS helper from a `'use server'` module — which
 * `next build` accepts, so "the build would have caught it" is not available as
 * an answer. It is allowlisted BY NAME in the coverage test, with what is and is
 * not verified about it stated there.
 *
 * A star re-export is followed through the graph rather than exempted — see the
 * `sawStar` block below and `ModuleGraph.exportedNamesOf`.
 */
export function exportedServerActions(
  sf: ts.SourceFile,
  file?: string,
  graph?: ModuleGraph,
): ExportedServerAction[] {
  const actions: ExportedServerAction[] = []
  const seen = new Set<string>()
  let callables: Map<string, LocalCallable> | undefined
  let sawStar = false

  const add = (action: ExportedServerAction) => {
    if (seen.has(action.name)) return
    seen.add(action.name)
    actions.push(action)
  }

  /** Publish `name` from a declaration the graph resolved. */
  const addResolved = (name: string, decl: Declaration | null) => {
    if (!decl) return add({ name, body: undefined, unverified: 'unresolved' })
    const body = declarationBody(decl)
    if (!body || !declarationIsAsync(decl.node)) {
      return add({ name, body: undefined, unverified: 'not-a-function' })
    }
    add({ name, body, file: decl.file })
  }

  // Function declarations without a body are overload SIGNATURES; the
  // implementation below them carries the body and is what gets published.
  const bodied = new Set<string>()
  ts.forEachChild(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) bodied.add(node.name.text)
  })

  ts.forEachChild(sf, (node) => {
    const exported = isExportedNode(node)
    const isDefault = ts.canHaveModifiers(node)
      && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    const ambient = ts.canHaveModifiers(node)
      && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)

    if (ts.isFunctionDeclaration(node)) {
      if (!exported || ambient) return
      const name = isDefault ? 'default' : node.name?.text
      if (!name) return
      if (!node.body) {
        // An overload signature with an implementation below it publishes nothing
        // of its own; one WITHOUT is a declaration with no body to read.
        if (!isDefault && node.name && bodied.has(node.name.text)) return
        return add({ name, body: undefined, unverified: 'not-a-function' })
      }
      if (!isAsyncNode(node)) return add({ name, body: undefined, unverified: 'not-a-function' })
      return add({ name, body: node.body })
    }

    // `export const a = async () => {}, b = async function () {}` — every
    // declarator in the statement is its own export, so each is its own endpoint.
    if (ts.isVariableStatement(node)) {
      if (!exported || ambient) return
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) {
          // `export const { a, b } = …` binds and publishes every destructured
          // name, and none of them has a declaration site the graph can read.
          const names = new Set<string>()
          collectBindingNames(decl.name, names)
          for (const n of names) add({ name: n, body: undefined, unverified: 'not-a-function' })
          continue
        }
        const init = decl.initializer
        if (
          init
          && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          && isAsyncNode(init)
        ) {
          add({ name: decl.name.text, body: init.body })
          continue
        }
        // A wrapped action (`export const a = withAudit(async () => …)`), a
        // constant, a sync arrow: published, and not established to be an async
        // function whose body anything has read.
        add({ name: decl.name.text, body: undefined, unverified: 'not-a-function' })
      }
      return
    }

    if (ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
      if (!exported || ambient) return
      const name = isDefault
        ? 'default'
        : node.name && ts.isIdentifier(node.name) ? node.name.text : undefined
      if (name) add({ name, body: undefined, unverified: 'not-a-function' })
      return
    }

    if (ts.isImportEqualsDeclaration(node)) {
      if (exported) add({ name: node.name.text, body: undefined, unverified: 'not-a-function' })
      return
    }

    // `export default …` and `export = …`.
    if (ts.isExportAssignment(node)) {
      if (node.isExportEquals) {
        return add({ name: 'export=', body: undefined, unverified: 'not-a-function' })
      }
      const expr = node.expression
      if ((ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) && isAsyncNode(expr)) {
        return add({ name: 'default', body: expr.body })
      }
      if (ts.isIdentifier(expr) && file && graph) {
        return addResolved('default', graph.resolveExportedName(file, 'default'))
      }
      return add({ name: 'default', body: undefined, unverified: 'not-a-function' })
    }

    // `export { … }` / `export { … } from '…'` / `export * from '…'` (round 6).
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) return

      if (!node.exportClause) {
        // `export * from '…'`: a set of published endpoints. Round 7 FOLLOWS it
        // (see below) instead of exempting it; the flag is what makes the
        // unenumerable case fail rather than pass silently.
        if (node.moduleSpecifier) sawStar = true
        return
      }
      // `export * as ns from '…'` publishes an OBJECT under `ns`. Not a callable
      // async function, and not established not to be published — so, like every
      // other unrecognised form, it is reported rather than dropped.
      if (ts.isNamespaceExport(node.exportClause)) {
        return add({ name: node.exportClause.name.text, body: undefined, unverified: 'not-a-function' })
      }

      for (const el of node.exportClause.elements) {
        if (el.isTypeOnly) continue
        const published = el.name.text
        const local = (el.propertyName ?? el.name).text

        if (!node.moduleSpecifier) {
          callables ??= localCallables(sf)
          const own = callables.get(local)
          if (own) {
            if (own.isAsync && own.body) add({ name: published, body: own.body })
            // A sync local re-exported from a `'use server'` module. Whether
            // Next's action protocol publishes it is a `next build` question this
            // scanner cannot settle — and "cannot settle" is not "no".
            else add({ name: published, body: undefined, unverified: 'not-a-function' })
            continue
          }
        }

        // Imported, or re-exported from another module: only resolution can say.
        addResolved(published, file && graph ? graph.resolveExportedName(file, published) : null)
      }
    }
  })

  // ROUND 7, Codex finding 5 — FOLLOW THE STAR.
  //
  // Everything above reads the module's own text. A star re-export publishes
  // names that are not in it, and round 6 answered that with a violation clearable
  // only by a `file:*` wildcard. The graph can enumerate the target instead: ask
  // it for the module's COMPLETE published set, and anything not already accounted
  // for arrived through a star and is resolved and judged like any other export.
  // Only a star into a module outside the graph stays unverified — and that one is
  // not allowlistable at all (isUnverifiedAllowlisted).
  if (sawStar) {
    const published = file && graph ? graph.exportedNamesOf(file) : null
    if (published === null) actions.push({ name: '*', body: undefined, unverified: 'star' })
    else for (const name of published) if (!seen.has(name)) addResolved(name, graph!.resolveExportedName(file!, name))
  }

  return actions
}

/** Every name a binding pattern binds: `{ a, b: { c } }` -> a, c. */
function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text)
    return
  }
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue
    collectBindingNames(el.name, out)
  }
}

/** Unguarded exported server actions in one source, as `file:name`. */
export function scanSource(
  file: string,
  source: string,
  allowlist: Record<string, string> = {},
  graph?: ModuleGraph,
): string[] {
  if (!isUseServer(source, file)) return []
  const violations: string[] = []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

  for (const action of exportedServerActions(sf, file, graph)) {
    // An export whose body nothing could read is NOT VERIFIED, and this file has
    // treated not-verified as not-guarded since round 3. Round 7 widened WHICH
    // exports reach this branch — every published name that is not established to
    // be an async function — and narrowed what can clear it.
    if (action.unverified) {
      if (!isUnverifiedAllowlisted(allowlist, file, action)) {
        violations.push(`${file}:${action.name}`)
      }
      continue
    }
    if (!action.body) continue
    const kinds = guardKindsOfBody(action.file ?? file, action.body, graph)
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

  // The executable region, not the body: a decrypting read in a parameter default
  // initializer is a read (round 9, finding 1).
  for (const region of executableRegions(body)) visit(region)
  return found
}

export function scanSecretReadingActions(
  file: string,
  source: string,
  allowlist: Record<string, string> = {},
  graph?: ModuleGraph,
): string[] {
  if (!isUseServer(source, file)) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const violations: string[] = []

  for (const action of exportedServerActions(sf, file, graph)) {
    // An UNVERIFIED export is already a coverage violation (scanSource); nothing
    // is known about what it reads, so it is not double-reported here.
    if (!action.body) continue

    const bodyFile = action.file ?? file
    if (!readsSettingSecret(bodyFile, action.body, graph)) continue
    const kinds = guardKindsOfBody(bodyFile, action.body, graph)
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
    // ROUND 8, Codex finding 1 — THE FILE NOBODY OWNED.
    //
    // This walker took `.ts`; scanUseServerOutsideActions took `.ts` and `.tsx`
    // and then skipped anything sitting directly in app/actions because "it is
    // covered by scanActionsDir". `app/actions/wipe.tsx` was therefore covered by
    // NEITHER — a `'use server'` module in the directory this whole file is
    // named after, publishing an unguarded `deleteMany`, and every rule here
    // returned green. Two filters describing the same boundary in different
    // words is how a file falls between them, so both now ask one predicate.
    if (!isModuleFileName(entry)) continue
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
    resolveExportedName: (f, n) => graph.resolveExportedName(map(f), n),
    exportedNamesOf: (f) => graph.exportedNamesOf(map(f)),
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
      if (!isModuleFileName(entry.name)) continue
      // Covered by scanActionsDir — which, since round 8, takes exactly the same
      // set of files this predicate does. The two used to disagree.
      if (path.dirname(full) === actionsDir) continue
      const source = readFileSync(full, 'utf8')
      const rel = path.relative(root, full).split(path.sep).join('/')
      if (!isUseServer(source, rel)) continue
      violations.push(...scanner(rel, source, allowlist, graph))
    }
  }

  for (const r of scanRoots) walk(path.join(root, r))
  return violations
}

// ---------------------------------------------------------------------------
// Round 7, Codex finding 1 — THE ENDPOINT THAT IS NOT AN EXPORT AT ALL
// ---------------------------------------------------------------------------

/**
 * An INLINE server action: a function whose own body carries the directive.
 *
 *   export default function EditPage({ id }: Props) {
 *     async function save(form: FormData) {
 *       'use server'
 *       await db.thing.update({ where: { id }, data: … })   // no guard, no export
 *     }
 *     return <form action={save} />
 *   }
 *
 * `save` is a public HTTP endpoint. Next registers it as a server reference, its
 * id ships to the browser, and anyone who has ever loaded that page can POST to
 * it directly with any arguments they like — the closed-over `id` is encrypted,
 * but every declared parameter is attacker-controlled. It is exactly the endpoint
 * class this whole file exists for.
 *
 * And NOTHING here could see one. Every rule in this file starts with
 * `if (!isUseServer(source, file)) return []`, which asks about the module's directive
 * prologue; both directory walkers skip a file that fails it. So the entire
 * inline form — the form Next's own documentation reaches for first — was outside
 * the scanners' input, in a file whose header comment argues that a rule which
 * cannot see an endpoint reports it green forever.
 *
 * The rule applied is the same one, unchanged: the body must PROVABLY execute a
 * call resolving to a pinned guard, before its first write. There are none in the
 * tree today, and "there are none today" is precisely why this exists — the guard
 * has to be in place before the first one is written, not after.
 */
export type InlineServerAction = {
  /** `<enclosing>.<name>` where they can be named — the key a violation is reported under. */
  name: string
  line: number
  body: ts.Block
}

/** Every function in this source whose own body opens with `'use server'`. */
export function inlineServerActions(sf: ts.SourceFile): InlineServerAction[] {
  const found: InlineServerAction[] = []

  const nameOf = (node: ts.Node): string => {
    const named = node as { name?: ts.Node }
    if (named.name && (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name))) {
      return named.name.text
    }
    // `const save = async () => { 'use server' … }`, `{ save: async () => … }`.
    const parent = node.parent
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    return '<anonymous>'
  }

  const visit = (node: ts.Node) => {
    if (isFunctionLikeNode(node) || ts.isFunctionDeclaration(node)) {
      const body = (node as { body?: ts.Node }).body
      if (body && ts.isBlock(body) && hasUseServerPrologue(body.statements)) {
        found.push({
          name: nameOf(node),
          line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          body,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sf, visit)
  return found
}

/** Unguarded INLINE server actions in one source, as `file:name@line`. */
export function scanInlineServerActions(
  file: string,
  source: string,
  allowlist: Record<string, string> = {},
  graph?: ModuleGraph,
): string[] {
  if (!source.includes('use server')) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const violations: string[] = []
  for (const action of inlineServerActions(sf)) {
    const key = `${action.name}@${action.line}`
    if (guardKindsOfBody(file, action.body, graph).size > 0) continue
    // A line-numbered key moves with an edit, so a wildcard is the only stable way
    // to name one — which is exactly the shape round 7 refuses. An inline action
    // therefore has no allowlist at all beyond an exact key; the fix is a guard.
    if (allowlist[`${file}:${key}`] !== undefined) continue
    violations.push(`${file}:${key}`)
  }
  return violations
}

/**
 * Every INLINE `'use server'` function in the tree, whatever file it sits in.
 *
 * A separate walker because both existing ones filter on the module directive
 * FIRST — an inline action lives in a file that has none, which is the entire
 * reason it was invisible.
 */
export function scanTreeForInlineServerActions(
  root: string,
  scanRoots: string[],
  allowlist: Record<string, string> = {},
  graph?: ModuleGraph,
): string[] {
  const violations: string[] = []

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!isModuleFileName(entry.name)) continue
      const source = readFileSync(full, 'utf8')
      if (!source.includes('use server')) continue // keeps the parse off ~800 files
      const rel = path.relative(root, full).split(path.sep).join('/')
      violations.push(...scanInlineServerActions(rel, source, allowlist, graph))
    }
  }

  for (const r of scanRoots) walk(path.join(root, r))
  return violations
}

// ---------------------------------------------------------------------------
// Round 8, Codex finding 1 — WHAT THE ROOTS DO NOT COVER
// ---------------------------------------------------------------------------

/**
 * Every module in the repo that MENTIONS `use server` and sits outside the roots
 * the scanners walk.
 *
 * Round 7 answered "a scanner that cannot see an endpoint reports it green
 * forever" for a directive behind a comment and for the inline form. It did not
 * answer it for a file in a directory nobody listed. `SCAN_ROOTS` is a three-name
 * array in the coverage test, asserted nowhere, and a `'use server'` module under
 * `types/`, `scripts/`, a new top-level directory, or `proxy.ts` at the repo root
 * is compiled and published by Next exactly like one under `app/` — while every
 * rule in this file is walking somewhere else.
 *
 * The answer is not a wider root list, which decays the same way. It is that the
 * roots must be shown to COVER the tree: this returns the residue, the coverage
 * test pins it against a stated exemption list, and a `'use server'` module
 * appearing anywhere new fails the build with its own path in the message.
 *
 * Deliberately a mention test, not a directive test: `isUseServer` would let a
 * file that only nearly qualifies (a directive inside a nested block, a spelling
 * this file does not parse) drop out of the residue too. What is claimed here is
 * only "nothing here talks about server actions unreviewed", which is the weaker
 * claim a coverage check can actually make good on.
 */
export function useServerModulesOutsideScanRoots(root: string, scanRoots: string[]): string[] {
  const rootsAbs = scanRoots.map((r) => path.join(root, r))
  const found: string[] = []

  const walk = (dir: string) => {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (rootsAbs.includes(full)) continue // walked by the scanners
        walk(full)
        continue
      }
      if (!isModuleFileName(entry.name)) continue
      let source: string
      try {
        source = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (!source.includes('use server')) continue
      found.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }

  walk(root)
  return found.sort()
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
  if (!isUseServer(source, file)) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: string[] = []

  for (const action of exportedServerActions(sf, file, graph)) {
    // Unresolved: not an authentication-only endpoint — it is an UNGUARDED one,
    // which is scanSource's violation, not this inventory's entry.
    if (!action.body) continue
    const kinds = guardKindsOfBody(action.file ?? file, action.body, graph)
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
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      // Round 10, finding 1: `db['setting']` reaches `setting`, and an unreadable
      // subscript reaches a table this walk cannot name. The surface is a PINNED
      // list, so an unnameable model must appear in it rather than vanish from it.
      if (ts.isIdentifier(n.expression) && DATA_CLIENT_ROOTS.has(n.expression.text)) {
        const model = accessedMemberName(n)
        if (model !== null) models.add(model === UNREADABLE_MEMBER ? '<unknown>' : model)
      }
    }
    ts.forEachChild(n, visit)
  }
  for (const region of executableRegions(body)) visit(region)

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
    const action = exportedServerActions(sf, file, graph).find((a) => a.name === name)
    out[key] = action
      ? (action.unverified
        ? [`<export not verified: ${action.unverified}>`]
        : reachedPrismaModels(action.file ?? file, action.body, graph))
      : ['<export not found>']
  }
  return out
}

export { createRepoGraph }
export type { ModuleGraph, Declaration }
