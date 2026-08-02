#!/usr/bin/env node

/**
 * Static guard: no Server Action may accept a SERIALIZABLE authorization
 * bypass (o3d-43oz).
 *
 * A `'use server'` directive — module-wide, or on an individual function —
 * makes the affected exports directly POST-callable, and every argument
 * crosses the RPC boundary. So a plain option like
 *
 *     options?: { skipPermissionCheck?: boolean }
 *
 * is something any client can simply send. `applySalesOrderStatusTransition`
 * had exactly that: sending it suppressed `requirePermission('sales.process')`
 * outright, after which a caller with no permission could drive any
 * state-machine-legal transition — including CANCELLED from
 * PROCESSING/ALLOCATED/PICKING/PACKING, which releases reservations and
 * deletes pending shipments. The state machine constrains the SHAPE of a
 * transition; it is not authorization.
 *
 * The supported pattern is an unforgeable capability: a `symbol`, which the
 * Server Action boundary cannot transport from a client, so it can only be
 * supplied by server-side code that imports it. See
 * lib/sales/status-transition-bypass.ts.
 *
 * Uses a full `ts.Program` and the TypeChecker, not the syntax tree alone.
 * A syntax-only version could only resolve type references declared in the
 * SAME file, so an imported `TransitionOptions`, a `Pick`/`Omit`, an
 * instantiated generic, or a type inferred from a default value all slipped
 * through silently — each of which can recreate the original bypass while CI
 * reports success. The checker resolves all of them to their effective
 * properties.
 *
 * Scope: for a module-wide directive, only EXPORTED functions are inspected —
 * a private helper is not remotely callable, and failing CI on one would just
 * teach people to add waivers. A function carrying its own `use server`
 * directive is inspected regardless of export, because that directive is what
 * exposes it.
 *
 * Behaviour flags (`force`, `allowCache`, `skipLog`, …) are deliberately not
 * matched; they do not gate a permission check.
 *
 * Waiver: `// server-action-auth-bypass-ok: <ticket>: <reason>` on the
 * property's line or the line above.
 *
 * Fixtures live in tests/fixtures/server-action-auth-bypass/ and are exercised
 * by tests/server-action-auth-bypass-guard.test.ts.
 *
 * Run via `npm run check:server-action-auth-bypass`; invoked by
 * `npm run check:all`.
 */

import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')

const DEFAULT_SCAN_ROOTS = ['app', 'lib', 'components']

/**
 * Property names that gate AUTHORIZATION rather than behaviour.
 * Matched whole and case-insensitively.
 */
const AUTH_BYPASS_NAME = /^(skipPermissionChecks?|skipPermissions?|skipAuthz?|skipAuthorization|skipAuthentication|bypassPermissions?|bypassAuthz?|bypassAuthorization|allowUnauthenticated|allowAnonymous|asSystem|asAdmin|isInternal|internalCall|trusted|isTrusted)$/i

const WAIVER = /server-action-auth-bypass-ok:/

/** A real `'use server'` prologue entry — not a string that merely says so. */
function hasUseServerDirective(statements) {
  for (const st of statements) {
    if (!ts.isExpressionStatement(st)) break // the prologue ends here
    const e = st.expression
    if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) break
    if (e.text === 'use server') return true
  }
  return false
}

/** Can a client actually send a value of this type? A `symbol` cannot. */
function isSerializableType(checker, type) {
  const parts = type.isUnion() ? type.types : [type]
  return parts.some((t) => {
    // `undefined`/`null` members of an optional property say nothing either way.
    if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) return false
    if (t.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) return false
    return Boolean(t.flags & (
      ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLike | ts.TypeFlags.BooleanLiteral
      | ts.TypeFlags.String | ts.TypeFlags.StringLike | ts.TypeFlags.StringLiteral
      | ts.TypeFlags.Number | ts.TypeFlags.NumberLike | ts.TypeFlags.NumberLiteral
      | ts.TypeFlags.Any | ts.TypeFlags.Unknown
    ))
  })
}



export function runGuard({ tsconfig = 'tsconfig.json', root = process.cwd(), scanRoots = DEFAULT_SCAN_ROOTS } = {}) {
  const configPath = join(root, tsconfig)
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    root,
  )
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
  const checker = program.getTypeChecker()

  const prefixes = scanRoots.map((r) => join(root, r) + sep)
  const violations = []

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    if (!prefixes.some((p) => sf.fileName.startsWith(p))) continue
    const source = sf.getFullText()
    if (!source.includes('use server')) continue

    const moduleWide = hasUseServerDirective(sf.statements)
    const lines = source.split('\n')

    const report = (node, label) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      const text = lines[line] ?? ''
      if (WAIVER.test(text) || (line > 0 && WAIVER.test(lines[line - 1]))) return
      violations.push(`${relative(root, sf.fileName)}:${line + 1}: ${label}`)
    }

    /**
     * Does the function owning this parameter read a bypass-named key off it?
     * Covers both `opts.skipAuth` and `opts['skipAuth']`.
     */
    const readsBypassKey = (paramNode) => {
      if (!paramNode || !ts.isParameter(paramNode)) return false
      const name = ts.isIdentifier(paramNode.name) ? paramNode.name.text : null
      if (!name) return false
      const fn = paramNode.parent
      if (!fn || !fn.body) return false
      let found = false
      const scan = (n) => {
        if (found) return
        if (ts.isPropertyAccessExpression(n)
            && ts.isIdentifier(n.expression) && n.expression.text === name
            && AUTH_BYPASS_NAME.test(n.name.text)) { found = true; return }
        if (ts.isElementAccessExpression(n)
            && ts.isIdentifier(n.expression) && n.expression.text === name
            && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression)
            && AUTH_BYPASS_NAME.test(n.argumentExpression.text)) { found = true; return }
        ts.forEachChild(n, scan)
      }
      scan(fn.body)
      return found
    }

    /** Inspect one resolved parameter type for a forgeable bypass. */
    const inspectParamType = (type, at) => {
      if (!type) return
        // An OPTIONAL parameter is `T | undefined`, and getPropertiesOfType on
        // a union returns only the properties common to every member — so
        // `undefined` erases them all and the guard silently sees nothing.
        // Strip nullish members and inspect each remaining constituent.
      const constituents = (type.isUnion() ? type.types : [type])
        .filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)))
      for (const constituent of constituents) {
        // A higher-order wrapper like `(...a: A) => Promise<R>` presents ONE
        // rest parameter whose type is the tuple of the real parameters, so
        // the actual options object is an element of it, not a property.
        if (checker.isTupleType?.(constituent)) {
          for (const el of checker.getTypeArguments(constituent)) inspectParamType(el, at)
          continue
        }
        for (const prop of checker.getPropertiesOfType(constituent)) {
          if (!AUTH_BYPASS_NAME.test(prop.getName())) continue
          const decl = prop.valueDeclaration ?? prop.declarations?.[0]
          let propType
          try { propType = checker.getTypeOfSymbolAtLocation(prop, decl ?? at) } catch { continue }
          if (!propType || !isSerializableType(checker, propType)) continue
          // Report at the declaration when it is in this file, so the waiver
          // sits next to the offending property; otherwise at the parameter,
          // which is the thing this file controls.
          const where = decl && decl.getSourceFile() === sf ? decl : at
          report(where, `serializable auth bypass \`${prop.getName()}\``)
        }
        // An index signature erases the NAMED properties, so
        // `Record<string, boolean>` would otherwise pass silently even though
        // `options.skipPermissionCheck` is a valid, client-sendable read.
        //
        // But flagging EVERY such bag is pure noise — `Record<string, string>`
        // settings maps are ordinary and legitimate. So only flag when the
        // function actually READS a bypass-named key off that parameter.
        const idx = checker.getIndexInfoOfType?.(constituent, ts.IndexKind.String)
        if (idx?.type && isSerializableType(checker, idx.type) && readsBypassKey(at)) {
          report(at, 'auth-bypass key read from an index-signature options bag '
            + '— a client can send it under any name')
        }
      }
    }

    /** Every parameter of every call signature of a resolved function type. */
    const inspectSignatures = (type, at) => {
      if (!type) return
      for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
        for (const paramSym of sig.getParameters()) {
          const pdecl = paramSym.valueDeclaration ?? paramSym.declarations?.[0]
          let ptype
          try { ptype = checker.getTypeOfSymbolAtLocation(paramSym, pdecl ?? at) } catch { continue }
          const where = pdecl && pdecl.getSourceFile() === sf ? pdecl : at
          inspectParamType(ptype, where)
        }
      }
    }

    /** Module-wide: only exported functions are reachable over RPC. */
    if (moduleWide) {
      const moduleSymbol = checker.getSymbolAtLocation(sf)
      const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []
      for (const ex of exports) {
        let target = ex
        try {
          if (ex.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(ex)
        } catch { /* unresolvable re-export; fall back to the alias itself */ }
        const at = target.valueDeclaration ?? target.declarations?.[0] ?? ex.declarations?.[0]
        if (!at) continue
        // By TYPE, not by syntax. Next.js accepts an action produced by a
        // higher-order function — `export const a = withAudit(async (o) => …)`
        // — and a declaration-shape check skips those entirely, which is a
        // realistic route straight back to the original vulnerability.
        let type
        try { type = checker.getTypeOfSymbolAtLocation(target, at) } catch { continue }
        inspectSignatures(type, at)
      }
    }

    /** A per-function directive exposes that function whether exported or not. */
    const visit = (node) => {
      const isFn = ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
      if (isFn && node.body && ts.isBlock(node.body) && hasUseServerDirective(node.body.statements)) {
        for (const p of node.parameters) {
          let ptype
          try { ptype = checker.getTypeAtLocation(p) } catch { continue }
          inspectParamType(ptype, p)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }

  return [...new Set(violations)].sort()
}

// Run as a script (not when imported by the fixture test).
if (process.argv[1] && process.argv[1].endsWith('check-server-action-auth-bypass.mjs')) {
  const violations = runGuard()
  if (violations.length > 0) {
    console.error(
      'Server Action authorization-bypass violation: a serializable option that '
      + 'gates a permission check is directly POST-callable by any client.\n'
      + 'Use an unforgeable capability instead — a `symbol` cannot cross the '
      + 'Server Action boundary. See lib/sales/status-transition-bypass.ts and o3d-43oz.\n'
      + 'If this is genuinely not an auth gate, add a waiver:\n'
      + '// server-action-auth-bypass-ok: <ticket>: <reason>\n',
    )
    for (const v of violations) console.error(`  ${v}`)
    process.exit(1)
  }
  console.log('Server Action auth-bypass check passed.')
}

export { readFileSync }
