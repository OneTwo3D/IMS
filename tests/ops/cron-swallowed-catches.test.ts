import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import ts from 'typescript'

/**
 * A CATCH THAT SWALLOWS A FAILURE. The cron routes answer 500 only for a failure that reaches the result; a catch clause that logs and carries on (the withdrawal
 * fence check and create claim of the WMS order push, the FX order retry) makes a failed run answer 200. This reads every cron route's module graph (the route and the
 * modules it imports, statically or dynamically, two levels deep; user-initiated server actions excluded) with the TypeScript compiler and flags every catch clause whose
 * body neither rethrows, returns, assigns or counts into a failure-like target (an assignment, an increment, a push, a property named like a failure) nor calls a
 * failure-named recorder (console and activity-log calls do not count: logging is not reporting). Each flagged function must be listed below with its count and the
 * reason it is safe; a new swallowing catch, or a count that changed, fails CI until it is folded into the result or justified, and a stale entry is reported.
 *
 * Limits: catch clauses only (promise `.catch(...)` callbacks are not read), module-level reachability to two import levels, and a name heuristic for "failure-like".
 */

const FAILURE_LIKE = /fail|error|dead|conflict|park|unresolved|reject|quarantin|incomplete|orphan|stuck|blocked|refus|unrecorded|unwritten|lost|missing|abandon|stale|skippedWithError|mismatch|drift|invalid|denied|timeout|unavailable|stoppedEarly|aborted|halted|interrupted|truncated|capped|held|skipped/i

/** "<file>::<innermost named function>" -> how many flagged catch clauses it holds and why each is safe. */
const JUSTIFIED: Record<string, { count: number; reason: string }> = {
  "lib/connectors/woocommerce/sync/order-import.ts::importWcOrderOnce": { count: 1, reason: "the park of the invoice whose enqueue failed: its failure is carried (`held` stays false, which stamps SALES_INVOICE_QUEUE_FAILED_NOT_HELD into the failure thrown next, and a redelivery then fails until an invoice stands for the order)" },
  "lib/connectors/mintsoft/sync/stock-sync.ts::enqueueAlignmentStockSync": { count: 1, reason: "the WARNING activity write after a failed stock enqueue: the enqueue failure itself is counted (`stockEnqueueFailures`), this only logs it" },
  "lib/accounting.ts::logUnknownAccountingConnector": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/cron-auth.ts::scheduleCronAuthRejectedLog": { count: 2, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/domain/wms/mutation-audit.ts::recordWmsMutationEvent": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/domain/wms/mutation-audit.ts::recordWmsMutationEvents": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/xero/auth.ts::readStoredToken": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/xero/auth.ts::logTenantRefusal": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/xero/auth.ts::warnNameOnlyGuard": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/xero/auth.ts::storedTenantAllowed": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/xero/auth.ts::logStaleRefreshDiscarded": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/xero/auth.ts::exchangeCodeForTokens": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/accounting-settlement-probe.ts::reportLostMoneyPostExclusion": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/woocommerce/sync/invoice-note.ts::recordNoteWritten": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/woocommerce/sync/refund-sync.ts::logIncompleteRefundRead": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/domain/sales/refund-reservation-release-outbox.ts::processOneRefundReservationReleaseJob": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/domain/wms/order-push-sweep.ts::audit": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/cost-layers.ts::refuseJournaledShipmentRevaluation": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/woocommerce/sync/order-import.ts::recordRepopulationRefused": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/woocommerce/sync/order-import.ts::noteWcOrderAdmissionRefusal": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/ops/cron-run.ts::safeWriteCronRunLog": { count: 1, reason: "a failed cron run-log write is logged; the run's class and the HTTP status come from the result, not from the log write" },
  "app/api/cron/delivery-status/route.ts::GET": { count: 1, reason: "the read-sync scheduler coverage guard started in the background is its own monitor and is isolated by design (its failures show in its own notifications)" },
  "lib/connectors/xero/payment-poller.ts::processDeltaChunk": { count: 1, reason: "best-effort payment auto-allocation after a payment advanced an order: the reallocation sweep re-attempts unallocated orders every run and reports in its own result" },
  "lib/connectors/xero/payment-reconcile.ts::markPaid": { count: 1, reason: "best-effort payment auto-allocation after a payment advanced an order: the reallocation sweep re-attempts unallocated orders every run and reports in its own result" },
  "lib/connectors/xero/payment-poller.ts::pollXeroPaymentsLocked": { count: 1, reason: "the unreadable-paid-date retry: a second look at documents the first pass already reported in `errors`; counting it again would double-count" },
  "lib/domain/wms/dispatch-sweep.ts::formatCursorInTimeZone": { count: 1, reason: "an unknown IANA zone falls back to UTC (a defined conservative value)" },
  "lib/connectors/woocommerce/sync/order-import.ts::recordWcPaidTransition": { count: 1, reason: "a total that cannot be read is carried as null and then judged as a mismatch (fail closed)" },
  "lib/connectors/woocommerce/sync/order-import.ts::resolveDirectCreateShortfall": { count: 1, reason: "the direct-create coverage check: its durable marker stays and the marker sweep re-resolves it (listed as best-effort in the PR)" },
  "lib/connectors/woocommerce/sync/order-import.ts::retryPendingWcOrdersWaitingForFx": { count: 1, reason: "a missed stamp only delays the rotation of the pending rows" },
  "lib/domain/invoice-documents/sweep.ts::refreshStaleInvoiceDocument": { count: 1, reason: "a refresh that failed serves the stored document, which is still valid" },
  "lib/connectors/mintsoft/sync/bundle-sync.ts::syncBundleInternal": { count: 1, reason: "carried: the lookup failure becomes `reconciliation.kind = lookup-failed`, which is written into the maybe-sent error text of the result" },
  "lib/connectors/mintsoft/sync/returns-sync.ts::writeReturnsErrorLog": { count: 1, reason: "fail closed: an erasure state that cannot be determined is treated as erased (`determined = false`), so nothing is written" },
  "lib/security/outbound-write-grant.ts::explicitMintsoftLoginUsername": { count: 1, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/security/outbound-write-grant.ts::explicitMintsoftClientIds": { count: 1, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/connectors/woocommerce/sync/coupon-classification.ts::readStoreCreditContributionRecord": { count: 1, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/connectors/woocommerce/sync/anonymisation-sweep.ts::loadState": { count: 1, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/connectors/woocommerce/sync/eu-vat-invoice-treatment.ts::readRegimeInputOnce": { count: 2, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/connectors/woocommerce/sync/eu-vat-facts.ts::buildEuVatRegimeInputFromSettings": { count: 1, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/ops/readiness-gate-collect.ts::readNewestRehearsal": { count: 1, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/ops/readiness-gate-collect.ts::readApplyReports": { count: 1, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/reconciliation-pack/schedule.ts::classifyChildEnd": { count: 1, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/ops/read-sync-scheduler-guard.ts::schedulerObserverId": { count: 1, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/connectors/mintsoft/producer-seam.ts::mintsoftProducerSeam": { count: 1, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/connectors/woocommerce/producer-seam.ts::wooProducerSeam": { count: 1, reason: "a parse or read fallback to a defined conservative value (null, unknown, invalid, unparseable) that is judged downstream, fail closed" },
  "lib/ops/readiness-gate-collect.ts::collectGateResults": { count: 3, reason: "carried: the read failure is assigned to a variable (unreadable, untrusted, null) that the check evaluates as a failing item" },
  "lib/ops/writers-check.ts::readWritersCheckInputs": { count: 3, reason: "carried: the read failure is assigned to a variable (unreadable, untrusted, null) that the check evaluates as a failing item" },
  "lib/ops/readiness-gate-collect.ts::startNpmScript": { count: 1, reason: "a kill of a process group that already exited" },
  "lib/ops/reconciliation-pack-schedule.ts::finish": { count: 1, reason: "carried: `recorded = false` is part of the result (the mapping fails an unrecorded run), and a result that never came is a start that failed" },
  "lib/ops/reconciliation-pack-schedule.ts::runScheduledReconciliationPack": { count: 1, reason: "carried: `recorded = false` is part of the result (the mapping fails an unrecorded run), and a result that never came is a start that failed" },
  "lib/backup-remote.ts::uploadBackupArtifactsToTarget": { count: 1, reason: "cleanup of an orphaned upload: `orphanCleanupSucceeded: false` is carried in the BackupArtifactUploadError that is thrown next" },
  "lib/backup-remote.ts::uploadToSftp": { count: 1, reason: "the directory may already exist" },
  "lib/email-outbox.ts::proveDelegateIsInMemory": { count: 1, reason: "a refusal may already be on its way out; masking it would report the symptom instead of the finding" },
  "lib/domain/wms/order-push-sweep.ts::runWmsOrderPushSweepCore": { count: 1, reason: "the restore of a create claim stamp after a payload rebuild refusal: the stamp lapses and the order is re-selected; the order is also reported by `validationFailed`" },
  "lib/domain/accounting/sync-log-row.ts::createAccountingSyncLogRow": { count: 1, reason: "best effort: the refusal (a throw) follows; the inbox row is only the operator's trail" },
  "lib/domain/accounting/posting-refusal-inbox.ts::guarded": { count: 1, reason: "the refusal itself is already decided and thrown or counted; the inbox bookkeeping failure is reported by activity log or a savepoint-contained counter" },
  "lib/domain/accounting/posting-refusal-inbox.ts::clearAccountingPostingRefusal": { count: 1, reason: "the refusal itself is already decided and thrown or counted; the inbox bookkeeping failure is reported by activity log or a savepoint-contained counter" },
  "lib/db/pinned-advisory-lock.ts::release": { count: 1, reason: "lock or connection cleanup: a failed unlock destroys the connection (which releases every session lock), or the socket is already gone" },
  "lib/db/database-url-schema.mjs::destroyClientSocket": { count: 2, reason: "lock or connection cleanup: a failed unlock destroys the connection (which releases every session lock), or the socket is already gone" },
  "lib/connectors/xero/payment-write-lock.ts::withPaymentWriteLockOrSkip": { count: 1, reason: "lock or connection cleanup: a failed unlock destroys the connection (which releases every session lock), or the socket is already gone" },
  "lib/connectors/woocommerce/sync/first-import-lock.ts::acquireWcFirstImportLock": { count: 1, reason: "lock or connection cleanup: a failed unlock destroys the connection (which releases every session lock), or the socket is already gone" },
  "lib/connectors/woocommerce/sync/erasure-sweep-lease.ts::tryAcquireWcErasureSweepLease": { count: 1, reason: "lock or connection cleanup: a failed unlock destroys the connection (which releases every session lock), or the socket is already gone" },
  "lib/db/post-remote-persist.ts::writeStderrLine": { count: 1, reason: "last-resort reporter fallback" },
  "lib/db/post-remote-persist.ts::reportUnrecordedRemoteWrite": { count: 2, reason: "the last-resort reporter must never throw: it falls back, and there is nothing left to try" },
  "lib/domain/accounting/back-reference-sweep.ts::stampDeferral": { count: 1, reason: "the row can legitimately be gone (retention, a connector switch): nothing to record and nothing to retry" },
  "lib/domain/accounting/back-reference-sweep.ts::warnAndDefer": { count: 1, reason: "the row can legitimately be gone (retention, a connector switch): nothing to record and nothing to retry" },
  "lib/domain/accounting/back-reference-sweep.ts::repairAccountingBackReferences": { count: 3, reason: "the rotating cursor could not be read or saved (the sweep restarts from the oldest row) and a follow-up enqueue deferred to the next sweep with an activity-log entry; the row stays PENDING" },
  "lib/connectors/woocommerce/sync/invoice-note.ts::pushInvoiceNoteToWc": { count: 2, reason: "an admin-only storefront note: best effort by design, at most once per ledger invoice id" },
  "lib/domain/accounting/invoice-payment-enqueue.ts::registerInvoicePaymentWithLedger": { count: 1, reason: "the callers prove the obligation is on record afterwards (`registerReceiptAndProveObligation` throws ReceiptRegistrationNotRecorded, which keeps the order in the pending-FX retry queue and is counted by the fx-rates and wc-reconcile mappings); this entry is also written as a durable ERROR activity (`invoice_payment_not_queued`)" },
  "lib/domain/incumbent-evidence/record.ts::recordWcIncumbentEvidence": { count: 1, reason: "never throws into the import; the unrecorded evidence is reported as `unrecorded: true`" },
  "lib/domain/incumbent-evidence/record.ts::startWcIncumbentEvidence": { count: 1, reason: "never throws into the import" },
  "lib/domain/inventory/invariants.ts::collectDisproportionateCommittedKitFindings": { count: 1, reason: "reported as an invariant finding, not judged against the current graph" },
  "lib/domain/wms/dispatch-sweep.ts::settleOrderLevelVerify": { count: 1, reason: "carried: an unverifiable storefront order becomes `verified: false`, which holds the link" },
  "lib/domain/wms/dispatch-sweep.ts::reconcileSplitOrder": { count: 1, reason: "carried: an unverifiable pre-cutover part becomes `verified: false`, which leaves the order pending" },
  "lib/domain/wms/dispatch-sweep.ts::processOne": { count: 1, reason: "a withdrawal park that did not commit leaves the link a candidate again and HOLDS the read watermark (read-sync liveness watches it)" },
  "lib/domain/wms/dispatch-sweep.ts::runWmsDispatchSweepCore": { count: 6, reason: "bookkeeping around a decision the sweep already made (the split probe stops further probes and holds coverage; the recency stamp, the drift report and the unresolved streak are advisory; a failed quarantine leaves the link counted unresolved; a control probe that failed is treated as no evidence); each either holds the read watermark or leaves the link unresolved and re-examined" },
  "lib/domain/wms/dispatch-sweep.ts::parkWithdrawn": { count: 1, reason: "alerting or audit after the park or quarantine already committed; the link state is the durable record" },
  "lib/domain/wms/dispatch-sweep.ts::quarantineUnresolved": { count: 1, reason: "alerting or audit after the park or quarantine already committed; the link state is the durable record" },
  "lib/domain/wms/dispatch-sweep.ts::probeControlLinks": { count: 1, reason: "counted as probed-but-unresolved, which is the evidence wanted" },
  "lib/fulfillment/external-fulfillment.ts::applyExternalFulfillmentUpdate": { count: 1, reason: "a not-ready despatch notice that could not be written (`noticesPersisted` stays false)" },
  "lib/fulfillment/pre-fulfilment-reallocation.ts::deferFailedMarker": { count: 1, reason: "the failed marker stays pending and the marker sweep retries it next run" },
  "lib/connectors/woocommerce/webhooks.ts::logInitialImportPendingSkip": { count: 1, reason: "a webhook delivery or its inbox bookkeeping, not a cron run: the sender retries and the reconcile cron repairs; the failure is logged" },
  "lib/connectors/woocommerce/webhooks.ts::logWcOrderWebhookNotAdmitted": { count: 1, reason: "a webhook delivery or its inbox bookkeeping, not a cron run: the sender retries and the reconcile cron repairs; the failure is logged" },
  "lib/connectors/woocommerce/webhooks.ts::handleOrderWebhook": { count: 1, reason: "a webhook delivery or its inbox bookkeeping, not a cron run: the sender retries and the reconcile cron repairs; the failure is logged" },
  "lib/connectors/woocommerce/webhooks.ts::refuseNonBoundStoreDelivery": { count: 2, reason: "a webhook delivery or its inbox bookkeeping, not a cron run: the sender retries and the reconcile cron repairs; the failure is logged" },
  "lib/jobs/shopping/process-shopping-webhook-events.ts::staleClaim": { count: 1, reason: "a webhook delivery or its inbox bookkeeping, not a cron run: the sender retries and the reconcile cron repairs; the failure is logged" },
  "lib/accounting-fx-revaluation.ts::runArApFxRevaluation": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
  "lib/connectors/xero/tax-rate-drift-sweeper.ts::runXeroTaxRateDriftSweep": { count: 1, reason: "best-effort logging or notice: a warning or audit write that failed must not decide the run; the state it describes is recorded elsewhere" },
}

const isRepoSource = (file: string): boolean => Boolean(file) && !file.includes('node_modules') && !file.includes('/app/generated/') && !file.endsWith('.d.ts')

test('every catch clause in the module graph of a cron route reports its failure or is justified (a swallowed failure answers 200)', () => {
  const configPath = path.resolve('tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath))
  const routes = parsed.fileNames.filter((file) => /app\/api\/cron\/.*route\.ts$/.test(file))
  const program = ts.createProgram(routes, parsed.options)
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
        const resolved = ts.resolveModuleName(specifier, file, parsed.options, ts.sys).resolvedModule?.resolvedFileName
        if (resolved && isRepoSource(resolved) && !resolved.includes('/tests/')) queue.push([resolved, depth + 1])
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  const flagged = new Map<string, number>()
  let catches = 0
  let scanned = 0
  for (const [file] of seen) {
    if (file.includes('/app/actions/')) continue
    const source = program.getSourceFile(file)!
    scanned++
    const text = (node: ts.Node): string => node.getText(source)
    const reports = (body: ts.Node): boolean => {
      let found = false
      const visit = (node: ts.Node): void => {
        if (found) return
        if (ts.isThrowStatement(node) || ts.isReturnStatement(node)) { found = true; return }
        if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
          if (FAILURE_LIKE.test(text(node.left))) { found = true; return }
          let hit = false
          const inner = (child: ts.Node): void => {
            if ((ts.isPropertyAssignment(child) || ts.isShorthandPropertyAssignment(child)) && FAILURE_LIKE.test(text(child.name))) hit = true
            ts.forEachChild(child, inner)
          }
          inner(node.right)
          if (hit) { found = true; return }
        }
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && node.operator === ts.SyntaxKind.PlusPlusToken && FAILURE_LIKE.test(text(node.operand))) { found = true; return }
        if (ts.isCallExpression(node)) {
          const callee = text(node.expression)
          if (/\.push$/.test(callee) && FAILURE_LIKE.test(callee)) { found = true; return }
          if (!/^console\./.test(callee) && !/logActivity|logger|warn/i.test(callee) && FAILURE_LIKE.test(callee.split('.').pop()!)) { found = true; return }
        }
        ts.forEachChild(node, visit)
      }
      visit(body)
      return found
    }
    const stack: string[] = []
    const nameOf = (node: ts.Node): string | null => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return text(node.name)
      if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return text(node.name)
      if (ts.isPropertyAssignment(node) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return text(node.name)
      return null
    }
    const visit = (node: ts.Node): void => {
      const name = nameOf(node)
      if (name) stack.push(name)
      if (ts.isCatchClause(node)) {
        catches++
        if (!reports(node.block)) {
          const key = `${path.relative('.', file)}::${stack.at(-1) ?? '(module)'}`
          flagged.set(key, (flagged.get(key) ?? 0) + 1)
        }
      }
      ts.forEachChild(node, visit)
      if (name) stack.pop()
    }
    visit(source)
  }
  assert.ok(scanned > 100 && catches > 300, `the module graph was read (${scanned} files, ${catches} catch clauses), so the test is not vacuous`)
  const problems: string[] = []
  for (const [key, count] of flagged) {
    const justified = JUSTIFIED[key]
    if (!justified) problems.push(`${key}: ${count} catch clause(s) swallow a failure: count it into the result (and the mapping) or justify it in JUSTIFIED`)
    else if (justified.count !== count) problems.push(`${key}: ${count} swallowing catch clause(s), justified for ${justified.count}: justify the new one or fold it into the result`)
  }
  for (const key of Object.keys(JUSTIFIED)) if (!flagged.has(key)) problems.push(`${key}: justified but no longer swallows a failure (remove the entry)`)
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`)
})
