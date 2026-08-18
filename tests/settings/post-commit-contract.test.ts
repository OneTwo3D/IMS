import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

import { runPostCommit } from '@/lib/domain/post-commit'
import { completePluginSelectionSave } from '@/lib/domain/integrations/plugin-save-outcome'

const REPO = process.cwd()

// ---------------------------------------------------------------------------
// o3d-osl8 round 9, findings 1 and 4 — THE POST-COMMIT RULE, AND WHETHER IT IS STRUCTURAL.
//
// The rule: once a settings write has COMMITTED, nothing that happens afterwards may reach the
// caller as a rejected action, because a rejected action means "the outcome is unknown" and the
// outcome is not unknown — the value is in the database. Rounds 7, 8 and 9 each found a fresh place
// where that rule was broken, because each round fixed it by SWEEPING call sites, and three
// inventories in a row were incomplete.
//
// So this file asserts the rule two ways:
//   • BEHAVIOURALLY, on `runPostCommit`, which is now the single guard;
//   • STRUCTURALLY, over the source of the settings writers — a post-commit `await` written outside
//     the guard fails the last test in this file, whoever adds it and whichever screen it is for.
//
// ROUND 10, FINDING 3 — THE DETECTOR'S SHAPE ASSUMPTION WAS THE BUG, NOT A MISSING SITE.
//
// Round 9's version recognised a commit as one of TWO literal strings, `db.$transaction(` and
// `db.setting.upsert(`. `createTaxRate` commits through `db.taxRate.create` and then awaits
// `logActivity` and `maybeQueueTaxRateSync` outside the guard, so it was not in the inventory at
// all — and the inventory test PASSED, asserting a five-writer list that was simply the list of
// writers using the two spellings it knew. That is the third incomplete inventory in a row, and the
// pattern is the same each time: the rule was widened by adding the site that had just been found.
//
// So this round widened the SHAPE instead, on all three axes it was narrow in:
//   • the COMMIT: any direct Prisma mutation (`create`/`createMany`/`update`/`updateMany`/`upsert`/
//     `delete`/`deleteMany`) or raw execute, not two hand-listed spellings. Eleven more writers in
//     app/actions/settings.ts appeared, ten of them offending;
//   • the MODULE list: app/actions/onboarding.ts writes `settings` rows from the setup wizard and
//     was outside it. Three more writers, all three offending;
//   • WHICH commit starts the tail: it was "after the LAST commit in the function", which cannot see
//     a branch that commits and returns before a later one — `deleteWarehouse` deactivates in one
//     branch and deletes in the other. It is now "after the FIRST", because work between two
//     commits is still post-commit for the first of them.
//
// WHAT THE STRUCTURAL CHECK COVERS AND WHAT IT CANNOT — stated here rather than as a footnote,
// because implying completeness is the specific mistake being corrected:
//   1. It covers the three modules that own user-facing settings writes: app/actions/settings.ts,
//      app/actions/cron.ts and app/actions/onboarding.ts. It does NOT scan the whole repo, because
//      "a post-commit step" is not a syntactic category anywhere else — every `await` after every
//      write in the application would match, and a check that flags everything is a check nobody
//      keeps. A user-facing writer added to a FOURTH module is still invisible until it is listed.
//   2. It recognises a post-commit step by NAME (`logActivity`, `revalidatePath`,
//      `reconcileCrontab`, `syncCrontab`). A new kind of post-commit work under a new name — an
//      email, a cache purge, a webhook — is invisible to it until the name is added below.
//   3. It tells "inside the guard's callback" from "in the function body" by BRACKET MATCHING over
//      the source, skipping strings and comments. That is lexical, not semantic: a post-commit step
//      reached through a helper function, or one written inside a `catch` block (deliberately
//      excluded, because work there runs BECAUSE something failed rather than after a commit), is
//      not seen. The companion assertion below — that any catch wrapping a guard rethrows framework
//      control flow — is what covers the second of those.
//   4. It says nothing about writers OUTSIDE these two modules. `lib/maintenance-mode.ts` and
//      `lib/currencies/fx-refresh.ts` hold private `setSetting` helpers; they report to no screen,
//      and they are not covered here.
// The list below is therefore a floor — "at least these" — never a ceiling.
// ---------------------------------------------------------------------------

test('a post-commit step that RETURNS a failure and one that THROWS are the same outcome', async () => {
  const returned = await runPostCommit(async () => ({ success: false, error: 'crontab write failed' }), 'fallback')
  const thrown = await runPostCommit(async () => { throw new Error('crontab write failed') }, 'fallback')

  assert.deepEqual(returned, { status: 'failed', error: 'crontab write failed' })
  assert.deepEqual(thrown, returned, 'returned and thrown are ONE outcome — that is the whole point')
})

test('a post-commit step that succeeds, or that returns nothing at all, is ok', async () => {
  assert.deepEqual(await runPostCommit(async () => ({ success: true }), 'fallback'), { status: 'ok' })
  assert.deepEqual(await runPostCommit(async () => {}, 'fallback'), { status: 'ok' })
})

test('a failure with no stated reason falls back rather than reporting "undefined"', async () => {
  assert.deepEqual(await runPostCommit(async () => ({ success: false }), 'Failed to sync crontab'), {
    status: 'failed',
    error: 'Failed to sync crontab',
  })
  assert.deepEqual(await runPostCommit(async () => { throw 'a string' }, 'Failed to sync crontab'), {
    status: 'failed',
    error: 'Failed to sync crontab',
  })
})

test('Next control-flow throws are RETHROWN, not classified as a post-commit failure', async () => {
  // ROUND 9, FINDING 4. Round 8's guard was a catch-all. `redirect()`, `notFound()`, `forbidden()`
  // and the dynamic-rendering bailouts all signal by THROWING, and a post-commit step that
  // re-enters a permission gate raises exactly those — `syncCrontab` did, on every call. Swallowing
  // a NEXT_REDIRECT leaves an operator with an invalidated or 2FA-unverified session sitting on a
  // page that says "saved, but the scheduler is behind" instead of at the challenge.
  const redirectError = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' })
  await assert.rejects(
    () => runPostCommit(async () => { throw redirectError }, 'fallback'),
    (thrown: unknown) => thrown === redirectError,
    'the redirect must propagate so Next can perform it',
  )

  const notFoundError = Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
  await assert.rejects(
    () => runPostCommit(async () => { throw notFoundError }, 'fallback'),
    (thrown: unknown) => thrown === notFoundError,
  )

  // ...while an ordinary application error is still classified rather than thrown at the caller.
  assert.deepEqual(
    await runPostCommit(async () => { throw new Error('activity log unavailable') }, 'fallback'),
    { status: 'failed', error: 'activity log unavailable' },
  )
})

test('the plugin-selection guard inherits the rethrow rather than owning a second catch', async () => {
  // It used to have its own catch-all, which is where finding 4 landed. It now delegates, so there
  // is one place where framework control flow is recognised and one place to get it wrong.
  const committed = { woocommerce: true, shopify: false, xero: true, quickbooks: false, mintsoft: false, shiphero: false }
  const redirectError = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' })

  await assert.rejects(
    () => completePluginSelectionSave({ committed, postCommit: async () => { throw redirectError } }),
    (thrown: unknown) => thrown === redirectError,
  )

  assert.deepEqual(
    await completePluginSelectionSave({ committed, postCommit: async () => { throw new Error('boom') } }),
    { status: 'scheduler-failed', error: 'boom', pluginState: committed },
  )
  assert.deepEqual(
    await completePluginSelectionSave({ committed, postCommit: async () => ({ success: false, error: 'boom' }) }),
    { status: 'scheduler-failed', error: 'boom', pluginState: committed },
  )
})

test('the classification lives in ONE module — the outcome types own no catch of their own', () => {
  // A second catch is a second chance to forget the rethrow, which is exactly how finding 4 was
  // reintroduced by the fix for the previous round's finding 1.
  for (const rel of [
    'lib/domain/integrations/plugin-save-outcome.ts',
    'lib/domain/settings/setting-save-outcome.ts',
    'lib/domain/integrations/scheduler-followup.ts',
  ]) {
    const src = readFileSync(join(REPO, rel), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/\bcatch\s*[({]/.test(code), `${rel} must not classify thrown errors itself`)
  }

  const guard = readFileSync(join(REPO, 'lib/domain/post-commit.ts'), 'utf8')
  const catchAt = guard.indexOf('catch (error)')
  const rethrowAt = guard.indexOf('unstable_rethrow(error)')
  const classifyAt = guard.indexOf("status: 'failed'", catchAt)
  assert.ok(catchAt > 0 && rethrowAt > catchAt, 'the guard rethrows inside its catch')
  assert.ok(rethrowAt < classifyAt, 'and it rethrows BEFORE classifying anything')
})

// ---------------------------------------------------------------------------
// THE STRUCTURAL RULE.
// ---------------------------------------------------------------------------

/** Modules that own user-facing settings writes. See limit (1) at the top of this file. */
const SETTINGS_WRITER_MODULES = ['app/actions/settings.ts', 'app/actions/cron.ts', 'app/actions/onboarding.ts']

/** Work that belongs AFTER a commit and must therefore be inside the guard. See limit (2). */
const POST_COMMIT_CALLS = ['logActivity(', 'revalidatePath(', 'reconcileCrontab(', 'syncCrontab(', 'maybeQueueTaxRateSync(']

/**
 * THE COMMIT, AS A SHAPE (round 10, finding 3).
 *
 * Round 9 listed two literal call spellings and therefore had no opinion about `db.taxRate.create`,
 * `db.warehouse.delete` or any of the other nine direct Prisma mutations in these modules. Every
 * one of them commits on its own — Prisma runs a bare mutation in its own transaction — so every
 * one of them has a post-commit tail. Matching the FORM rather than the names is what stops the
 * next writer from being invisible for the same reason.
 *
 * `$transaction` is listed separately because it is the interactive form, whose callback is where a
 * multi-statement commit lives.
 */
const COMMIT_CALL_RE = /\b(?:db|prisma)\.\$transaction\(|\b(?:db|prisma)\.[a-zA-Z]\w*\.(?:create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\(|\b(?:db|prisma)\.\$execute(?:Raw|RawUnsafe)[(`]/g

/** The guards. Anything inside one of their callbacks is, by construction, classified. */
const GUARD_CALLS = ['runPostCommit(', 'completePluginSelectionSave(']

/**
 * Blank out comment CONTENT, preserving every newline and every offset.
 *
 * ROUND 10. The scan searched the RAW source, so a comment that merely MENTIONED a commit call —
 * `db.$transaction(` inside a note explaining this very rule — registered as a commit whose bracket
 * span then ran to the end of the function and swallowed every post-commit call inside it. A check
 * that can be switched off by writing prose about it is not a check. Offsets are preserved rather
 * than removed so the reported line numbers still point at the real source.
 */
function withoutComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      let j = i + 1
      while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1
      const end = Math.min(j + 1, src.length)
      out += src.slice(i, end)
      i = end
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      const end = nl === -1 ? src.length : nl
      out += ' '.repeat(end - i)
      i = end
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close === -1 ? src.length : close + 2
      out += src.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
      continue
    }
    out += c
    i += 1
  }
  return out
}

type WriterFn = { name: string; body: string }

function exportedFunctions(src: string): WriterFn[] {
  const found: WriterFn[] = []
  const re = /^export async function (\w+)\(/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(src)) !== null) {
    const start = match.index
    const nextIndex = src.indexOf('\nexport ', start + 1)
    const body = src.slice(start, nextIndex === -1 ? src.length : nextIndex)
    found.push({ name: match[1], body })
  }
  return found
}

/**
 * The span of a call expression starting at `open` (the index of its `(`), by bracket matching.
 *
 * Bracket matching rather than indentation (see limit (3) at the top of this file — indentation was
 * the first attempt, and it silently missed `updateTaxRate`, whose post-commit tail sits one level
 * in because the whole action is wrapped in a try block). String and comment contents are skipped so
 * a bracket in a message cannot shift the span.
 */
function callSpan(src: string, open: number): [number, number] {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i += 1
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i) + 1 || src.length; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1
      if (depth === 0) return [open, i]
    }
    i += 1
  }
  return [open, src.length]
}

/** Every call matching a REGEX, as spans. The commit shape is a form, not a list of names. */
function spansOfPattern(body: string, pattern: RegExp): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const re = new RegExp(pattern.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) {
    spans.push(callSpan(body, match.index + match[0].length - 1))
  }
  return spans
}

function spansOf(body: string, needles: string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const needle of needles) {
    let from = 0
    for (;;) {
      const at = body.indexOf(needle, from)
      if (at === -1) break
      spans.push(callSpan(body, at + needle.length - 1))
      from = at + needle.length
    }
  }
  return spans
}

function committingWriters(): Array<{ module: string; name: string; body: string }> {
  const writers: Array<{ module: string; name: string; body: string }> = []
  for (const rel of SETTINGS_WRITER_MODULES) {
    for (const fn of exportedFunctions(withoutComments(readFileSync(join(REPO, rel), 'utf8')))) {
      if (spansOfPattern(fn.body, COMMIT_CALL_RE).length > 0) {
        writers.push({ module: rel, name: fn.name, body: fn.body })
      }
    }
  }
  return writers
}

/** `catch (…) { … }` blocks: work there runs BECAUSE something failed, not after a commit. */
function catchSpans(body: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const re = /catch\s*(?:\([^)]*\))?\s*\{/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) {
    spans.push(callSpan(body, match.index + match[0].length - 1))
  }
  return spans
}

/** Post-commit calls that are neither inside the commit itself nor inside a guard. */
function unguardedPostCommitCalls(source: string): string[] {
  const body = withoutComments(source)
  const commitSpans = spansOfPattern(body, COMMIT_CALL_RE)
  const guardSpans = [...spansOf(body, GUARD_CALLS), ...catchSpans(body)]
  // THE FIRST commit, not the last (round 10, finding 3). Work between two commits is post-commit
  // for the first of them, and a function that commits in one branch and returns — `deleteWarehouse`
  // deactivating instead of deleting — has its whole tail before the "last" commit.
  const firstCommitEnd = commitSpans.reduce((min, [, end]) => (min === -1 ? end : Math.min(min, end)), -1)
  if (firstCommitEnd === -1) return []

  const offenders: string[] = []
  for (const needle of POST_COMMIT_CALLS) {
    let from = 0
    for (;;) {
      const at = body.indexOf(needle, from)
      if (at === -1) break
      from = at + needle.length
      const insideCommit = commitSpans.some(([start, end]) => at > start && at < end)
      const insideGuard = guardSpans.some(([start, end]) => at > start && at < end)
      // Before the LAST commit it is pre-commit work, which may fail the action freely.
      if (at < firstCommitEnd || insideCommit || insideGuard) continue
      const line = body.slice(0, at).split('\n').length
      offenders.push(`line ${line}: ${body.split('\n')[line - 1].trim()}`)
    }
  }
  return offenders
}

test('every committing settings writer is discovered — an empty scan proves nothing', () => {
  // Pinned in BOTH directions: a new committing writer appears here and must be considered, and one
  // that DISAPPEARS is equally visible, so the guard below cannot rot into a check over nothing.
  //
  // ROUND 10: this list was FIVE entries, and it passed, because the detector only recognised two
  // literal commit spellings — so the assertion was "the writers that use `db.$transaction` or
  // `db.setting.upsert` are these five", not "the committing writers are these five". Sixteen more
  // were invisible, thirteen of them offending. A pinned list is only worth what the scan that
  // produces it is worth, which is why the widening above matters more than the entries below.
  assert.deepEqual(
    committingWriters().map((w) => `${w.module}#${w.name}`).sort(),
    [
      'app/actions/cron.ts#saveCronJobSettings',
      'app/actions/onboarding.ts#completeOnboarding',
      'app/actions/onboarding.ts#dismissOnboarding',
      'app/actions/onboarding.ts#saveOnboardingPluginState',
      'app/actions/onboarding.ts#setOnboardingStep',
      'app/actions/settings.ts#autoLinkQuickBooksTaxRates',
      'app/actions/settings.ts#autoLinkXeroTaxRates',
      'app/actions/settings.ts#createAdjustmentReason',
      'app/actions/settings.ts#createPurchaseUnit',
      'app/actions/settings.ts#createTaxRate',
      'app/actions/settings.ts#createWarehouse',
      'app/actions/settings.ts#deleteAdjustmentReason',
      'app/actions/settings.ts#deleteWarehouse',
      'app/actions/settings.ts#generateMissingXeroTaxRates',
      'app/actions/settings.ts#saveIntegrationPluginState',
      'app/actions/settings.ts#savePublicAppUrl',
      'app/actions/settings.ts#setSettings',
      'app/actions/settings.ts#updateAdjustmentReason',
      'app/actions/settings.ts#updatePurchaseUnit',
      'app/actions/settings.ts#updateTaxRate',
      'app/actions/settings.ts#updateWarehouse',
    ],
  )
})

test('no committing settings writer awaits a post-commit step OUTSIDE the guard', () => {
  // THE RULE, made structural. `setSetting` broke it by awaiting `logActivity` and calling
  // `revalidatePath` straight after its upsert; the rejection that produced was rendered as a failed
  // save by fourteen screens. Adding such a line back to any writer below fails here.
  const offenders: string[] = []
  for (const writer of committingWriters()) {
    for (const call of unguardedPostCommitCalls(writer.body)) {
      offenders.push(`${writer.module}#${writer.name} ${call}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these run after the commit at the top level of the action, so a failure in them rejects a call '
      + 'whose write is already durable. Move them inside runPostCommit / completePluginSelectionSave:\n'
      + offenders.join('\n'),
  )
})

test('...and the guard is actually being used, so the check above is not vacuously green', () => {
  // A scan that finds no offenders because there is no post-commit work left at all would pass the
  // previous test while proving nothing.
  const guarded = committingWriters().filter((w) => GUARD_CALLS.some((needle) => w.body.includes(needle)))
  assert.deepEqual(
    guarded.map((w) => `${w.module}#${w.name}`).sort(),
    [
      'app/actions/cron.ts#saveCronJobSettings',
      'app/actions/onboarding.ts#completeOnboarding',
      'app/actions/onboarding.ts#dismissOnboarding',
      'app/actions/onboarding.ts#saveOnboardingPluginState',
      'app/actions/onboarding.ts#setOnboardingStep',
      'app/actions/settings.ts#autoLinkQuickBooksTaxRates',
      'app/actions/settings.ts#autoLinkXeroTaxRates',
      'app/actions/settings.ts#createAdjustmentReason',
      'app/actions/settings.ts#createPurchaseUnit',
      'app/actions/settings.ts#createTaxRate',
      'app/actions/settings.ts#createWarehouse',
      'app/actions/settings.ts#deleteAdjustmentReason',
      'app/actions/settings.ts#deleteWarehouse',
      'app/actions/settings.ts#generateMissingXeroTaxRates',
      'app/actions/settings.ts#saveIntegrationPluginState',
      'app/actions/settings.ts#savePublicAppUrl',
      'app/actions/settings.ts#setSettings',
      'app/actions/settings.ts#updateAdjustmentReason',
      'app/actions/settings.ts#updatePurchaseUnit',
      'app/actions/settings.ts#updateTaxRate',
      'app/actions/settings.ts#updateWarehouse',
    ],
    'every committing writer still has post-commit work, and all of it is inside the guard',
  )

  // FED THE EXACT CODE ROUND 9 FOUND STILL LIVE, so the rule is known to catch it rather than
  // assumed to. This is `setSetting` as it was, and `updateTaxRate`'s tail as it was — the second
  // one is the case an indentation-based rule missed, because the whole action sits inside a try.
  const revertedSetSetting = [
    'export async function setSetting(key: string, value: string) {',
    '  await db.setting.upsert({ where: { key }, create: {}, update: {} })',
    '  await logActivity({ entityType: \'SETTING\' })',
    "  revalidatePath('/settings', 'layout')",
    '}',
  ].join('\n')
  assert.deepEqual(
    unguardedPostCommitCalls(revertedSetSetting).map((o) => o.replace(/^line \d+: /, '')),
    ["await logActivity({ entityType: 'SETTING' })", "revalidatePath('/settings', 'layout')"],
  )

  const revertedTaxRate = [
    'export async function updateTaxRate(id: string) {',
    '  try {',
    '    const summary = await db.$transaction(async (tx) => { return tx.taxRate.update({}) })',
    '    await logActivity({ entityType: \'SETTING\', metadata: summary })',
    '    await maybeQueueTaxRateSync({ id })',
    "    revalidatePath('/settings', 'layout')",
    '    return { success: true }',
    '  } catch (e) {',
    '    return { success: false, error: String(e) }',
    '  }',
    '}',
  ].join('\n')
  assert.equal(unguardedPostCommitCalls(revertedTaxRate).length, 3, 'nesting does not hide a post-commit step')

  // ROUND 10, FINDING 3 — FED THE EXACT CODE THE ROUND-9 DETECTOR COULD NOT SEE. `createTaxRate`
  // commits with `db.taxRate.create` and awaited three post-commit steps outside the guard; the
  // two-spelling COMMIT list meant this function was not even in the inventory, so the offender
  // scan ran over it and found nothing because it never looked.
  const revertedCreateTaxRate = [
    'export async function createTaxRate(input: { name: string }) {',
    '  try {',
    '    const created = await db.taxRate.create({ data: { name: input.name } })',
    '    await logActivity({ entityType: \'SETTING\' })',
    '    await maybeQueueTaxRateSync({ id: created.id })',
    "    revalidatePath('/settings', 'layout')",
    '    return { success: true }',
    '  } catch (e) {',
    '    return { success: false, error: String(e) }',
    '  }',
    '}',
  ].join('\n')
  assert.equal(
    unguardedPostCommitCalls(revertedCreateTaxRate).length,
    3,
    'a bare Prisma create commits on its own, so everything after it is post-commit',
  )

  // ...and the same for a writer that commits in ONE BRANCH and returns, which the "after the LAST
  // commit" rule could not see at all.
  const revertedDeleteWarehouse = [
    'export async function deleteWarehouse(id: string) {',
    '  if (hasData) {',
    '    await db.warehouse.update({ where: { id }, data: { active: false } })',
    '    await logActivity({ entityType: \'SETTING\' })',
    '    return { success: true, deactivated: true }',
    '  }',
    '  await db.warehouse.delete({ where: { id } })',
    "  revalidatePath('/settings', 'layout')",
    '  return { success: true }',
    '}',
  ].join('\n')
  assert.equal(
    unguardedPostCommitCalls(revertedDeleteWarehouse).length,
    2,
    'the branch that commits and returns first has a post-commit tail of its own',
  )

  // ...and a COMMENT that names a commit call cannot switch the rule off. The scan used to search
  // the raw source, so prose describing the rule registered as a commit whose bracket span ran to
  // the end of the function and swallowed everything after it — including this file's own examples.
  const commentDefeat = [
    'export async function setSetting(key: string, value: string) {',
    '  await db.setting.upsert({ where: { key }, create: {}, update: {} })',
    '  // the rule looks for db.$transaction( and db.setting.upsert(',
    '  await logActivity({ entityType: \'SETTING\' })',
    '}',
  ].join('\n')
  assert.equal(unguardedPostCommitCalls(commentDefeat).length, 1, 'a comment about the rule is not a commit')

  // ...and it does NOT flag the same calls when they are inside the guard's callback.
  const guardedShape = [
    'export async function setSettings(values: Record<string, string>) {',
    '  await db.$transaction(async (tx) => { await tx.setting.upsert({}) })',
    '  return runPostCommit(async () => {',
    '    await logActivity({ entityType: \'SETTING\' })',
    "    revalidatePath('/settings', 'layout')",
    '  }, \'fallback\')',
    '}',
  ].join('\n')
  assert.deepEqual(unguardedPostCommitCalls(guardedShape), [], 'no false positives inside the guard')
})

test('a catch that WRAPS a guard rethrows framework control flow before classifying', () => {
  // The guard deliberately rethrows `NEXT_REDIRECT`. A surrounding `catch` that then swallows it
  // has undone the fix one line further out — and `updateTaxRate` has exactly that shape, because
  // its whole body is inside a try. Checked structurally, since the shape is what matters.
  const offenders: string[] = []
  for (const writer of committingWriters()) {
    const guards = spansOf(writer.body, GUARD_CALLS)
    for (const [start, end] of catchSpans(writer.body)) {
      const wrapsAGuard = guards.some(([gStart]) => gStart > 0 && gStart < start && end > start)
        || guards.some(([gStart, gEnd]) => gStart < start && gEnd > end)
      // A catch AFTER a guard in the same function body can still receive its rethrow.
      const guardBefore = guards.some(([, gEnd]) => gEnd < start)
      if (!wrapsAGuard && !guardBefore) continue
      const block = writer.body.slice(start, end)
      if (!/unstable_rethrow\(/.test(block)) {
        offenders.push(`${writer.module}#${writer.name} catch at offset ${start}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these catches can receive a rethrown NEXT_REDIRECT and would classify it as an application '
      + `failure:\n${offenders.join('\n')}`,
  )
})

test('the reconciliation reachable from a post-commit step carries no permission gate of its own', () => {
  // ROUND 9, FINDING 4, structurally. `syncCrontab` re-runs `requirePermission`, whose answer to an
  // invalidated or unverified session is a THROWN redirect — inside a post-commit guard, which is
  // the one place such a throw must not be treated as an application failure. The work moved to
  // lib/crontab-reconcile.ts, which has no gate; the gated `syncCrontab` remains for the operator
  // button on Settings → System → Scheduler.
  const reconcileSrc = readFileSync(join(REPO, 'lib/crontab-reconcile.ts'), 'utf8')
  const reconcile = reconcileSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/requirePermission|requireAuth|requireAdmin/.test(reconcile), 'the reconciliation has no gate to re-enter')
  assert.ok(!/^'use server'/m.test(reconcileSrc), 'and it is not on any RPC manifest — an ungated crontab writer must not be callable')

  for (const rel of ['app/actions/settings.ts', 'app/actions/onboarding.ts']) {
    const src = readFileSync(join(REPO, rel), 'utf8')
    if (!/reconcileCrontab\(\)/.test(src)) continue
    assert.ok(
      /requirePermission\(|requireAdmin\(/.test(src),
      `${relative(REPO, rel)} calls the ungated reconciliation, so it must gate first`,
    )
    assert.ok(!/\bsyncCrontab\(\)/.test(src), `${rel} must not call the gated action from a post-commit step`)
  }
})
