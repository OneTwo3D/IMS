#!/usr/bin/env node

/**
 * Static guard: "what does one unit of this sales line require" is asked THROUGH THE SNAPSHOT SEAM,
 * never by expanding the current component graph directly (o3d-4gh9).
 *
 * WHAT IT IS DEFENDING. Everything IMS knows about a line's component requirements used to be
 * derived, on every read, by expanding the CURRENT graph — so a component-graph edit did not change
 * the future, it retroactively changed the past and the in-flight present. o3d-kouj fixed that by
 * PINNING the expansion onto the line at allocation time and putting one seam in front of every
 * reader: `lineFulfillmentRequirements` (and its scaled and leaf-id siblings) answer from the pin
 * when the line has one and from the live graph when it does not.
 *
 * o3d-kouj's own stated reason for deferring the last readers was that A PARTIAL ROLLOUT IS WORSE
 * THAN NONE: snapshot-aware and live-graph readers disagree about the same order, and both report
 * figures, so the wrong answer is quiet. o3d-4gh9 is what that deferral cost — two analytics sites
 * left on the current graph for six weeks while a third beside them read the pin.
 *
 * THE RULE. Outside the two modules that own the expansion, `expandFulfillmentRequirementsDecimal`
 * and `listFulfillmentLeafProductIds` may not be CALLED. Callers ask the seam in
 * lib/products/fulfillment-requirement-snapshot.ts instead, which needs `fulfillmentRequirements` on
 * the line — so "I do not have the line here" is a reason to thread the line through, which is
 * exactly the decision o3d-4gh9 says has to be made rather than defaulted.
 *
 * IT READS CALLS, NOT MENTIONS. The check walks the TypeScript AST for call expressions, so a
 * docstring naming the function neither triggers it nor satisfies it, and an `import` with no call
 * is invisible to it.
 *
 * THE REMAINING CURRENT-GRAPH READERS ARE ENUMERATED WITH A COUNT AND A TICKET, not waived by a
 * comment. Adding a call to an allowlisted file fails just as loudly as adding one to a new file,
 * and REMOVING one fails too — so the allowlist has to shrink when a ticket is closed instead of
 * quietly outliving it.
 *
 * Run via `npm run check:fulfillment-requirement-seam`; invoked by `npm run check:all`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const SCAN_ROOTS = ['app', 'lib', 'components', 'scripts']
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx'])
const SKIPPED_DIRECTORIES = new Set(['.git', '.next', 'node_modules', 'build', 'dist', 'out', 'coverage', 'generated'])

/** The current-graph expanders. Calling one is a claim that the CURRENT recipe is the authority. */
const CURRENT_GRAPH_EXPANDERS = new Set([
  'expandFulfillmentRequirementsDecimal',
  'listFulfillmentLeafProductIds',
])

/**
 * Where they may be called: the module that DEFINES them, and the seam that decides between the pin
 * and them. Nothing else, ever — a third owner would be a second answer to one question.
 */
const OWNERS = [
  'lib/products/kit-fulfillment.ts',
  'lib/products/fulfillment-requirement-snapshot.ts',
]

/**
 * The readers that still expand the current graph, each with the issue that owns it and the EXACT
 * number of calls it makes today.
 *
 * Both were found by o3d-4gh9 and deliberately not changed by it: one posts to an accounting ledger
 * and one decides whether a fulfilment is short, so each is a reported-figures or a posting change
 * that belongs to its own issue rather than being buried in this one. The count is what stops the
 * entry from being a licence: a third call in either file fails this check.
 */
const KNOWN_CURRENT_GRAPH_READERS = [
  {
    file: 'lib/fulfillment/external-fulfillment.ts',
    calls: 2,
    issue: 'o3d-4gw0',
    why: 'the shortfall calculation expands a sales line AND an unlinked refund line; the refund line '
      + 'has no pin of its own and reaching its sales line is a threading change with a shipment-refusal '
      + 'blast radius.',
  },
  {
    file: 'lib/connectors/quickbooks/daily-sync.ts',
    calls: 1,
    issue: 'o3d-moc9',
    why: 'the Group B revenue split; the Xero port of the same computation already reads the pin '
      + '(lib/connectors/xero/daily-sync.ts), so this is a cross-port divergence in a posting path.',
  },
]

function listFiles(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) listFiles(full, out)
    else if (SCANNED_EXTENSIONS.has(extname(full))) out.push(full)
  }
  return out
}

/**
 * Local name -> IMPORTED name, for every named import in a file.
 *
 * WHY THIS IS NOT OPTIONAL, and it was found by mutating this guard rather than by reasoning about
 * it. The first spelling compared the callee's own identifier against the fenced names, and
 * `import { expandFulfillmentRequirementsDecimal as probeExpand }` walked straight past it: the call
 * reads `probeExpand(...)`, the guard saw a name it did not recognise, and the check reported OK
 * over exactly the thing it exists to forbid. A guard that can be switched off by an `as` clause is
 * not a guard, and no amount of reading it would have said so — the mutation did.
 */
function importAliases(source) {
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
function calleeName(node, aliases) {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return aliases.get(callee.text) ?? callee.text
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text
  return null
}

const files = []
for (const root of SCAN_ROOTS) {
  const full = join(ROOT, root)
  try {
    if (statSync(full).isDirectory()) listFiles(full, files)
  } catch {
    // A scan root that does not exist in this checkout is not this guard's business.
  }
}

const callsByFile = new Map()
let ownerCalls = 0

for (const file of files) {
  const relativePath = relative(ROOT, file).split(sep).join('/')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const aliases = importAliases(source)
  const visit = (node) => {
    const called = ts.isCallExpression(node) ? calleeName(node, aliases) : null
    if (called !== null && CURRENT_GRAPH_EXPANDERS.has(called)) {
      if (OWNERS.includes(relativePath)) ownerCalls += 1
      else {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        const found = callsByFile.get(relativePath) ?? []
        found.push({ line, name: called })
        callsByFile.set(relativePath, found)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

const violations = []

for (const [file, calls] of callsByFile) {
  const known = KNOWN_CURRENT_GRAPH_READERS.find((entry) => entry.file === file)
  if (!known) {
    for (const call of calls) {
      violations.push(
        `${file}:${call.line}  \`${call.name}\` expands the CURRENT component graph. Ask the snapshot `
        + 'seam instead — lineFulfillmentRequirements(line, graph), lineFulfillmentRequirementQuantities '
        + '(scaled) or lineFulfillmentLeafProductIds — and select `fulfillmentRequirements` on the line. '
        + 'If the line is genuinely not available here, thread it through; do not default to the live '
        + 'graph, because that answer is a figure and a wrong figure here is silent.',
      )
    }
  } else if (calls.length !== known.calls) {
    violations.push(
      `${file}  makes ${calls.length} current-graph expansion(s), but ${known.issue} records ${known.calls}. `
      + (calls.length > known.calls
        ? `A new one was added (lines ${calls.map((call) => call.line).join(', ')}); route it through the snapshot seam.`
        : 'One was removed — update or delete the entry in KNOWN_CURRENT_GRAPH_READERS so the allowlist '
          + 'shrinks with the work rather than outliving it.'),
    )
  }
}

for (const known of KNOWN_CURRENT_GRAPH_READERS) {
  if (!callsByFile.has(known.file)) {
    violations.push(
      `${known.file}  is allowlisted under ${known.issue} but makes NO current-graph expansion any more. `
      + 'Delete its entry from KNOWN_CURRENT_GRAPH_READERS and close the issue.',
    )
  }
}

// ---------------------------------------------------------------------------
// PROVE THE WALK REACHED SOMETHING. A guard that scanned nothing, or whose subject was renamed out
// from under it, passes every file in the repository without reading a line of it.
// ---------------------------------------------------------------------------
const structural = []
if (files.length === 0) structural.push(`scanned 0 files under ${SCAN_ROOTS.join(', ')}`)
if (ownerCalls === 0) {
  structural.push(
    `found 0 calls to ${[...CURRENT_GRAPH_EXPANDERS].join('/')} inside ${OWNERS.join(' or ')} — `
    + 'the expander or the seam was renamed, so this check is looking for a function nobody calls',
  )
}

if (structural.length > 0) {
  console.error('check:fulfillment-requirement-seam could not verify itself:')
  for (const problem of structural) console.error(`  - ${problem}`)
  console.error('\nThis check is only meaningful while it can see the expansion it is fencing off.')
  process.exit(1)
}

if (violations.length > 0) {
  console.error(`check:fulfillment-requirement-seam found ${violations.length} problem(s):\n`)
  for (const violation of violations) console.error(`  - ${violation}`)
  console.error('\nWhy this is refused: a component-graph edit must not retroactively change what an')
  console.error('order required. o3d-kouj pinned that per line and put ONE seam in front of every reader;')
  console.error('o3d-4gh9 is what two readers left behind it cost — six weeks of margin and returns')
  console.error('figures computed from components the orders never required, reported without an error.')
  process.exit(1)
}

console.log(
  `check:fulfillment-requirement-seam OK — ${files.length} files, ${ownerCalls} owning call(s), `
  + `${KNOWN_CURRENT_GRAPH_READERS.length} allowlisted current-graph reader(s) at their recorded counts.`,
)
