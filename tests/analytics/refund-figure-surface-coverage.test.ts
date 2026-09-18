import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import * as refundFigureSurfacesModule from '@/lib/analytics/refund-figure-surfaces'
import { REFUND_FIGURE_SURFACES, refundFigureSurface } from '@/lib/analytics/refund-figure-surfaces'

/**
 * The exported disclosure constants, read back from the module so this test's idea of them cannot
 * silently disagree with what the producers import.
 */
const DISCLOSURE_CONSTANTS: Record<string, string> = Object.fromEntries(
  Object.entries(refundFigureSurfacesModule)
    .filter(([key, value]) => key.startsWith('REFUND_BLIND_NOTICE_') && typeof value === 'string'),
) as Record<string, string>

/**
 * o3d-iigc round 5: THE MECHANISM THAT MAKES A SEVENTH SURFACE FAIL INSTEAD OF SHIP.
 *
 * Four rounds each declared their enumeration complete; four rounds each missed one. Rounds 1-4
 * searched by RELATIONSHIP — importers, callers, producers — and a surface participating in no
 * relationship the searcher traversed is simply invisible to that search. Round 4's miss is the
 * clearest case: `topProducts.netRevenue` sat INSIDE a file round 4 had open and edited.
 *
 * So this test sweeps by FIELD NAME. Every identifier in app/, lib/, components/ and scripts/ whose
 * name contains a figure word — DECLARED (`netRevenue:`), READ (`row.netRevenue`, which is the
 * consumer half nobody had swept), or QUOTED (`'netRevenue'`, which is how a CSV names a column) —
 * must appear in the pinned inventory with a treatment and a reason. A new one fails this test,
 * named, and the only way to green is to write down what it does about refunds.
 *
 * It is pinned per (file, figure) rather than per file ON PURPOSE, because a per-file pin would
 * have let round 4's miss through: `dashboard.ts` was already listed.
 *
 * Modelled on tests/security/server-action-guard-coverage.test.ts, which does the same job for
 * unguarded server actions.
 */

const ROOTS = ['app', 'lib', 'components', 'scripts']
const SKIP_DIRS = new Set(['node_modules', '.next', 'generated'])
/**
 * The inventory excludes ITSELF, and only itself. It quotes every figure name in the tree by
 * construction, so sweeping it would make the inventory its own largest surface and the failure
 * message unreadable. It is data about figures, not a producer of one — a property the import-free
 * test below keeps true, since a figure would have to be computed from something.
 */
const INVENTORY_FILE = 'lib/analytics/refund-figure-surfaces.ts'

/**
 * The figure vocabulary. Deliberately broad: it matches PDF page margins and Xero ledger fields
 * too, and those are listed in the inventory as `not-refund-sensitive` with a reason. Deciding what
 * is "obviously not a figure" BEFORE looking at it is how the previous four sweeps went wrong.
 */
const FIGURE_WORDS = /(revenue|profit|margin|netsales|nettotal|netamount|netvalue|avgorder|averageorder|grosssales|turnover)/i
/** `aov` needs its own boundary-aware test, or `deltaOverlapSeconds` matches on "…lt`aOv`erlap…". */
const AOV = /(^|[^a-z])aov([^a-z]|$)/i

function isFigureName(name: string): boolean {
  return FIGURE_WORDS.test(name) || AOV.test(name)
}

/**
 * PascalCase names — types, React components, classes — are excluded. A new figure TYPE always
 * arrives with figure FIELDS, which this sweep does catch, so nothing is lost and the inventory
 * stays about figures rather than about declarations.
 */
function isTypeLikeName(name: string): boolean {
  return /^[A-Z]/.test(name)
}

const MATCHERS: RegExp[] = [
  /(?:^|[\s{,(])([A-Za-z_$][\w$]*)\s*[:?]/g,          // an object/type member being DECLARED
  /(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g, // a binding being DECLARED
  /\.([A-Za-z_$][\w$]*)/g,                            // a member being READ — the consumer half
  /['"]([A-Za-z_$][\w$]*)['"]/g,                      // a quoted column key — how a CSV names one
]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function sweep(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  for (const root of ROOTS) {
    const dir = path.join(process.cwd(), root)
    let files: string[]
    try { files = sourceFiles(dir) } catch { continue }
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const names = new Set<string>()
      for (const matcher of MATCHERS) {
        matcher.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = matcher.exec(source))) {
          const name = match[1]
          if (name && isFigureName(name) && !isTypeLikeName(name)) names.add(name)
        }
      }
      const relative = path.relative(process.cwd(), file).split(path.sep).join('/')
      if (names.size > 0 && relative !== INVENTORY_FILE) found.set(relative, names)
    }
  }
  return found
}

const FOUND = sweep()

test('the sweep finds something at all, so a green run is not an empty one', () => {
  // If a refactor or a regex slip made the sweep match nothing, every assertion below would pass
  // vacuously and the mechanism would be a placebo. Pin the shape of a real result instead.
  assert.ok(FOUND.size >= 40, `the field-name sweep matched only ${FOUND.size} files`)
  assert.ok(FOUND.get('app/actions/dashboard.ts')?.has('netRevenue'), 'the round-5 finding itself must be findable')
  assert.ok(FOUND.get('app/actions/sales-stats.ts')?.has('avgMarginPct'))
  assert.ok(
    FOUND.get('app/(dashboard)/analytics/margin/page.tsx')?.has('revenueBase'),
    'a CONSUMER that only READS a figure must be found — that half was never swept before',
  )
})

test('every figure the sweep finds is declared in the pinned inventory (o3d-iigc r5)', () => {
  const undeclared: string[] = []
  for (const [file, figures] of FOUND) {
    const surface = refundFigureSurface(file)
    if (!surface) {
      undeclared.push(`${file} (whole file, figures: ${[...figures].sort().join(', ')})`)
      continue
    }
    for (const figure of [...figures].sort()) {
      if (!surface.figures.includes(figure)) undeclared.push(`${file}: ${figure}`)
    }
  }
  assert.deepEqual(undeclared, [], [
    'A revenue/profit/margin/net/aov figure exists that no one has said anything about.',
    'Add it to REFUND_FIGURE_SURFACES in lib/analytics/refund-figure-surfaces.ts with a treatment',
    'and a reason: does this figure net off refunds by their stamped basis (basis-aware), is it',
    'deliberately refund-blind (and if a reader could mistake it for a net figure, what disclosure',
    'do they see?), or can no refund move it at all (not-refund-sensitive)?',
  ].join(' '))
})

test('the inventory has no stale entries, so it cannot rot into a rubber stamp (o3d-iigc r5)', () => {
  const stale: string[] = []
  for (const surface of REFUND_FIGURE_SURFACES) {
    const figures = FOUND.get(surface.file)
    if (!figures) { stale.push(`${surface.file} (no longer contains any figure name)`); continue }
    for (const figure of surface.figures) {
      if (!figures.has(figure)) stale.push(`${surface.file}: ${figure}`)
    }
  }
  assert.deepEqual(stale, [], 'Remove these from REFUND_FIGURE_SURFACES — they no longer exist in the tree.')
})

test('every entry carries a reason, and a refund-blind one that needs a disclosure has it (o3d-iigc r5)', () => {
  const problems: string[] = []
  for (const surface of REFUND_FIGURE_SURFACES) {
    if (surface.reason.trim().length < 20) problems.push(`${surface.file}: reason is not an explanation`)
    if (surface.disclosure) {
      if (surface.treatment !== 'refund-blind') {
        problems.push(`${surface.file}: only a refund-blind figure needs a disclosure`)
        continue
      }
      const source = readFileSync(path.join(process.cwd(), surface.file), 'utf8')
      // The producer/consumer imports the disclosure CONSTANT rather than copying the sentence, so
      // the page, the CSV and the inventory cannot drift apart on what the figure means. Asserting
      // on the constant's NAME is therefore what proves the string reaches the reader.
      const constantName = Object.entries(DISCLOSURE_CONSTANTS).find(([, v]) => v === surface.disclosure)?.[0]
      if (!constantName) { problems.push(`${surface.file}: disclosure is not one of the exported constants`); continue }
      // At least TWICE: once to import it, once to USE it. Counting a single occurrence would let a
      // producer keep the import while deleting the notice from the payload — which is exactly what
      // a mutation of this test found it doing.
      const uses = source.split(constantName).length - 1
      if (uses < 2) {
        problems.push(`${surface.file}: declared refund-blind with a disclosure, but ${constantName} is imported ${uses} time(s) and never used`)
      }
    }
  }
  assert.deepEqual(problems, [])
})

test('the three sales-analytics reports say WHICH credit was deducted, where they are read (o3d-kyey)', async () => {
  // Not "a constant is referenced" but "the sentence is in the payload the page renders".
  //
  // o3d-iigc round 5 asserted the opposite of this: that all three carried "Refunds are NOT
  // deducted". o3d-kyey made them basis-aware, so the assertion has to change with them — and the
  // thing it now pins is the property that replaced blindness. "Net of refunds" with no basis named
  // is precisely the ambiguity that produced the original defect, so each sentence must NAME the
  // basis of the credit it took off, and must not still be claiming that none was taken off.
  const {
    REFUND_BASIS_NOTICE_CUSTOMER_MIX, REFUND_BASIS_NOTICE_GROSS_MARGIN, REFUND_BASIS_NOTICE_SALES,
  } = await import('@/lib/analytics/refund-figure-surfaces')
  const analytics = readFileSync(path.join(process.cwd(), 'lib/domain/sales/sales-fulfillment-analytics.ts'), 'utf8')

  for (const [name, notice] of [
    ['REFUND_BASIS_NOTICE_SALES', REFUND_BASIS_NOTICE_SALES],
    ['REFUND_BASIS_NOTICE_CUSTOMER_MIX', REFUND_BASIS_NOTICE_CUSTOMER_MIX],
    ['REFUND_BASIS_NOTICE_GROSS_MARGIN', REFUND_BASIS_NOTICE_GROSS_MARGIN],
  ] as const) {
    assert.match(notice, /basis/, `${name} must name the basis of the credit it deducted`)
    assert.doesNotMatch(notice, /Refunds are NOT deducted/, `${name} still claims the report is refund-blind`)
    // Twice — imported AND used. See the note on the same rule above: an import alone reaches nobody.
    assert.ok(analytics.split(name).length - 1 >= 2, `${name} must be in the notices of the report it describes`)
  }
})

test('the COGS report says WHICH credit was deducted, where it is read (o3d-rv4a)', async () => {
  // o3d-iigc round 5 asserted the opposite of this — that this report carried "Refunds are NOT
  // deducted" — and o3d-kyey's three siblings had the same assertion flipped when they were fixed.
  // The COGS report is now basis-aware too, so what this pins is the property that replaced
  // blindness: the notice must NAME the basis of the credit it took off, and must not still be
  // claiming that none was taken off.
  const { REFUND_BASIS_NOTICE_COGS_MARGIN } = await import('@/lib/analytics/refund-figure-surfaces')
  assert.match(REFUND_BASIS_NOTICE_COGS_MARGIN, /net-basis credit/)
  assert.doesNotMatch(REFUND_BASIS_NOTICE_COGS_MARGIN, /Refunds are NOT deducted/)
  const costing = readFileSync(path.join(process.cwd(), 'lib/domain/inventory/inventory-costing-reports.ts'), 'utf8')
  // Twice — imported AND used. An import alone reaches nobody. See the same rule above.
  assert.ok(costing.split('REFUND_BASIS_NOTICE_COGS_MARGIN').length - 1 >= 2)
})

/**
 * THE STALE ROUND-5 DISCLOSURE IS GONE, AS A UNIVERSAL CLAIM OVER THE TREE.
 *
 * A whole-file `includes` of the NEW text is EXISTENTIAL and therefore blind to the one failure that
 * actually happens: the correction lands, the superseded sentence stays where it was, and both are on
 * screen at once. Only an ABSENCE check is universal, so only an absence check can say the old claim
 * is not standing beside the new one.
 *
 * Swept over source AND the operator documentation, because a disclosure the docs still make is a
 * disclosure the reader still gets.
 */
const STALE_COGS_REFUND_CLAIMS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /REFUND_BLIND_NOTICE_COGS_MARGIN/, what: 'the renamed round-5 constant' },
  { pattern: /refunds are not deducted/i, what: 'the round-5 refund-blind sentence' },
  { pattern: /keeps its full revenue and margin/i, what: "round 5's worked consequence of the blindness" },
  { pattern: /remains? refund-blind/i, what: 'a prose claim that this report is still blind' },
  { pattern: /refund-aware net revenue/i, what: "round 5's redirect to another report for a net figure" },
]

/** Every file that could carry the claim about THIS report. Listed, so the walk is checkable. */
const COGS_DISCLOSURE_FILES = [
  'lib/domain/inventory/inventory-costing-reports.ts',
  'lib/analytics/refund-figure-surfaces.ts',
  'app/(dashboard)/analytics/cogs/page.tsx',
  'app/api/export/inventory-costing/route.ts',
  'help-docs/analytics.md',
]

/** The two pinned entries that named this report, and the page/route that publish it. */
const COGS_SURFACE_FILES = [
  'lib/domain/inventory/inventory-costing-reports.ts',
  'app/(dashboard)/analytics/cogs/page.tsx',
  'app/api/export/inventory-costing/route.ts',
]

test('no stale refund-blind claim about the COGS report survives anywhere (o3d-rv4a)', () => {
  const read = new Map<string, string>()
  for (const file of COGS_DISCLOSURE_FILES) {
    read.set(file, readFileSync(path.join(process.cwd(), file), 'utf8'))
  }
  // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED. A rig that read nothing would report no stale
  // claims and be a placebo. Prove the walk reached real content, and prove the MATCHERS CAN FIRE by
  // running them against the round-5 sentence itself — if the rig cannot find the thing it is looking
  // for when it is present, its silence establishes nothing.
  assert.equal(read.size, COGS_DISCLOSURE_FILES.length, 'every listed file must have been read')
  for (const [file, source] of read) {
    assert.ok(source.length > 500, `${file} was read as ${source.length} bytes — the walk did not reach it`)
  }
  const roundFiveNotice =
    'Refunds are NOT deducted: revenue and gross margin are attributed from the original sales line '
    + 'behind each dispatch, so a returned sale keeps its full revenue and margin in this report. '
    + 'Use Sales Statistics for a refund-aware net revenue.'
  const firing = STALE_COGS_REFUND_CLAIMS.filter(({ pattern }) => pattern.test(roundFiveNotice)).map(({ what }) => what)
  assert.equal(firing.length, 3, `matchers firing on the round-5 notice: ${firing.join('; ') || '(none)'}`)
  assert.ok(STALE_COGS_REFUND_CLAIMS.some(({ pattern }) => pattern.test('REFUND_BLIND_NOTICE_COGS_MARGIN')))
  assert.ok(STALE_COGS_REFUND_CLAIMS.some(({ pattern }) => pattern.test('The COGS Report remains refund-blind (see above).')))

  const offenders: string[] = []
  let linesScanned = 0
  for (const [file, source] of read) {
    const lines = source.split('\n')
    linesScanned += lines.length
    for (const [index, line] of lines.entries()) {
      for (const { pattern, what } of STALE_COGS_REFUND_CLAIMS) {
        if (pattern.test(line)) offenders.push(`${file}:${index + 1} ${what} — ${line.trim().slice(0, 160)}`)
      }
    }
  }
  assert.ok(linesScanned > 2000, `only ${linesScanned} lines were scanned`)
  assert.deepEqual(offenders, [], [
    `o3d-rv4a made the COGS report refund-aware (${linesScanned} lines scanned).`,
    'A superseded disclosure left standing beside the correction tells the reader the opposite of what',
    'the report now does, and it is invisible to any check that merely looks for the new text. Delete',
    'the line, or if a COGS figure really did go back to being refund-blind, change',
    'REFUND_FIGURE_SURFACES and this list together.',
  ].join(' '))
})

test('the pinned COGS entries are no longer refund-blind and carry no disclosure (o3d-rv4a)', () => {
  // The text sweep above cannot say this: `refund-blind` is a legitimate treatment elsewhere in the
  // inventory, so a per-line grep of that file would either miss this or fire on other surfaces. The
  // pin is DATA, so assert on the data.
  for (const file of COGS_SURFACE_FILES) {
    const surface = refundFigureSurface(file)
    assert.ok(surface, `${file} must still be pinned`)
    assert.equal(surface.treatment, 'basis-aware', `${file} is pinned ${surface.treatment}`)
    assert.equal(surface.disclosure, undefined, `${file} still carries a refund-blind disclosure`)
  }
})

test('the client-safe modules stay import-free (o3d-iigc r4/r5)', () => {
  // Round 4's build failed outright when three client components pulled the analytics module — and
  // Decimal with it — into the browser chunk. The fix was two dependency-free modules, and until now
  // the only thing protecting that property was a comment saying so.
  for (const file of ['lib/domain/sales/derived-figure-bound.ts', 'lib/analytics/refund-figure-surfaces.ts']) {
    const source = readFileSync(path.join(process.cwd(), file), 'utf8')
    const offenders = source
      .split('\n')
      .filter((l) => /^\s*(import|export)\s.*\sfrom\s/.test(l) || /\brequire\(/.test(l))
    assert.deepEqual(offenders, [], `${file} must stay import-free — that is what makes it safe to import from a client component`)
  }
})
