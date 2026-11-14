import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import ts from 'typescript'

/**
 * A RETURNED FAILURE THAT IS DISCARDED. A call whose return value can carry a failure (an object with `success`, `error`, `errors`, `failed`, `refused`, `abandoned`,
 * `stoppedEarly` or any property named like a failure: the same pattern as the field census) but whose result is thrown away as an expression statement is how
 * the FX refresh ignored a connector push that failed (it returned the error, never threw, and the cron answered 200).
 *
 * The test reads every cron route's module graph (the route and the modules it imports, statically or dynamically, two levels deep) with the TypeScript compiler,
 * finds every expression statement that discards such a result, and requires each callee to be listed below with the reason it is safe. A new discarded failure
 * therefore fails CI until it is folded into the result or justified; a justification whose callee no longer appears is reported stale.
 */

const FAILURE_LIKE = /fail|error|dead|conflict|park|unresolved|reject|quarantin|incomplete|orphan|stuck|blocked|refus|unrecorded|unwritten|lost|missing|abandon|stale|skippedWithError|mismatch|drift|invalid|denied|timeout|unavailable|stoppedEarly|aborted|halted|interrupted|truncated|capped/i

/** callee name -> why discarding its result is safe. */
const JUSTIFIED: Record<string, string> = {
  scheduleXeroAccountingOutbox: 'returns the outbox row it just wrote; `lastError` is the recorded failure column, read by the sweeps over those rows (the write is the durable record)',
  enqueueIntegrationOutbox: 'returns the outbox row it just wrote; `lastError` is the recorded failure column, read by the outbox drains',
  markIntegrationOutboxRetryableFailure: 'the durable write of a failure onto the outbox row (returns the row); the draining sweep counts the failure itself in its own result',
  markIntegrationOutboxPermanentFailure: 'the durable write of a failure onto the outbox row (returns the row); the draining sweep counts the failure itself in its own result',
  markIntegrationOutboxSuccess: 'the durable write of a success onto the outbox row (returns the row, whose `lastError` column is cleared)',
  markSyncLogForFollowUpRetry: 'writes the retry state onto the sync log row (`finalFailure` says it reached the retry cap); the call site counts `result.failed` itself and the row is what the repair sweep reads',
  applyMainSyncFailureRetry: 'writes the retry state onto the sync log row (`finalFailure` says it reached the retry cap); the call site counts `result.failed` itself',
  handBackUnsentTransportRefusal: 'hands a lease back after a transport refusal that sent nothing (`abandoned` says the hand-back did not release a row): the sync log row keeps its state and the sweeps read it; the call sites count the refusal as held',
  uploadBackupArtifactsToTarget: 'its failures THROW (BackupArtifactUploadError) and the backup route catches them into `uploadError`; the success value only carries `orphanCleanupAttempted: false`',
  autoAllocateOrder: 'best-effort allocation after a payment advanced an order: the reallocation sweep re-attempts unallocated orders every run, and its own failures are in that route\'s result',
  runMintsoftProductSyncForProduct: 'the single-product wrapper behind the product screens (not a cron path, reached through the WMS registry import); the verify cron reads its own run results',
  queueRefundStockCorrections: 'in the WooCommerce webhook handler (a delivery, not a cron run; the open obligation is retried by the reconcile cron, which now folds this call\'s `failed` count into its result)',
  syncWcRefund: 'in the WooCommerce refund webhook handler: a delivery answered to the store, retried by the inbox and by the reconcile; not a cron result',
}

function entry(): { program: ts.Program; checker: ts.TypeChecker; options: ts.CompilerOptions; routes: string[] } {
  const configPath = path.resolve('tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath))
  const routes = parsed.fileNames.filter((file) => /app\/api\/cron\/.*route\.ts$/.test(file))
  const program = ts.createProgram(routes, parsed.options)
  return { program, checker: program.getTypeChecker(), options: parsed.options, routes }
}

const isRepoSource = (file: string): boolean => Boolean(file) && !file.includes('node_modules') && !file.includes('/app/generated/') && !file.endsWith('.d.ts')

test('every discarded result that can carry a failure, in the module graph of a cron route, is justified (a returned failure is not a discarded one)', () => {
  const { program, checker, options, routes } = entry()
  const seen = new Map<string, number>()
  const queue: Array<[string, number]> = routes.map((route) => [route, 0])
  while (queue.length > 0) {
    const [file, depth] = queue.shift()!
    if (seen.has(file) && seen.get(file)! <= depth) continue
    seen.set(file, depth)
    if (depth >= 2) continue
    const source = program.getSourceFile(file)
    if (!source) continue
    const visit = (node: ts.Node): void => {
      let specifier: string | null = null
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text
      if (specifier && !specifier.startsWith('node:')) {
        const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName
        if (resolved && isRepoSource(resolved) && !resolved.includes('/tests/')) queue.push([resolved, depth + 1])
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  const failureProperties = (type: ts.Type, depth = 0): string[] => {
    if (depth > 2) return []
    const found: string[] = []
    for (const member of type.isUnion() ? type.types : [type]) {
      if (checker.isArrayType(member)) {
        const element = checker.getTypeArguments(member as ts.TypeReference)[0]
        if (element) found.push(...failureProperties(element, depth + 1))
        continue
      }
      if (!(member.flags & ts.TypeFlags.Object)) continue
      for (const property of member.getProperties()) {
        if (property.name.startsWith('__') || !(FAILURE_LIKE.test(property.name) || property.name === 'success')) continue
        if (isRepoSource(property.declarations?.[0]?.getSourceFile().fileName ?? '')) found.push(property.name)
      }
    }
    return [...new Set(found)]
  }

  const unjustified: string[] = []
  const used = new Set<string>()
  let scanned = 0
  for (const [file] of seen) {
    // User-initiated server actions are not on a cron path; they are reached only through a module import.
    if (file.includes('/app/actions/')) continue
    const source = program.getSourceFile(file)!
    scanned++
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) {
        let expression: ts.Expression = node.expression
        while (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isVoidExpression(expression)) expression = expression.expression
        if (ts.isCallExpression(expression)) {
          const declared = checker.getResolvedSignature(expression)?.declaration?.getSourceFile().fileName ?? ''
          if (isRepoSource(declared)) {
            let type = checker.getTypeAtLocation(expression)
            type = checker.getAwaitedType(type) ?? type
            const properties = failureProperties(type)
            if (properties.length > 0) {
              const callee = ts.isPropertyAccessExpression(expression.expression) ? expression.expression.name.text : expression.expression.getText()
              used.add(callee)
              if (!(callee in JUSTIFIED)) {
                const { line } = source.getLineAndCharacterOfPosition(node.getStart())
                unjustified.push(`${path.relative('.', file)}:${line + 1} ${callee}(...) discards a result carrying ${properties.join(', ')}`)
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.ok(scanned > 100, `the module graph was read (${scanned} files), so the test is not vacuous`)
  assert.deepEqual(unjustified, [], `\nA call's result carries a failure and is thrown away. Fold it into the result (and the mapping), or justify it in JUSTIFIED with the reason:\n${unjustified.join('\n')}`)
  const stale = Object.keys(JUSTIFIED).filter((callee) => !used.has(callee))
  assert.deepEqual(stale, [], `justified callees that no longer discard a failure-carrying result (remove them): ${stale.join(', ')}`)
})
