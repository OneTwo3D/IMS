import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

/**
 * o3d-batch-ret (Codex HIGH) — THE ENQUEUE VERDICT IS COMPUTED BEFORE THE RECEIPT FENCE, ON BOTH
 * CONNECTORS.
 *
 * A CORRECT CHECK PLACED AFTER THE IRREVERSIBLE STEP IS NOT A CHECK. `enqueueSalesInvoiceFollowUps`
 * attempts the payment and the PDF, then invokes `registerDeferredOrderReceipts`, which takes the
 * sales-order lock and CLEARS the caller's obligation generation. The two enqueue outcomes were
 * folded into a verdict in the `return` statement below that call, so every consumer of the verdict
 * — `requireFollowUpsEnqueued` on the post path, `followUpSettlement` in the sweep — was reading a
 * correct answer about a marker that had already been retired. A refused payment was therefore
 * re-enqueued by nobody, on a row that looks reconciled.
 *
 * `tests/accounting/deferred-receipt-redrive-wiring.test.ts` proves what the fence DOES with the
 * composed prerequisite. Nothing there can see WHERE the connectors build it, and "before" is the
 * whole finding — a connector that composed the same verdict one statement too late would pass every
 * behavioural test in this repository, because the value it hands over is identical. So the ORDER is
 * asserted here, from the shipped sources, on both connectors, through one judgement that the
 * controls below are run through as well.
 *
 * THE SIBLING CONNECTOR IS NOT A FOOTNOTE. The QuickBooks twin had the identical ordering and it
 * matters MORE there: its follow-up recovery registry entry says NOTHING re-drives a retained
 * marker, so a marker cleared early is the end of the trail rather than a deferral to the next
 * sweep. A test that walked only Xero would have called this fixed with half of it shipped.
 */

const CONNECTORS = [
  { label: 'xero', file: 'lib/connectors/xero/sync-processor.ts' },
  { label: 'quickbooks', file: 'lib/connectors/quickbooks/sync-processor.ts' },
] as const

const ENQUEUE_FN = 'enqueueSalesInvoiceFollowUps'
const FENCE_CALL = 'registerDeferredOrderReceipts'
const VERDICT_CALL = 'combineFollowUpEnqueueOutcomes'
const PREREQUISITE_CALL = 'obligationReleasePrerequisite'
const FENCE_FIELD = 'settlementPrerequisite'

function descend(node: ts.Node, visit: (child: ts.Node) => void): void {
  node.forEachChild((child) => {
    visit(child)
    descend(child, visit)
  })
}

function callee(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null
  return ts.isIdentifier(node.expression) ? node.expression.text : null
}

/**
 * EVERY COMPLAINT THE ORDERING RULE RAISES AGAINST ONE SOURCE. One function, so the controls below
 * are judged by exactly the rule the shipped connectors are held to rather than a paraphrase of it.
 */
function judgeOrdering(sourceText: string): string[] {
  const complaints: string[] = []
  const source = ts.createSourceFile('subject.ts', sourceText, ts.ScriptTarget.Latest, true)

  let fn: ts.FunctionDeclaration | null = null
  descend(source, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === ENQUEUE_FN && node.body) fn = node as ts.FunctionDeclaration
  })
  if (!fn) return [`${ENQUEUE_FN} is not a function with a body in this source, so this walk reads nothing`]
  const body = (fn as ts.FunctionDeclaration).body!

  const fenceCalls: ts.CallExpression[] = []
  descend(body, (node) => { if (callee(node) === FENCE_CALL) fenceCalls.push(node as ts.CallExpression) })
  if (fenceCalls.length !== 1) {
    return [`${ENQUEUE_FN} makes ${fenceCalls.length} calls to ${FENCE_CALL}; this rule is about the one that clears the marker`]
  }
  const fence = fenceCalls[0]

  // A `const NAME = <call to fnName>(...)` inside the function body, with the position it ENDS at —
  // which is what "before the fence" is measured against.
  const declaredFrom = (fnName: string): { name: string; end: number; call: ts.CallExpression } | null => {
    let found: { name: string; end: number; call: ts.CallExpression } | null = null
    descend(body, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isIdentifier(node.name)) return
      if (callee(node.initializer) !== fnName) return
      found = { name: node.name.text, end: node.end, call: node.initializer as ts.CallExpression }
    })
    return found
  }

  const verdict = declaredFrom(VERDICT_CALL)
  const prerequisite = declaredFrom(PREREQUISITE_CALL)

  if (!verdict) {
    complaints.push(`the aggregate enqueue verdict is never bound to a name — ${VERDICT_CALL} must be called before `
      + `${FENCE_CALL}, not inlined into the return below it`)
  } else if (verdict.end > fence.getStart()) {
    complaints.push(`the aggregate enqueue verdict is computed AFTER ${FENCE_CALL}, which has already taken the `
      + 'marker decision — a check placed after the irreversible step is not a check')
  }

  if (!prerequisite) {
    complaints.push(`${PREREQUISITE_CALL} is never called, so the enqueue's refusal cannot reach the fence at all`)
  } else if (prerequisite.end > fence.getStart()) {
    complaints.push(`${PREREQUISITE_CALL} is called AFTER ${FENCE_CALL}, so its answer arrives once the generation is gone`)
  }

  if (verdict && prerequisite) {
    const first = prerequisite.call.arguments[0]
    if (!first || !ts.isIdentifier(first) || first.text !== verdict.name) {
      complaints.push(`${PREREQUISITE_CALL} is not composed over the aggregate verdict \`${verdict.name}\`, so a refused `
        + 'payment beside an enqueued PDF would still release')
    }
  }

  // AND IT ACTUALLY REACHES THE FENCE. A prerequisite computed in the right place and then not
  // passed is the same defect with a decoration on top.
  const obligation = fence.arguments[2]
  if (!obligation || !ts.isObjectLiteralExpression(obligation)) {
    complaints.push(`the obligation handed to ${FENCE_CALL} is not an object literal this walk can read`)
  } else if (prerequisite) {
    let wired = false
    descend(obligation, (node) => {
      if (!ts.isPropertyAssignment(node)) return
      if (!ts.isIdentifier(node.name) || node.name.text !== FENCE_FIELD) return
      if (ts.isIdentifier(node.initializer) && node.initializer.text === prerequisite.name) wired = true
    })
    if (!wired) {
      complaints.push(`\`${prerequisite.name}\` never reaches the obligation's \`${FENCE_FIELD}\`, so the fence releases `
        + 'without ever being told about the refusal')
    }
  }

  return complaints
}

// ---------------------------------------------------------------------------------------------
// CONTROLS. Each is the shipped SHAPE with one thing moved, run through the same judgement, so the
// rule above is shown to be capable of failing before it is believed about the real connectors.
// ---------------------------------------------------------------------------------------------

const CORRECT_SHAPE = `
async function ${ENQUEUE_FN}(entryId: string, settlementPrerequisite?: () => Promise<boolean>) {
  const paymentOutcome = await enqueueFollowUpSyncLog('INVOICE_PAYMENT')
  const pdfOutcome = await enqueueFollowUpSyncLog('INVOICE_PDF')
  const enqueueOutcome = ${VERDICT_CALL}(paymentOutcome, pdfOutcome)
  const releasePrerequisite = ${PREREQUISITE_CALL}(enqueueOutcome, settlementPrerequisite)
  const redrive = await ${FENCE_CALL}(referenceId, posted, {
    syncLogId: entryId,
    generation: followUpObligation,
    ...(releasePrerequisite ? { ${FENCE_FIELD}: releasePrerequisite } : {}),
  })
  return { ...enqueueOutcome, deferredReceiptsSettled: redrive.settled }
}
`

test('[o3d-batch-ret] CONTROL: a verdict folded in the return below the fence is refused', () => {
  // THE SHIPPED DEFECT, exactly as it stood: both enqueues attempted, the fence invoked with no
  // prerequisite at all, and the outcome composed afterwards where every consumer reads it too late.
  const complaints = judgeOrdering(`
async function ${ENQUEUE_FN}(entryId: string) {
  const paymentOutcome = await enqueueFollowUpSyncLog('INVOICE_PAYMENT')
  const pdfOutcome = await enqueueFollowUpSyncLog('INVOICE_PDF')
  const redrive = await ${FENCE_CALL}(referenceId, posted, {
    syncLogId: entryId,
    generation: followUpObligation,
  })
  return { ...${VERDICT_CALL}(paymentOutcome, pdfOutcome), deferredReceiptsSettled: redrive.settled }
}
`)
  assert.ok(
    complaints.some((complaint) => complaint.includes(PREREQUISITE_CALL)),
    `the shipped defect must be named. Saw: ${JSON.stringify(complaints)}`,
  )
})

test('[o3d-batch-ret] CONTROL: composing the verdict AFTER the fence is refused', () => {
  // The subtle half, and the one a behavioural test cannot see: the same helper, the same argument,
  // one statement too late. The value handed over is identical; only the marker is already gone.
  const complaints = judgeOrdering(`
async function ${ENQUEUE_FN}(entryId: string, settlementPrerequisite?: () => Promise<boolean>) {
  const paymentOutcome = await enqueueFollowUpSyncLog('INVOICE_PAYMENT')
  const pdfOutcome = await enqueueFollowUpSyncLog('INVOICE_PDF')
  const redrive = await ${FENCE_CALL}(referenceId, posted, {
    syncLogId: entryId,
    generation: followUpObligation,
  })
  const enqueueOutcome = ${VERDICT_CALL}(paymentOutcome, pdfOutcome)
  const releasePrerequisite = ${PREREQUISITE_CALL}(enqueueOutcome, settlementPrerequisite)
  return { ...enqueueOutcome, deferredReceiptsSettled: redrive.settled, releasePrerequisite }
}
`)
  assert.ok(
    complaints.some((complaint) => complaint.includes(`AFTER ${FENCE_CALL}`)),
    `an ordering violation must be named as one. Saw: ${JSON.stringify(complaints)}`,
  )
})

test('[o3d-batch-ret] CONTROL: a prerequisite computed in the right place and never passed is refused', () => {
  const complaints = judgeOrdering(CORRECT_SHAPE.replace(
    `...(releasePrerequisite ? { ${FENCE_FIELD}: releasePrerequisite } : {}),`,
    '',
  ))
  assert.ok(
    complaints.some((complaint) => complaint.includes(FENCE_FIELD)),
    `an unwired prerequisite must be named. Saw: ${JSON.stringify(complaints)}`,
  )
})

test('[o3d-batch-ret] CONTROL: composing over only ONE of the two enqueues is refused', () => {
  // `combineFollowUpEnqueueOutcomes` exists because a refused payment beside an enqueued PDF is
  // refused overall. A prerequisite built from `pdfOutcome` alone releases the marker for the money.
  const complaints = judgeOrdering(CORRECT_SHAPE.replace(
    `${PREREQUISITE_CALL}(enqueueOutcome, settlementPrerequisite)`,
    `${PREREQUISITE_CALL}(pdfOutcome, settlementPrerequisite)`,
  ))
  assert.ok(
    complaints.some((complaint) => complaint.includes('aggregate verdict')),
    `composing over one axis must be named. Saw: ${JSON.stringify(complaints)}`,
  )
})

test('[o3d-batch-ret] CONTROL: the correct shape raises nothing, so the controls above fail on their mutation', () => {
  assert.deepEqual(judgeOrdering(CORRECT_SHAPE), [])
})

// ---------------------------------------------------------------------------------------------
// AND THE SHIPPED CONNECTORS, judged by that same function.
// ---------------------------------------------------------------------------------------------

test('[o3d-batch-ret] both connectors compute the enqueue verdict before the receipt fence', async () => {
  // MUTATION THAT KILLS THIS: move the `enqueueOutcome` / `releasePrerequisite` declarations in
  // either connector's `enqueueSalesInvoiceFollowUps` below the `registerDeferredOrderReceipts`
  // call, or drop the `settlementPrerequisite` spread from the obligation literal.
  // ROUTE: the shipped source of each connector, parsed.
  let walked = 0
  for (const connector of CONNECTORS) {
    const sourceText = await readFile(path.join(process.cwd(), connector.file), 'utf8')
    assert.ok(sourceText.includes(ENQUEUE_FN), `PRECONDITION: ${connector.file} must contain ${ENQUEUE_FN}`)
    assert.deepEqual(
      judgeOrdering(sourceText), [],
      `${connector.label} (${connector.file}) must compute the enqueue verdict before the fence and hand it over`,
    )
    walked++
  }
  assert.equal(walked, CONNECTORS.length, 'both connectors were read — a walk that read one is a rule about one')
  assert.equal(walked, 2)
})
