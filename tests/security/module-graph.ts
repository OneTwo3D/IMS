/**
 * A RESOLVING module graph — the one mechanism behind the security scanners
 * (o3d-512h round 3).
 *
 * Codex round 3 raised four separate findings that are one defect wearing four
 * hats: in every case the guard CREDITED something it had not VERIFIED.
 *
 *   * the coverage detector credited a delegate it never looked at, and credited
 *     a guard NAME that was never called;
 *   * the authentication-only inventory credited an endpoint with "reviewed" on
 *     the strength of its gate, while saying nothing about what it returns;
 *   * the raw-`maskSecret` pin credited every file that did not match one exact
 *     import shape;
 *
 * and the live tree had already paid for it: app/actions/allocation.ts declared
 * a module-local `requireAuth` that shadowed the import and checked only that a
 * user id existed — no session-invalidation check, no 2FA check. Three endpoints
 * sat behind it and every name-matching rule called them guarded.
 *
 * The answer to all of it is the same and there is only one of it: stop matching
 * names, and RESOLVE them. This module maps an identifier as written in one file
 * to the declaration it actually refers to, following named/aliased/namespace/
 * default imports, `export … from` re-exports and `export *` chains. A rule
 * built on it can ask "does this call reach lib/auth/server.ts:requirePermission"
 * instead of "does the substring requirePermission appear", and a shadowed local
 * or an aliased import answers honestly.
 *
 * It is deliberately a hand-rolled binder rather than a full ts.Program: the
 * scanners need declaration identity, not types, and a Program over the whole
 * app would cost more than every security test combined. Where it cannot resolve
 * something it returns null, and every caller treats null as NOT VERIFIED —
 * never as "probably fine".
 *
 * Not named *.test.ts on purpose — `npm run test:unit` globs tests/**\/*.test.ts.
 * Its own behaviour is exercised in module-graph.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'

/** A resolved declaration site: the file that declares it, and the name it is declared as. */
export type Declaration = {
  /** Graph key (repo-relative POSIX path for a repo graph). */
  file: string
  name: string
  node: ts.Node
}

export type ModuleGraph = {
  /** Every file key in the graph. */
  files(): string[]
  /** Source text for a key, or undefined when the key is outside the graph. */
  source(file: string): string | undefined
  sourceFile(file: string): ts.SourceFile | undefined
  /**
   * The declaration an identifier written inside `file` refers to, or null when
   * it cannot be resolved (a node_modules import, a parameter, a global).
   *
   * `at` is the identifier's own node. Pass it whenever you have it: without a
   * position the answer is a MODULE-SCOPE answer, and a name bound in an
   * enclosing function, block, parameter list or catch clause is a different
   * binding entirely. With `at`, an intervening binding makes the answer null —
   * NOT VERIFIED — rather than the module-scope import (o3d-512h round 5).
   */
  resolve(file: string, name: string, at?: ts.Node): Declaration | null
  /** The declaration `<ns>.<member>` refers to, when `ns` is a namespace import. */
  resolveMember(file: string, ns: string, member: string, at?: ts.Node): Declaration | null
  /**
   * Is `name` bound at MODULE scope in `file` — by any declaration or any import,
   * resolvable or not?
   *
   * The question a global needs answered: `Symbol(...)` means the built-in only
   * while nothing in the module has taken the name. `resolve` cannot answer it,
   * because an import the graph cannot follow (`import { Symbol } from 'x'`)
   * resolves to null exactly as an untouched global does. Returns true when the
   * file cannot be read: a module nobody looked at cannot vouch for a global.
   *
   * EVERY module-scope binding form counts, not the ones a resolver happens to
   * index — see `moduleBindings` (o3d-512h round 6, Codex finding 1).
   */
  bindsAtModuleScope(file: string, name: string): boolean
  /**
   * The declaration the EXPORT `name` of `file` refers to — through
   * `export { x as name }`, `export { name } from '…'`, a local declaration, or
   * an `export *` chain. Null when it cannot be followed.
   *
   * `resolve` answers "what does this identifier mean INSIDE the module"; this
   * answers "what does the outside world get when it asks for this export", and
   * a `'use server'` module's exports are its HTTP endpoints.
   */
  resolveExportedName(file: string, name: string): Declaration | null
  /**
   * EVERY value name this module publishes, or null when the set cannot be
   * enumerated completely.
   *
   * o3d-512h round 7, Codex finding 5. Round 6 made an unfollowable
   * `export * from '…'` a violation — fail-closed, and the only way to clear it
   * was a `file:*` allowlist entry, which is a blanket exemption for every
   * present and future export of the file. That is a wildcard-shaped escape
   * hatch bolted onto a rule about not knowing what is published, and it is how
   * a rule decays.
   *
   * So the star is FOLLOWED instead of excused: when the target module is in the
   * graph, its exports are enumerated and each one is judged individually, and
   * there is nothing left to exempt. Null — the genuinely unenumerable case,
   * a star into a module nobody covers — is what stays a violation, and it is
   * fixed by naming the exports, not by widening an allowlist.
   *
   * Type-only exports are left out: they bind no value, so they publish no
   * endpoint. `export * as ns from '…'` publishes the namespace name itself.
   */
  exportedNamesOf(file: string): string[] | null
  /**
   * The declaration a call target refers to: `f()`, `ns.f()`, `mod.f()`.
   * Returns null for anything whose target is a value the graph cannot follow
   * (`connector.getAccounts()`, `db.user.findMany()`).
   */
  resolveCallTarget(file: string, callee: ts.Expression): Declaration | null
  /**
   * Every file key that references the export `name` of `declFile` — under any
   * local alias, through a namespace import, or via a re-export chain.
   *
   * `prefilter` is an optional cheap substring test on the source, to avoid
   * parsing the whole tree for a question about one symbol.
   */
  referrers(declFile: string, name: string, prefilter?: (source: string) => boolean): string[]
}

/** The function body of a declaration, when it declares a function. */
export function declarationBody(decl: Declaration | null): ts.ConciseBody | undefined {
  if (!decl) return undefined
  const node = decl.node
  if (ts.isFunctionDeclaration(node)) return node.body
  if (ts.isMethodDeclaration(node)) return node.body
  // `export default async function () {}` / `export default async () => {}` — the
  // declaration IS the function, with no binding name in between (round 7).
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node.body
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = node.initializer
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body
  }
  return undefined
}

/**
 * Is `name` bound by a scope BETWEEN `node` and the module top level?
 *
 * o3d-512h round 5, Codex finding 1. The resolver was built so aliasing could not
 * defeat a name match, and round 4's own fixture asserted that a shadow "counts
 * for nothing" — but the shadow it tested was a MODULE-LEVEL one, which is the
 * only kind `locals` records. A shadow one scope in is invisible to it:
 *
 *   import { requirePermission } from '@/lib/auth/server'
 *   export async function deleteThing(id: string) {
 *     const requirePermission = async () => {}   // does nothing
 *     await requirePermission('sales.delete')     // credited as the real guard
 *   }
 *
 * `locals` holds top-level declarations only, so `resolveLocal` fell straight
 * through to `imports` and answered with the security primitive. That is the
 * branch's own defect once more: the checker crediting something it had not
 * established.
 *
 * So resolution becomes position-aware. Every binding form that can take a name
 * away from the module scope counts — parameters and their destructuring
 * patterns, `const`/`let`/`var` in any enclosing block, block-scoped function and
 * class declarations, a named function expression's own name, a `catch` binding,
 * a `for`/`for…of` initializer — and `var`/function hoisting is applied at the
 * enclosing function rather than at the block that spells it.
 *
 * A shadow makes the answer NULL, not "the local declaration": the local binding
 * is an arbitrary runtime value the graph has no declaration site for, and every
 * caller already treats null as not-verified. Under-crediting is the direction
 * that turns the build red.
 */
export function hasLexicalShadow(node: ts.Node, name: string): boolean {
  let cur: ts.Node | undefined = node.parent
  while (cur && !ts.isSourceFile(cur)) {
    if (scopeBinds(cur, name)) return true
    cur = cur.parent
  }
  return false
}

function addBindingNames(name: ts.BindingName | undefined, out: Set<string>): void {
  if (!name) return
  if (ts.isIdentifier(name)) {
    out.add(name.text)
    return
  }
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue
    addBindingNames(el.name, out)
  }
}

function addStatementBindings(st: ts.Statement, out: Set<string>): void {
  if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) addBindingNames(d.name, out)
    return
  }
  if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
    out.add(st.name.text)
    return
  }
  if (ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) {
    if (ts.isIdentifier(st.name as ts.Node)) out.add((st.name as ts.Identifier).text)
    return
  }
  if (ts.isImportEqualsDeclaration(st)) out.add(st.name.text)
}

/** `var` and function declarations belong to the enclosing FUNCTION, not the block. */
function addHoistedBindings(node: ts.Node, out: Set<string>): void {
  const visit = (n: ts.Node) => {
    if (isScopeFunctionLike(n)) return // its own hoisting, not ours
    if (ts.isVariableStatement(n) && (n.declarationList.flags & ts.NodeFlags.Let) === 0
      && (n.declarationList.flags & ts.NodeFlags.Const) === 0) {
      for (const d of n.declarationList.declarations) addBindingNames(d.name, out)
    }
    if (ts.isFunctionDeclaration(n) && n.name) out.add(n.name.text)
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)
}

const isScopeFunctionLike = (n: ts.Node): boolean =>
  ts.isArrowFunction(n)
  || ts.isFunctionExpression(n)
  || ts.isFunctionDeclaration(n)
  || ts.isMethodDeclaration(n)
  || ts.isConstructorDeclaration(n)
  || ts.isGetAccessorDeclaration(n)
  || ts.isSetAccessorDeclaration(n)

/** Names this one node binds directly. */
function scopeBinds(node: ts.Node, name: string): boolean {
  const out = new Set<string>()

  if (isScopeFunctionLike(node)) {
    for (const p of (node as ts.SignatureDeclaration).parameters ?? []) addBindingNames(p.name, out)
    // A named function expression binds its own name inside itself.
    if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name) {
      out.add(node.name.text)
    }
    const body = (node as { body?: ts.Node }).body
    if (body) addHoistedBindings(body, out)
    return out.has(name)
  }

  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    if (node.name) out.add(node.name.text)
    return out.has(name)
  }

  if (ts.isBlock(node) || ts.isModuleBlock(node)) {
    for (const st of node.statements) addStatementBindings(st, out)
    return out.has(name)
  }

  if (ts.isCaseBlock(node)) {
    for (const clause of node.clauses) {
      for (const st of clause.statements) addStatementBindings(st, out)
    }
    return out.has(name)
  }

  if (ts.isCatchClause(node)) {
    addBindingNames(node.variableDeclaration?.name, out)
    return out.has(name)
  }

  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    const init = node.initializer
    if (init && ts.isVariableDeclarationList(init)) {
      for (const d of init.declarations) addBindingNames(d.name, out)
    }
    return out.has(name)
  }

  return false
}

/** `db.setting.findMany` -> `db`; `f` -> `f`. Null when the root is not an identifier. */
export function calleeRootName(expr: ts.Expression): string | null {
  let cur: ts.Expression = expr
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    cur = cur.expression
  }
  return ts.isIdentifier(cur) ? cur.text : null
}

/** The final name in a call target: `ns.requireAuth` -> `requireAuth`. */
export function calleeLeafName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text
  return null
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ImportBinding = { spec: string; imported: string | '*' | 'default' }
type ExportBinding = { local?: string; spec?: string; imported?: string }

type FileInfo = {
  sf: ts.SourceFile
  /** local name -> where it was imported from */
  imports: Map<string, ImportBinding>
  /** top-level declarations by name */
  locals: Map<string, ts.Node>
  /**
   * EVERY name bound at module scope, by any form — including the ones `locals`
   * and `imports` cannot represent.
   *
   * o3d-512h round 6, Codex finding 1. `bindsAtModuleScope` used to ask those two
   * maps, and `locals` records a variable declaration only when its name is a
   * plain identifier (`if (!ts.isIdentifier(decl.name)) continue`). So
   *
   *   const { Symbol } = require('./compat')       // or: = compat, or = { Symbol: String }
   *   const INTERNAL_ACTION_BYPASS = Symbol('internal')
   *
   * bound the name at module scope and was invisible to the very question
   * `bindsAtModuleScope` exists to answer: the destructured binding was not in
   * `locals`, was not in `imports`, and `hasLexicalShadow` stops AT the source
   * file, so nothing looked at it. The sentinel was then certified as the
   * built-in `Symbol` and every guard behind it credited — while a client can
   * send whatever that destructured callable returns.
   *
   * This set is deliberately a superset of what resolves: `const { x } = y` binds
   * `x` even though the graph has no declaration site for it, and "bound" is the
   * whole question. Type-only declarations (interfaces, type aliases) are left
   * out — they do not bind a value, so they cannot take a global away.
   */
  moduleBindings: Set<string>
  /** names this module exports from its own declarations */
  exportedNames: Set<string>
  /** exported name -> `export { x as y }` / `export { x } from '…'` */
  exportAliases: Map<string, ExportBinding>
  /** `export * from '…'` specifiers */
  starExports: string[]
  /**
   * `export default …` — the declaration node, when there is one.
   *
   * o3d-512h round 7. `default` is an export NAME like any other: a `'use server'`
   * module's default export is addressable over the action protocol exactly as a
   * named one is. Not indexing it meant `resolveExportedName(file, 'default')`
   * answered null, which every caller reads as NOT VERIFIED.
   */
  defaultExport?: ts.Node
}

/**
 * Every extension a module in this tree can be written in.
 *
 * o3d-512h round 8, Codex finding 1. A `'use server'` module is a module, not a
 * `.ts` file, and the scanners' input surface was pinned to the two extensions
 * the tree happens to use. What the DIRECTIVE creates is an endpoint; what the
 * extension decides is only whether anything here reads the file.
 */
export const MODULE_FILE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const

/** Is this filename a module the scanners must read? Test files excluded. */
export function isModuleFileName(name: string): boolean {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return false
  return /\.[cm]?[jt]sx?$/.test(name)
}

/** The script kind TypeScript must parse a source as — JSX is not optional. */
export function probeFileName(file: string): string {
  return /\.(tsx|jsx)$/.test(file) ? 'directive-probe.tsx' : 'directive-probe.ts'
}

const SOURCE_EXTENSIONS = [
  '',
  ...MODULE_FILE_EXTENSIONS,
  ...MODULE_FILE_EXTENSIONS.map((e) => `/index${e}`),
]

function buildFileInfo(file: string, source: string): FileInfo {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const info: FileInfo = {
    sf,
    imports: new Map(),
    locals: new Map(),
    exportedNames: new Set(),
    exportAliases: new Map(),
    starExports: [],
    moduleBindings: new Set(),
  }

  // Pass one: what this module BINDS at its top level, by every form. Kept
  // separate from the resolution pass below, which indexes only the forms it can
  // resolve — and it was that gap between "bound" and "indexed" that let a
  // destructured `Symbol` pass for the built-in (round 6, finding 1).
  ts.forEachChild(sf, (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (!clause) return
      if (clause.name) info.moduleBindings.add(clause.name.text)
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) info.moduleBindings.add(bindings.name.text)
      else if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) info.moduleBindings.add(el.name.text)
      }
      return
    }
    addStatementBindings(node as ts.Statement, info.moduleBindings)
  })

  const isExported = (n: ts.Node): boolean =>
    !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))

  ts.forEachChild(sf, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      const clause = node.importClause
      if (!clause) return
      if (clause.name) info.imports.set(clause.name.text, { spec, imported: 'default' })
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) {
        info.imports.set(bindings.name.text, { spec, imported: '*' })
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          info.imports.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text })
        }
      }
      return
    }

    if (ts.isExportDeclaration(node)) {
      // A type-only export binds no value and publishes no endpoint. Indexing it
      // as an export would put a type name into `exportedNamesOf`, which is the
      // set the scanners treat as the module's HTTP surface.
      if (node.isTypeOnly) return
      const spec = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined
      if (!node.exportClause) {
        if (spec) info.starExports.push(spec)
        return
      }
      if (ts.isNamespaceExport(node.exportClause)) {
        if (spec) info.exportAliases.set(node.exportClause.name.text, { spec, imported: '*' })
        return
      }
      for (const el of node.exportClause.elements) {
        if (el.isTypeOnly) continue
        const original = (el.propertyName ?? el.name).text
        if (spec) info.exportAliases.set(el.name.text, { spec, imported: original })
        else info.exportAliases.set(el.name.text, { local: original })
      }
      return
    }

    // `export default async function …` / `export default expr` — `default` is an
    // export name, and a `'use server'` module publishes it (round 7).
    if (ts.isExportAssignment(node)) {
      if (!node.isExportEquals) info.defaultExport = node.expression
      return
    }

    const isDefault = (n: ts.Node): boolean =>
      !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))

    if (ts.isFunctionDeclaration(node)) {
      if (isDefault(node)) info.defaultExport = node
      if (!node.name) return
      info.locals.set(node.name.text, node)
      if (isExported(node)) info.exportedNames.add(node.name.text)
      return
    }

    if (ts.isClassDeclaration(node)) {
      if (isDefault(node)) info.defaultExport = node
      if (!node.name) return
      info.locals.set(node.name.text, node)
      if (isExported(node)) info.exportedNames.add(node.name.text)
      return
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        info.locals.set(decl.name.text, decl)
      }
    }
  })

  // ---------------------------------------------------------------------------
  // o3d-512h round 8, Codex finding 2 — THE OTHER ENUMERATOR.
  //
  // Round 7 made server-action-guard-scan.ts:exportedServerActions EXHAUSTIVE:
  // every top-level export of a `'use server'` module produces an entry, and
  // anything not established to be an async function is NOT VERIFIED rather than
  // dropped. It then routed `export * from '…'` through THIS function, which was
  // still round 3's shape list — function declarations, class declarations, and
  // variable declarators with an IDENTIFIER name. So every form round 7 had just
  // made visible went invisible again the moment it arrived through a star:
  //
  //   // app/actions/star.ts
  //   'use server'
  //   export * from './handlers'
  //
  //   // app/actions/handlers.ts   (NOT a 'use server' module — no compiler check)
  //   export const { wipeAll, purgeAll } = makeHandlers()
  //   export enum Mode { … }
  //
  // `exportedServerActions` reported ZERO exports for star.ts, so the coverage
  // rule, the secret-read rule and the authentication-only inventory all had
  // nothing to judge — the round-6 failure mode ("a scanner that cannot see an
  // endpoint reports it green forever") reproduced one indirection along. And a
  // star target is the one place the compiler's "only async functions may be
  // exported from a `use server` file" check does NOT apply, because the target
  // module carries no directive of its own.
  //
  // Two enumerators of the same set will drift again, so this one stops being a
  // shape list: the published name set is taken from `addStatementBindings`, the
  // same binder `moduleBindings` uses, which walks EVERY declaration form —
  // destructuring and array patterns, enums, namespaces, `import x = …`. A name
  // published without a declaration `locals` can index resolves to null, which
  // callers already treat as NOT VERIFIED; that is the fail-closed direction, and
  // it is the direction a name nobody could read belongs in.
  ts.forEachChild(sf, (node) => {
    if (!ts.canHaveModifiers(node)) return
    const mods = ts.getModifiers(node)
    if (!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return
    // `export declare …` binds nothing at runtime, so it publishes no endpoint.
    if (mods.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return
    if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      info.exportedNames.add('default')
      return
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return
    addStatementBindings(node as ts.Statement, info.exportedNames)
  })

  return info
}

type GraphOptions = {
  /** Resolve a module specifier written in `from` to a graph key, or null. */
  resolveSpecifier: (from: string, spec: string) => string | null
}

function createGraph(
  keys: string[],
  readSource: (file: string) => string | undefined,
  options: GraphOptions,
): ModuleGraph {
  const keySet = new Set(keys)
  const sources = new Map<string, string | undefined>()
  const infos = new Map<string, FileInfo | null>()

  const source = (file: string): string | undefined => {
    if (!sources.has(file)) sources.set(file, keySet.has(file) ? readSource(file) : undefined)
    return sources.get(file)
  }

  const info = (file: string): FileInfo | null => {
    if (infos.has(file)) return infos.get(file) ?? null
    const src = source(file)
    const built = src === undefined ? null : buildFileInfo(file, src)
    infos.set(file, built)
    return built
  }

  const resolveExport = (
    file: string,
    name: string,
    seen: Set<string>,
  ): Declaration | null => {
    const key = `${file}:${name}`
    if (seen.has(key)) return null
    seen.add(key)

    const fi = info(file)
    if (!fi) return null

    if (name === 'default' && !fi.exportAliases.has('default')) {
      const node = fi.defaultExport
      if (!node) return null
      // `export default foo` names a local; `export default async function …`
      // and `export default async () => {}` ARE the declaration.
      if (ts.isIdentifier(node)) return resolveLocal(file, node.text, seen)
      return { file, name: 'default', node }
    }

    const alias = fi.exportAliases.get(name)
    if (alias) {
      if (alias.spec) {
        const target = options.resolveSpecifier(file, alias.spec)
        if (!target) return null
        if (alias.imported === '*') return null
        return resolveExport(target, alias.imported as string, seen)
      }
      if (alias.local) return resolveLocal(file, alias.local, seen)
      return null
    }

    if (fi.exportedNames.has(name)) {
      const node = fi.locals.get(name)
      return node ? { file, name, node } : null
    }

    for (const spec of fi.starExports) {
      const target = options.resolveSpecifier(file, spec)
      if (!target) continue
      const found = resolveExport(target, name, seen)
      if (found) return found
    }

    return null
  }

  /**
   * Every value name `file` publishes, or null when the set cannot be closed.
   *
   * Null propagates: a module whose star re-export points outside the graph
   * publishes an unknown set, and so does every module that stars THAT one. A
   * cycle contributes nothing rather than looping — the names it could add are
   * reached by the other arm of the cycle.
   */
  const exportedNames = (file: string, seen: Set<string>): string[] | null => {
    if (seen.has(file)) return []
    seen.add(file)
    const fi = info(file)
    if (!fi) return null // a module nobody can read publishes an unknown set

    const names = new Set<string>(fi.exportedNames)
    for (const name of fi.exportAliases.keys()) names.add(name)
    if (fi.defaultExport || fi.exportAliases.has('default')) names.add('default')

    for (const spec of fi.starExports) {
      const target = options.resolveSpecifier(file, spec)
      if (!target) return null
      const inner = exportedNames(target, seen)
      if (inner === null) return null
      // `export *` re-exports every NAMED export of the target, never its default.
      for (const name of inner) if (name !== 'default') names.add(name)
    }

    return [...names].sort()
  }

  const resolveLocal = (file: string, name: string, seen: Set<string>): Declaration | null => {
    const fi = info(file)
    if (!fi) return null

    // A local declaration WINS over an import of the same name — which is exactly
    // what allocation.ts's shadowing `requireAuth` did, and exactly what a rule
    // matching on the imported name got wrong.
    const local = fi.locals.get(name)
    if (local) return { file, name, node: local }

    const imported = fi.imports.get(name)
    if (!imported) return null
    if (imported.imported === '*') return null
    const target = options.resolveSpecifier(file, imported.spec)
    if (!target) return null
    return resolveExport(target, imported.imported, seen)
  }

  const graph: ModuleGraph = {
    files: () => [...keySet],
    source,
    sourceFile: (file) => info(file)?.sf,

    bindsAtModuleScope(file, name) {
      const fi = info(file)
      if (!fi) return true // unreadable module: cannot vouch for anything
      return fi.moduleBindings.has(name)
    },

    resolveExportedName(file, name) {
      return resolveExport(file, name, new Set())
    },

    exportedNamesOf(file) {
      return exportedNames(file, new Set())
    },

    resolve(file, name, at) {
      // A binding between `at` and the module top level is a DIFFERENT binding,
      // and the graph has no declaration site for it. Not verified.
      if (at && hasLexicalShadow(at, name)) return null
      return resolveLocal(file, name, new Set())
    },

    resolveMember(file, ns, member, at) {
      if (at && hasLexicalShadow(at, ns)) return null
      const fi = info(file)
      if (!fi) return null
      const imported = fi.imports.get(ns)
      if (!imported || imported.imported !== '*') return null
      const target = options.resolveSpecifier(file, imported.spec)
      if (!target) return null
      return resolveExport(target, member, new Set())
    },

    resolveCallTarget(file, callee) {
      // The callee node carries its own position, so shadowing is always checked
      // here — a caller cannot forget to ask for it.
      if (ts.isIdentifier(callee)) return graph.resolve(file, callee.text, callee)
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
        return graph.resolveMember(file, callee.expression.text, callee.name.text, callee.expression)
      }
      return null
    },

    referrers(declFile, name, prefilter) {
      const found: string[] = []
      for (const file of keySet) {
        if (file === declFile) continue
        const src = source(file)
        if (src === undefined) continue
        if (prefilter && !prefilter(src)) continue
        const fi = info(file)
        if (!fi) continue

        // Every local binding this file could reach the symbol through: a named
        // import (aliased or not), a namespace import, or a re-export.
        const candidates = new Set<string>()
        for (const [local] of fi.imports) candidates.add(local)
        for (const [exported] of fi.exportAliases) candidates.add(exported)

        let hit = false
        for (const local of candidates) {
          const resolved = graph.resolve(file, local) ?? resolveExport(file, local, new Set())
          if (resolved && resolved.file === declFile && resolved.name === name) {
            // The binding must actually be USED, not merely imported — but an
            // unused import is still a reference for the pin's purposes, and
            // treating it as one fails safe.
            hit = true
            break
          }
        }
        if (!hit) {
          // Namespace access: `import * as m from '…'; m.maskSecret(…)`.
          for (const [local, imp] of fi.imports) {
            if (imp.imported !== '*') continue
            const resolved = graph.resolveMember(file, local, name)
            if (resolved && resolved.file === declFile && resolved.name === name) {
              const usesMember = sourceUsesMember(fi.sf, local, name)
              if (usesMember) { hit = true; break }
            }
          }
        }
        if (hit) found.push(file)
      }
      return found.sort()
    },
  }

  return graph
}

function sourceUsesMember(sf: ts.SourceFile, ns: string, member: string): boolean {
  let used = false
  const visit = (n: ts.Node) => {
    if (used) return
    if (
      ts.isPropertyAccessExpression(n)
      && ts.isIdentifier(n.expression)
      && n.expression.text === ns
      && ts.isIdentifier(n.name)
      && n.name.text === member
    ) {
      used = true
      return
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  return used
}

/**
 * A graph over an in-memory set of sources, keyed however the caller likes.
 *
 * This is what lets the DETECTOR's own rules be tested (o3d-hic9): a fixture
 * graph exercises the same resolution the repo graph uses, so "resolves to
 * lib/auth/server.ts:requirePermission" is a claim a fixture can make true or
 * false on purpose.
 */
export function createSourceGraph(sources: Record<string, string>): ModuleGraph {
  const keys = Object.keys(sources)
  const keySet = new Set(keys)

  const resolveSpecifier = (from: string, spec: string): string | null => {
    let base: string
    if (spec.startsWith('@/')) base = spec.slice(2)
    else if (spec.startsWith('.')) {
      base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
    } else return null

    for (const ext of SOURCE_EXTENSIONS) {
      const candidate = base + ext
      if (keySet.has(candidate)) return candidate
    }
    return null
  }

  return createGraph(keys, (file) => sources[file], { resolveSpecifier })
}

const SKIP_DIRS = new Set(['node_modules', '.next', 'generated', '.git'])

/**
 * Every module file under `roots`, keyed by repo-relative POSIX path.
 *
 * Round 8: every extension a module can be written in, not the two the tree
 * happens to use — a guard that resolves through `.ts` and stops at `.mts` is a
 * guard whose coverage is decided by a filename.
 */
export function listSourceFiles(root: string, roots: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as never
    } catch {
      return
    }
    for (const entry of entries as unknown as Array<{ name: string; isDirectory(): boolean }>) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!isModuleFileName(entry.name)) continue
      out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  for (const r of roots) walk(path.join(root, r))
  return out.sort()
}

/** A graph over the real tree. Files are read and parsed lazily, on resolution. */
export function createRepoGraph(root: string, roots: string[]): ModuleGraph {
  const keys = listSourceFiles(root, roots)
  const keySet = new Set(keys)

  const resolveSpecifier = (from: string, spec: string): string | null => {
    let base: string
    if (spec.startsWith('@/')) base = spec.slice(2)
    else if (spec.startsWith('.')) {
      base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
    } else return null

    for (const ext of SOURCE_EXTENSIONS) {
      const candidate = base + ext
      if (keySet.has(candidate)) return candidate
    }
    return null
  }

  return createGraph(keys, (file) => {
    try {
      return readFileSync(path.join(root, file), 'utf8')
    } catch {
      return undefined
    }
  }, { resolveSpecifier })
}
