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
   */
  resolve(file: string, name: string): Declaration | null
  /** The declaration `<ns>.<member>` refers to, when `ns` is a namespace import. */
  resolveMember(file: string, ns: string, member: string): Declaration | null
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
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = node.initializer
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body
  }
  return undefined
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
  /** names this module exports from its own declarations */
  exportedNames: Set<string>
  /** exported name -> `export { x as y }` / `export { x } from '…'` */
  exportAliases: Map<string, ExportBinding>
  /** `export * from '…'` specifiers */
  starExports: string[]
}

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

function buildFileInfo(file: string, source: string): FileInfo {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const info: FileInfo = {
    sf,
    imports: new Map(),
    locals: new Map(),
    exportedNames: new Set(),
    exportAliases: new Map(),
    starExports: [],
  }

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
        const original = (el.propertyName ?? el.name).text
        if (spec) info.exportAliases.set(el.name.text, { spec, imported: original })
        else info.exportAliases.set(el.name.text, { local: original })
      }
      return
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      info.locals.set(node.name.text, node)
      if (isExported(node)) info.exportedNames.add(node.name.text)
      return
    }

    if (ts.isClassDeclaration(node) && node.name) {
      info.locals.set(node.name.text, node)
      if (isExported(node)) info.exportedNames.add(node.name.text)
      return
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        info.locals.set(decl.name.text, decl)
        if (isExported(node)) info.exportedNames.add(decl.name.text)
      }
    }
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

    resolve(file, name) {
      return resolveLocal(file, name, new Set())
    },

    resolveMember(file, ns, member) {
      const fi = info(file)
      if (!fi) return null
      const imported = fi.imports.get(ns)
      if (!imported || imported.imported !== '*') return null
      const target = options.resolveSpecifier(file, imported.spec)
      if (!target) return null
      return resolveExport(target, member, new Set())
    },

    resolveCallTarget(file, callee) {
      if (ts.isIdentifier(callee)) return graph.resolve(file, callee.text)
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
        return graph.resolveMember(file, callee.expression.text, callee.name.text)
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

/** Every .ts/.tsx under `roots`, keyed by repo-relative POSIX path. */
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
      if (!/\.tsx?$/.test(entry.name)) continue
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
