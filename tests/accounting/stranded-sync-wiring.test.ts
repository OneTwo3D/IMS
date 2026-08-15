import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import ts from 'typescript'

// o3d-osl8 item 1 — the WIRING guard.
//
// The pure decisions live in lib/domain/accounting/stranded-sync-visibility.ts and are unit
// tested there. That leaves one hole: nothing stops the components from being reverted to
// deciding for THEMSELVES again — redirecting before the stranded read, swallowing the loader
// error as an empty list, or re-deriving "should the banner render" inline. This repo has no
// React render harness (no .tsx under tests/, no render library), and introducing one for this
// is out of scope, so the wiring is asserted STRUCTURALLY over the component sources, in the
// same style as tests/security/server-action-guard-coverage.test.ts.
//
// This is a structural guard, NOT a rendering test. It proves the components call the tested
// decisions in the right order and shape; it cannot prove what the browser paints.

const SYNC_DIR = path.join(process.cwd(), 'app', '(dashboard)', 'sync')

function parse(file: string): ts.SourceFile {
  const filePath = path.join(SYNC_DIR, file)
  return ts.createSourceFile(file, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function collect<T extends ts.Node>(root: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
  const found: T[] = []
  const visit = (n: ts.Node) => {
    if (predicate(n)) found.push(n)
    ts.forEachChild(n, visit)
  }
  visit(root)
  return found
}

function calls(root: ts.Node, callee: string): ts.CallExpression[] {
  return collect(root, ts.isCallExpression).filter((c) => c.expression.getText() === callee)
}

function ancestors(node: ts.Node): ts.Node[] {
  const chain: ts.Node[] = []
  for (let current = node.parent; current; current = current.parent) chain.push(current)
  return chain
}

test('the sync page decides the redirect with the tested function, AFTER reading the stranded rows', () => {
  // The HIGH finding: the page redirected whenever every plugin was disabled — which is exactly
  // the state where EVERY unresolved accounting row is stranded, so the only page that can show
  // them was unreachable in the one case that matters most.
  const page = parse('page.tsx')

  const [loaderCall] = calls(page, 'getStrandedAccountingSyncRows')
  const [decisionCall] = calls(page, 'shouldRedirectFromSyncPage')
  const redirectCalls = calls(page, 'redirect')
  assert.ok(loaderCall, 'the page must read the stranded rows')
  assert.ok(decisionCall, 'the redirect must be decided by the unit-tested shouldRedirectFromSyncPage')
  assert.equal(redirectCalls.length, 1, 'exactly one redirect, so there is no second unguarded path off the page')

  assert.ok(
    loaderCall.getStart() < redirectCalls[0].getStart(),
    'the stranded rows must be read BEFORE the redirect, or the rows can never be reached',
  )
  assert.ok(
    ancestors(redirectCalls[0]).some((n) => ts.isIfStatement(n) && n.expression.getText().includes('shouldRedirectFromSyncPage')),
    'the redirect must be conditioned on shouldRedirectFromSyncPage, not on the plugin flags inline',
  )
})

test('the sync page never reads the stranded rows without the `sync` permission', () => {
  // Per-row detail (sync-log ids, referenced entity ids, external transaction ids, raw connector
  // error text). A role without `sync` must cause NO read at all — not a filtered one.
  const page = parse('page.tsx')
  const [loaderCall] = calls(page, 'getStrandedAccountingSyncRows')

  const permissionCheck = calls(page, 'hasPermission')
  assert.equal(permissionCheck.length, 1)
  assert.ok(
    permissionCheck[0].arguments.some((a) => a.getText().includes("'sync'")),
    'the page-level gate must be the `sync` permission',
  )
  assert.ok(
    ancestors(loaderCall).some((n) => ts.isIfStatement(n) && n.expression.getText().includes('canSeeStrandedRows')),
    'the read must sit inside the permission branch',
  )
})

test('the sync page treats a failed stranded read as a failure, not as an empty list', () => {
  // The MEDIUM finding: `.catch(() => [])` made a loader failure indistinguishable from "nothing
  // is stranded" — silently demoting the banner to count-only, or removing it entirely when the
  // stranded rows are all FAILED (which the orphan count never counted).
  const page = parse('page.tsx')
  const [loaderCall] = calls(page, 'getStrandedAccountingSyncRows')

  assert.ok(
    !ancestors(loaderCall).some((n) => ts.isPropertyAccessExpression(n) && n.name.text === 'catch'),
    'the loader must not be .catch()-ed into a fallback value',
  )
  const tryStatement = ancestors(loaderCall).find(ts.isTryStatement)
  assert.ok(tryStatement, 'the loader failure must be caught explicitly')
  const catchText = tryStatement.catchClause?.getText() ?? ''
  assert.match(catchText, /console\.error/, 'the error must be logged, not discarded')
  assert.match(catchText, /strandedLoadFailed = true/, 'the failure must become a distinct state')
  // Next signals redirect()/notFound() by throwing. requireAuth inside the loader redirects an
  // unverified-2FA or invalidated session, so a catch that keeps those would strand the operator
  // on this page instead of sending them to the challenge.
  assert.match(catchText, /isFrameworkControlFlow\(error\)\) throw error/, 'framework control flow must be rethrown')
})

test('the sync page renders the banner unconditionally — the banner owns that decision', () => {
  // Duplicating "is there anything to show" in the page is how the failure state got lost: the
  // page hid the banner when the summary was null and no rows came back, so a failed read could
  // never be shown at all.
  const page = parse('page.tsx')
  const banners = collect(page, ts.isJsxSelfClosingElement)
    .concat(collect(page, ts.isJsxOpeningElement) as unknown as ts.JsxSelfClosingElement[])
    .filter((el) => el.tagName.getText() === 'ConnectorOrphanBanner')
  assert.equal(banners.length, 1, 'the banner is rendered exactly once')

  const enclosingJsxExpression = ancestors(banners[0]).find(ts.isJsxExpression)
  const guardedByCondition = !!enclosingJsxExpression
    && !!enclosingJsxExpression.expression
    && (ts.isBinaryExpression(enclosingJsxExpression.expression) || ts.isConditionalExpression(enclosingJsxExpression.expression))
  assert.equal(guardedByCondition, false, 'no && / ternary gate around the banner in the page')

  const props = banners[0].attributes.properties
    .filter(ts.isJsxAttribute)
    .map((a) => a.name.getText())
  assert.deepEqual(props.sort(), ['stranded', 'strandedLoadFailed', 'summary'])
})

test('the banner renders the state the tested resolver returns, and derives nothing itself', () => {
  const banner = parse('connector-orphan-banner.tsx')
  const [resolverCall] = calls(banner, 'resolveConnectorOrphanBannerState')
  assert.ok(resolverCall, 'the banner must ask the unit-tested resolver')

  const text = banner.getText()
  for (const field of ['render', 'showSummary', 'showRows', 'showLoadFailure', 'rowsSummary', 'truncated']) {
    assert.ok(text.includes(`bannerState.${field}`), `the banner must use the resolved ${field}`)
  }
  // The early return is the resolver's `render`, not a re-derived condition.
  assert.match(text, /if \(!bannerState\.render\) return null/)
})
