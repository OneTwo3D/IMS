import ts from 'typescript'

/**
 * o3d-6t1qh (3) - STRUCTURAL assertions over source, by PARSING it rather than comparing text offsets.
 *
 * An offset comparison ("the call appears after X in the file") is true by position even when the call has
 * been moved inside a branch or behind an early return, which is exactly the regression the ordering tests
 * name. These helpers answer the questions those tests mean: is the call an UNCONDITIONAL top-level
 * statement of the function, does anything that can leave the function early sit before it, and does a
 * given statement (a connector gate) come after it.
 */
export function functionBody(source: string, name: string): { sf: ts.SourceFile; body: ts.Block } {
  const sf = ts.createSourceFile('subject.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let found: ts.Block | null = null
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) { found = node.body; return }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!found) throw new Error(`function ${name} not found`)
  return { sf, body: found }
}

/** Walk a subtree without descending into nested function bodies (their returns/calls are not this function's). */
function walk(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node)
  ts.forEachChild(node, (child) => {
    if (ts.isFunctionLike(child)) return
    walk(child, visitor)
  })
}

export function subtreeSatisfies(node: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  let hit = false
  walk(node, (n) => { if (predicate(n)) hit = true })
  return hit
}

export function isCallTo(node: ts.Node, callee: string): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee
}

/** Index of the first TOP-LEVEL statement of `body` whose subtree satisfies `predicate`, or -1. */
export function topLevelIndex(body: ts.Block, predicate: (node: ts.Node) => boolean): number {
  return body.statements.findIndex((statement) => subtreeSatisfies(statement, predicate))
}

/**
 * Whether `statement` performs the call UNCONDITIONALLY: the statement is an expression/variable statement
 * and the path down to the call crosses only await, parentheses, assignment and declarations - never a
 * branch, a loop, a try, a ternary or a short-circuit.
 */
export function performsUnconditionally(statement: ts.Statement, callee: string): boolean {
  const reach = (node: ts.Node): boolean => {
    if (isCallTo(node, callee)) return true
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) return reach(node.expression)
    if (ts.isExpressionStatement(node)) return reach(node.expression)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return reach(node.right)
    if (ts.isVariableStatement(node)) return reach(node.declarationList)
    if (ts.isVariableDeclarationList(node)) return node.declarations.some(reach)
    if (ts.isVariableDeclaration(node)) return node.initializer ? reach(node.initializer) : false
    return false
  }
  return reach(statement)
}

/** Whether the subtree can leave the function (or the block) early: return, throw. */
export function canExitEarly(node: ts.Node): boolean {
  return subtreeSatisfies(node, (n) => ts.isReturnStatement(n) || ts.isThrowStatement(n))
}
