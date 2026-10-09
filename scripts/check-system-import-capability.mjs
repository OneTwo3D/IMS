#!/usr/bin/env node

/**
 * Static guard: who may touch the system-actor import capability.
 *
 * lib/first-load/apply/system-import-capability.ts holds the symbol that lets the first-load apply runner call the CSV
 * importers with no session and with their outbound effects suppressed. Anything that can import it can load data
 * into the installation without a permission check, so the set of importers is a closed list:
 *
 *   - `mintSystemImportContext` : lib/first-load/apply/** , scripts/first-load-apply.ts and tests.
 *   - `SYSTEM_IMPORT`, `isSystemImportContext`, `withSystemActor`, `withSystemOutcome` and the types :
 *     those, plus the three importer modules that honour the context (they must compare the symbol INLINE, because
 *     the Server Action guard scan only credits a skipped permission check that compares against a module-level
 *     `Symbol()` it can resolve; see tests/security/server-action-guard-scan.ts).
 *   - Everything else : nothing. Type-only imports, namespace imports, re-exports (`export ... from`), dynamic
 *     `import()` and `require()` of the module all count as importing it.
 *
 * It is a census, not a grep for one name: it resolves every import specifier (`@/`, relative and bare repo paths)
 * to a repo path, so an aliased or re-exported binding is still an importer. It prints how many files import the
 * module, and fails if the module is missing or an allowlisted importer no longer imports it (a stale exemption is
 * an invitation).
 *
 * Self-test: tests/scripts/system-import-capability-boundary.test.ts builds fixture trees and runs this script on them.
 *
 * Run via `npm run check:system-import-capability`; invoked by `npm run check:all`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')

const APPLY_TREE = 'lib/first-load/apply'
export const CAPABILITY_MODULE = `${APPLY_TREE}/system-import-capability`

/** Free to import anything from the module. */
export const RUNNER_PREFIXES = ['lib/first-load/apply/', 'tests/']
export const RUNNER_FILES = ['scripts/first-load-apply.ts']

/** The importer modules that honour the context: named bindings from CHECKER_NAMES (and types) only. */
export const IMPORTER_MODULES = [
  'app/actions/import.ts',
  'app/actions/suppliers.ts',
  'app/actions/purchase-orders.ts',
]
export const CHECKER_NAMES = ['SYSTEM_IMPORT', 'isSystemImportContext', 'withSystemActor', 'withSystemOutcome']

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const SKIPPED_DIRECTORIES = new Set(['.git', '.next', 'node_modules', 'coverage', 'dist', 'build', 'out', 'playwright-report', 'test-results'])

function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(name)) continue
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) {
      if (relative(root, full).split(sep).join('/') === 'app/generated') continue
      walk(root, full, out)
    } else if (SCANNED_EXTENSIONS.has(name.slice(name.lastIndexOf('.')))) {
      out.push(full)
    }
  }
  return out
}

/** A module specifier as a repo-relative path without extension, or null when it points outside the repo or at a package. */
function resolveSpecifier(fromFile, specifier) {
  let target
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(fromFile), specifier))
  else target = specifier
  return target.replace(/\.(?:[cm]?[jt]sx?)$/, '')
}

/**
 * Every way `file` pulls in the capability module: [{ kind, names, typeOnly, line }].
 * `names` is the list of IMPORTED names (the right-hand side of `as`), or ['*'] when the whole module is taken.
 */
function importsOf(source, relFile) {
  const found = []
  const sf = ts.createSourceFile(relFile, source, ts.ScriptTarget.Latest, true)
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  // The whole apply tree, not just the one file: a barrel (lib/first-load/apply/index.ts) that re-exports the symbol would
  // otherwise let a file reach it without ever naming the module.
  const isCapability = (specNode) => {
    if (!ts.isStringLiteralLike(specNode)) return false
    const resolved = resolveSpecifier(relFile, specNode.text)
    return resolved === APPLY_TREE || resolved.startsWith(`${APPLY_TREE}/`)
  }
  const resolvedOf = (specNode) => resolveSpecifier(relFile, specNode.text)

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && isCapability(node.moduleSpecifier)) {
      const clause = node.importClause
      const names = []
      let typeOnly = Boolean(clause?.isTypeOnly)
      if (!clause) names.push('*') // side-effect import
      else {
        if (clause.name) names.push('default')
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) names.push('*')
        else if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) names.push(el.isTypeOnly || typeOnly ? `type:${(el.propertyName ?? el.name).text}` : (el.propertyName ?? el.name).text)
        }
      }
      found.push({ kind: 'import', names, line: lineOf(node), resolved: resolvedOf(node.moduleSpecifier) })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && isCapability(node.moduleSpecifier)) {
      found.push({ kind: 're-export', names: ['*'], line: lineOf(node), resolved: resolvedOf(node.moduleSpecifier) })
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const arg = node.arguments[0]
      if (arg && isCapability(arg) && (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))) {
        found.push({ kind: callee.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic import' : 'require', names: ['*'], line: lineOf(node), resolved: resolvedOf(arg) })
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && isCapability(node.moduleReference.expression)) {
      found.push({ kind: 'import =', names: ['*'], line: lineOf(node), resolved: resolvedOf(node.moduleReference.expression) })
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isCapability(node.argument.literal)) {
      found.push({ kind: 'import type()', names: ['*'], line: lineOf(node), resolved: resolvedOf(node.argument.literal) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

export function runCensus({ root = process.cwd() } = {}) {
  const violations = []
  const importers = []
  const capabilityPath = join(root, `${CAPABILITY_MODULE}.ts`)
  let capabilityExists = true
  try { statSync(capabilityPath) } catch { capabilityExists = false }
  if (!capabilityExists) violations.push(`${CAPABILITY_MODULE}.ts: the capability module does not exist, so this census would pass over nothing`)

  for (const full of walk(root)) {
    const rel = relative(root, full).split(sep).join('/')
    const source = readFileSync(full, 'utf8')
    if (!source.includes('apply') && !source.includes('system-import-capability')) continue // cheap pre-filter on the names; the AST decides
    const uses = importsOf(source, rel)
    if (uses.length === 0) continue
    importers.push(rel)

    const inRunner = RUNNER_FILES.includes(rel) || RUNNER_PREFIXES.some((prefix) => rel.startsWith(prefix))
    if (inRunner) continue

    if (IMPORTER_MODULES.includes(rel)) {
      for (const use of uses) {
        const bad = use.kind !== 'import' || use.resolved !== CAPABILITY_MODULE ? [use.kind === 'import' ? use.resolved : use.kind] : use.names.filter((name) => !name.startsWith('type:') && !CHECKER_NAMES.includes(name))
        if (bad.length > 0) violations.push(`${rel}:${use.line}: an importer module may take only ${CHECKER_NAMES.join(', ')} and types from the capability module, not ${bad.join(', ')}`)
      }
      continue
    }
    for (const use of uses) {
      violations.push(`${rel}:${use.line}: ${use.kind} of the system-import capability (${use.names.join(', ')}) is not allowed here; only lib/first-load/apply/**, scripts/first-load-apply.ts, tests and the three importer modules may touch it`)
    }
  }

  // A stale exemption is an invitation: every allowlisted importer module must really import the module.
  for (const importer of IMPORTER_MODULES) {
    if (!importers.includes(importer)) violations.push(`${importer}: listed as an importer but does not import the capability module (stale allowlist entry)`)
  }
  return { violations: violations.sort(), importers: importers.sort() }
}

if (process.argv[1] && process.argv[1].endsWith('check-system-import-capability.mjs')) {
  const { violations, importers } = runCensus()
  console.log(`system-import capability census: ${importers.length} file(s) import the capability module`)
  if (violations.length > 0) {
    console.error('System-import capability boundary violation:\n')
    for (const v of violations) console.error(`  ${v}`)
    process.exit(1)
  }
  console.log('System-import capability check passed.')
}
