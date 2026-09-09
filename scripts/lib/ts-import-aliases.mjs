/**
 * RESOLVING THE NAME A CALL ACTUALLY INVOKES — the one copy, shared by every static guard that
 * fences a function off by name (o3d-4gh9, o3d-272i r4).
 *
 * WHY THIS IS A MODULE AND NOT A HELPER INSIDE EACH GUARD. Two guards on this branch have now been
 * written with the same hole and found by the same mutation:
 *
 *   • check-fulfillment-requirement-seam.mjs compared the callee's own identifier against the
 *     fenced names, so `import { expandFulfillmentRequirementsDecimal as probeExpand }` walked
 *     straight past it and the check reported OK over exactly the call it exists to forbid.
 *   • check-wc-sync-row-predicates.mjs then repeated it: its negation prohibition recognised only a
 *     bare call to the original exported name, so an aliased import under `NOT:` was invisible.
 *
 * The second one was written AFTER the first was fixed, in the same branch, by the same author.
 * That is the argument for one implementation rather than a convention: a rule that lives in two
 * places drifts, and the way it drifts is that the newer copy is the older copy's bug. A third
 * guard that fences a function by name imports this and inherits both fixes.
 *
 * WHAT IT DOES NOT DO. It is syntax, not a type checker. It resolves the spellings a developer
 * actually writes — a named import with `as`, a namespace import's property access, and (via
 * {@link addLocalFunctionAliases}) a local name bound to one of those. It cannot follow a function
 * passed as an argument, stored in an object, or chosen by a conditional; each guard states that
 * residual for itself.
 */

import ts from 'typescript'

/**
 * Local name -> IMPORTED name, for every named import in a file.
 *
 * `import { activeRefundParkWhere as parkWhere }` yields `parkWhere -> activeRefundParkWhere`, which
 * is what makes an `as` clause stop being a way to switch a guard off.
 */
export function importAliases(source) {
  const aliases = new Map()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    const bindings = statement.importClause.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        aliases.set(element.name.text, (element.propertyName ?? element.name).text)
      }
    }
  }
  return aliases
}

/**
 * The name a call expression invokes, resolved through any import alias.
 *
 * A property-access callee (`kit.expandFulfillmentRequirementsDecimal(...)`, the namespace-import
 * shape) is read from the PROPERTY, which an `import * as` cannot rename.
 */
export function calleeName(node, aliases) {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return aliases.get(callee.text) ?? callee.text
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text
  return null
}

/**
 * The name an expression DENOTES when it is used as a function value rather than called — the same
 * resolution as {@link calleeName}, one step earlier.
 *
 * `const parkWhere = activeRefundParkWhere` and `const parkWhere = families.activeRefundParkWhere`
 * both denote `activeRefundParkWhere`.
 */
export function referencedName(node, aliases) {
  if (ts.isIdentifier(node)) return aliases.get(node.text) ?? node.text
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return node.name.text
  return null
}

/**
 * Extend an alias map with local names bound to one of `fencedNames` AS A VALUE:
 * `const parkWhere = activeRefundParkWhere` — no call, so nothing a call-site check would see, and
 * `parkWhere()` three lines later reads like an ordinary local helper.
 *
 * Iterated to a fixpoint so a chain (`const a = activeRefundParkWhere; const b = a`) resolves too.
 * The map is mutated and returned, so the result can be handed straight to {@link calleeName}.
 */
export function addLocalFunctionAliases(source, aliases, fencedNames) {
  let changed = true
  while (changed) {
    changed = false
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const denoted = referencedName(node.initializer, aliases)
        if (denoted !== null && fencedNames.has(denoted) && aliases.get(node.name.text) !== denoted) {
          aliases.set(node.name.text, denoted)
          changed = true
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return aliases
}
