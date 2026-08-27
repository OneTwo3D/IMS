import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// ---------------------------------------------------------------------------
// o3d-0bfh r6 (Codex MEDIUM) — THE STALE PRECONDITION KEEPS COMING BACK, SO THIS IS THE THING THAT
// STOPS A SEVENTH SITE.
//
// For three rounds this codebase told every reader the same thing: do not bind the QuickBooks
// back-reference repair sweep until o3d-s36z (connector-tenant / realm isolation) closes. o3d-s36z
// CLOSED on 2026-08-21. It unblocked nothing — the realm fence it delivered is the SELECT side, and
// what a repair sweep does is ENQUEUE into a connector that checks no connection verdict at POST
// time (o3d-8prh) and mints no origin on the rows it creates. A maintainer who followed the old line
// would have found the named condition satisfied and made a one-line binding that re-enqueues a
// realm-local integer against the wrong company. That is a money defect reached by reading the
// comments correctly.
//
// r5 corrected five sites. r6's review found three more (the accounting-sync cron, the manual
// QuickBooks sync action, and the operator help doc, which still told operators the company pin was
// absent and the company boundary was the blocker). Correcting eight sites by hand is not a fix for
// a defect whose failure mode is "one more site appears"; this test is.
//
// THREE RULES, over production code, tests AND operator documentation — the help doc is where the
// last round's misinformation survived longest, and it is read by the same people:
//
//   1. o3d-s36z may never be presented as a CURRENT precondition or blocker. Naming it is fine —
//      the history is worth keeping — but only where the closure is stated alongside it.
//   2. Operator documentation may not tell a reader that the company pin/company boundary is what
//      blocks a QuickBooks sweep, unless the same passage names the real prerequisite.
//   3. Any passage that states what a QuickBooks sweep binding is waiting on must NAME the real
//      prerequisite (o3d-8prh, or "post time" in prose for the operator docs). This is the rule that
//      catches a NEW site: writing "precondition for binding the QuickBooks sweep: <anything else>"
//      fails here even if o3d-s36z is never mentioned.
//
// The rules are deliberately phrase-level rather than AST-level, because the defect is phrase-level:
// it lives in comments and prose, which no compiler reads.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const SCANNED_ROOTS = ['lib', 'app', 'tests', 'help-docs']
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.md'])
/** This file states the obsolete phrasings in order to forbid them, so it cannot scan itself. */
const SELF = path.relative(REPO_ROOT, __filename).replace(/\.[cm]?[jt]s$/, '')

function scannedFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'generated') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!SCANNED_EXTENSIONS.has(path.extname(entry))) continue
      if (path.relative(REPO_ROOT, full).startsWith(SELF)) continue
      found.push(full)
    }
  }
  for (const root of SCANNED_ROOTS) walk(path.join(REPO_ROOT, root))
  return found
}

/** Every scanned file as its lines, read once — the three rules share the walk. */
const FILES: Array<{ rel: string; lines: string[] }> = scannedFiles().map((full) => ({
  rel: path.relative(REPO_ROOT, full),
  lines: readFileSync(full, 'utf8').split('\n'),
}))

function window(lines: string[], index: number, radius: number): string {
  return lines.slice(Math.max(0, index - radius), index + radius + 1).join('\n')
}

/** Words that turn a mention into a claim about what must happen before something else can. */
const PRECONDITION = /precondition|blocked on|\bblocker\b|before (re-?)?(add|bind)ing|not safe to bind|waiting on(?! it\b)/i
/**
 * o3d-s36z presented as the thing something is waiting FOR — the precondition word and the issue id
 * in one clause, with no sentence break between them.
 *
 * A PROXIMITY rule was tried first and rejected: "is o3d-s36z named within six lines of the word
 * CLOSED" passes the moment the stale line is written next to the paragraph explaining the closure,
 * which is exactly where a maintainer would put it. What separates the honest mentions from the
 * dangerous one is not distance, it is GRAMMAR — the honest ones are past tense or negated ("it WAS
 * o3d-s36z", "which this line USED TO name", "NOT the closed o3d-s36z"), and the dangerous one is a
 * live instruction. So the clause is matched and the past-tense/negation markers excuse it.
 */
const CURRENT_PRECONDITION_CLAIM = /(precondition|blocker|blocked on|waiting on|until|before)\b[^.\n]{0,80}o3d-s36z/i
/** Past tense, negation, or an explicit closure — the constructions that make a mention historical. */
const HISTORICAL = /used to|earlier|no longer|not the|\bclosed\b|\bwas\b|\bwere\b|stale|obsolete|wrong one/i
/** The REAL prerequisites: post-time authorization, named by issue id or in operator prose. */
const REAL_PREREQUISITE = /o3d-8prh|post[- ]time/i
const QUICKBOOKS = /quickbooks/i
/**
 * The operator-doc claim this round removed, matched as a CONSTRUCTION for the same reason rule 1 is:
 * "the company pin is cleared, SO A SWEEP could not tell", "why the company boundary IS THE BLOCKER".
 *
 * A proximity escape ("…unless the real prerequisite is named nearby") was tried and rejected here
 * too — rewriting the surrounding paragraph correctly, as this round did, would then licence the
 * false sentence to survive inside it, which is precisely how the doc came to hold both.
 */
const BOUNDARY_BLAME = /\bblocker\b|\bblocks\b|what is missing|precondition|so a sweep|\babsent\b/i
/** A passage about BINDING the sweep, as opposed to one that merely mentions a sweep in passing. */
const SWEEP_BINDING = /\bbind(ing|s)?\b|\bre-?add|not bound|unbound|repair sweep|no QuickBooks (sweep|equivalent|binding)/i

test('[o3d-0bfh r6] the CLOSED realm-isolation issue is never named as a current precondition', () => {
  const offences: string[] = []
  for (const { rel, lines } of FILES) {
    lines.forEach((line, index) => {
      if (!CURRENT_PRECONDITION_CLAIM.test(line)) return
      if (HISTORICAL.test(line)) return
      offences.push(`${rel}:${index + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(
    offences,
    [],
    'o3d-s36z CLOSED on 2026-08-21 and unblocked nothing on the QuickBooks side. Naming it as a live '
      + 'precondition tells a maintainer to check a condition that is already satisfied, and the one-line '
      + 'binding that follows re-enqueues a realm-local integer against whatever company is connected at '
      + 'post time. Name the real prerequisites instead — post-time authorization (o3d-8prh) and origin '
      + 'propagation — or state the closure alongside the history:\n' + offences.join('\n'),
  )
})

test('[o3d-0bfh r6] operator documentation does not blame the company boundary for the missing sweep', () => {
  const offences: string[] = []
  for (const { rel, lines } of FILES) {
    if (!rel.startsWith('help-docs/')) continue
    lines.forEach((line, index) => {
      if (!/company (pin|boundary)/i.test(line) || !BOUNDARY_BLAME.test(line)) return
      if (HISTORICAL.test(line)) return
      offences.push(`${rel}:${index + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(
    offences,
    [],
    'the help doc used to tell operators that disconnecting clears the company pin and that the company '
      + 'boundary is the blocker for a QuickBooks sweep. Every sync row now records the company it was '
      + 'raised against, so that is no longer what is missing — a passage that still says so has to name '
      + 'what actually is (the post-time check):\n' + offences.join('\n'),
  )
})

test('[o3d-0bfh r6] any passage stating what a QuickBooks sweep binding awaits names the REAL prerequisite', () => {
  const offences: string[] = []
  for (const { rel, lines } of FILES) {
    lines.forEach((line, index) => {
      if (!PRECONDITION.test(line) || HISTORICAL.test(line)) return
      const near = window(lines, index, 6)
      if (!QUICKBOOKS.test(near) || !SWEEP_BINDING.test(near)) return
      // The real prerequisite has to be in the SAME passage, not merely somewhere in the file: a new
      // stale line written directly above the corrected block would otherwise inherit its o3d-8prh
      // and pass. (Verified by mutation — that is exactly where a maintainer puts one.)
      if (REAL_PREREQUISITE.test(window(lines, index, 4))) return
      offences.push(`${rel}:${index + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(
    offences,
    [],
    'this is the rule that stops a SEVENTH site: a new comment naming any other condition as what the '
      + 'QuickBooks back-reference sweep is waiting on fails here, whether or not it mentions o3d-s36z. '
      + 'Name post-time authorization (o3d-8prh) — in the operator docs, the phrase "post time" is '
      + 'enough:\n' + offences.join('\n'),
  )
})

test('[o3d-0bfh r6] CONTROL: the rules actually fire on the exact text this round removed', () => {
  // Without this, all three tests above are satisfied by predicates that match nothing at all — which
  // is the same green as a repository with no offending line in it, and would stay green if a later
  // edit broke the regexes. Each rule is re-run against the literal text that stood in the tree
  // before this round, so a rule that has quietly stopped matching is caught here rather than by the
  // seventh site appearing.
  const removedCronLine = '    // document is not. Precondition for binding it: o3d-s36z (connector-tenant isolation). See the'
  assert.ok(
    CURRENT_PRECONDITION_CLAIM.test(removedCronLine),
    'rule 1 must match the line this round removed from app/api/cron/accounting-sync/route.ts',
  )
  assert.equal(HISTORICAL.test(removedCronLine), false, 'and nothing on it marks the mention as historical')
  // The mentions rule 1 must NOT flag, quoted from the tree: the history is worth keeping, and a rule
  // that forbade the string outright would be answered by deleting the explanation rather than the
  // instruction.
  for (const honest of [
    '// "Precondition for re-adding: o3d-s36z". o3d-s36z CLOSED on 2026-08-21, and a row\'s realm is now',
    '// QuickBooks sync-processor for what the actual blocker is (o3d-8prh, not the closed o3d-s36z).',
    '// WHAT A QUICKBOOKS BINDING IS WAITING ON HAS CHANGED. It was o3d-s36z,',
  ]) {
    assert.ok(
      !CURRENT_PRECONDITION_CLAIM.test(honest) || HISTORICAL.test(honest),
      `rule 1 must not flag an explicitly historical mention: ${honest}`,
    )
  }

  for (const removedDocLine of [
    'automatic. See *Connecting a different company* below for why the company boundary is the blocker.',
    'the company pin, so a sweep scoped to "the QuickBooks connector" could not tell an id issued by a',
  ]) {
    assert.ok(
      /company (pin|boundary)/i.test(removedDocLine) && BOUNDARY_BLAME.test(removedDocLine),
      `rule 2 must match the help-doc sentence this round removed: ${removedDocLine}`,
    )
    assert.equal(HISTORICAL.test(removedDocLine), false, 'and neither of them marks itself as historical')
  }
  // What rule 2 must NOT flag — the corrected sentence says the same subject is no longer the answer.
  const corrected = '**The company boundary is no longer what is missing.** Every sync row now records which connected'
  assert.ok(HISTORICAL.test(corrected), 'the corrected sentence must read as historical, or rule 2 forbids the fix')

  const newSiteLine = '// Precondition for binding it: the realm-provenance backfill.'
  const newSite = ['// NO back-reference repair sweep for QuickBooks yet.', newSiteLine].join('\n')
  assert.ok(
    PRECONDITION.test(newSiteLine) && !HISTORICAL.test(newSiteLine)
      && QUICKBOOKS.test(newSite) && SWEEP_BINDING.test(newSite),
    'rule 3 must match a BRAND NEW site that never mentions o3d-s36z at all',
  )
  assert.equal(REAL_PREREQUISITE.test(newSite), false)
  // And the sense of "waiting on" that is not a precondition at all must NOT trigger it, or the rule
  // is answered by deleting an unrelated comment.
  assert.equal(PRECONDITION.test('// has a deferred receipt waiting on it.'), false)

  // And the walk reaches the files the offences lived in — a scan over an empty file list would
  // pass every rule above.
  const scanned = new Set(FILES.map((file) => file.rel))
  for (const expected of [
    'app/api/cron/accounting-sync/route.ts',
    'app/actions/quickbooks-sync.ts',
    'help-docs/xero-sync.md',
    'lib/connectors/quickbooks/sync-processor.ts',
    'tests/connectors/quickbooks-manual-sync-repairs.test.ts',
  ]) {
    assert.ok(scanned.has(expected), `the scan must reach ${expected}; it covers ${scanned.size} files`)
  }
})
