/**
 * LIFTING ONE SHELL SYMBOL OUT OF A SCRIPT — AND PROVING IT IS THE ONE BASH WOULD RUN (o3d-rn10 r4).
 *
 * Every harness in this directory runs SHIPPED text rather than a re-implementation, which means
 * every harness has to cut that text out of the file. Both cuts used to take the FIRST match:
 * `indexOf('\nname() {\n')` for a function, `lines.find(l => l.startsWith('NAME='))` for a
 * constant. Bash does not work that way. A later definition REPLACES an earlier one, so appending
 *
 *     publish_root_anchored() { return 0; }
 *
 * to scripts/deploy.sh left the byte-identity test comparing install.sh's canonical body against
 * deploy.sh's canonical body — passing — while deploy.sh itself ran the stub. Codex confirmed it
 * in memory: two definitions, `mutatedStillEqual: true`. The behavioural rigs cut the same way, so
 * they would have run the canonical copy too, and measured a function the entrypoint had stopped
 * using.
 *
 * SO UNIQUENESS IS ASSERTED BEFORE ANYTHING IS COMPARED. A comparison over a symbol defined twice
 * is meaningless whichever copy it picks; there is no reading of "these two files carry the same
 * publisher" that survives one of them carrying two publishers.
 *
 * WHAT COUNTS AS A DEFINITION. Every `name()`, `function name()` and `function name` form bash
 * accepts, at ANY indentation — a definition nested inside another function is still effective the
 * moment that function runs, so it cannot be waved through for sitting in column 4. Exactly one
 * must be found, and it must be at column 0 in the canonical `name() {` shape, because that is the
 * only shape the `}`-in-column-0 slice below can cut correctly.
 *
 * AND THE BODY MAY FOLLOW ON THE SAME LINE, WHICH THIS MISSED (o3d-rn10 r5, Codex MEDIUM). The
 * first version of the detector anchored the header to the END of the line right after the
 * optional `{`, so it saw `name() {` and `function name {` and nothing else. Bash also accepts
 *
 *     publish_root_anchored() { return 0; }
 *     function publish_root_anchored { return 0; }
 *     if true; then publish_root_anchored() { return 0; }; fi
 *
 * and a ONE-LINE override is exactly the shape an appended duplicate takes — which is to say the
 * guard added to catch duplicates could not see the cheapest duplicate there is. Counting stayed
 * at one, shellFunction() went on slicing the canonical body, and the parity comparison it feeds
 * stayed as vacuous as it was before the guard existed.
 *
 * SO THE HEADER IS LOOKED FOR IN COMMAND POSITION ANYWHERE ON THE LINE, and what follows it may be
 * a body rather than an end of line. Command position is the start of the line, or a `;`, `&`,
 * `|`, `(`, `)`, `{` or `}`, or one of the control words a command can follow (`then`, `else`,
 * `do`) — which is also what keeps the scan off the text a line MENTIONS: a trailing `# ...` puts
 * a `#` immediately before the header, and `#` is not a command separator, so a comment that
 * quotes a definition is not counted as one. Whole-line comments are skipped as before.
 *
 * WHAT COUNTS AS AN ASSIGNMENT. A top-level `NAME=`, with or without an `export`, `readonly`,
 * `declare` or `typeset` in front of it. Indented assignments are NOT counted: `local NAME=` and a
 * branch inside a function are ordinary shell, and a rule that banned them would ban the language.
 * The bypass this closes is a second top-level assignment, which is what a pasted copy looks like.
 */
import assert from 'node:assert/strict'

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every line index at which `source` defines `name` as a function, in any form bash accepts — one
 * entry PER DEFINITION, so two on a single line are two.
 */
export function shellFunctionDefinitions(source: string, name: string): number[] {
  const escaped = escapeForRegExp(name)
  // `name()`, `name ()`, `function name()`, `function name`.
  const header = `(?:function\\s+${escaped}\\s*(?:\\(\\s*\\))?|${escaped}\\s*\\(\\s*\\))`
  // COMMAND POSITION, then the header, then either the `{` — with or without a body behind it —
  // or the end of the line, because the brace may open on the next one.
  const shape = new RegExp(`(?:^|[;&|(){}]|\\b(?:then|else|do)\\b)[ \\t]*${header}[ \\t]*(?:\\{|$)`, 'g')
  const found: number[] = []
  source.split('\n').forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return
    for (const _match of line.matchAll(shape)) found.push(index)
  })
  return found
}

/** Every line index at which `source` assigns `name` at top level (column 0). */
export function shellConstantAssignments(source: string, name: string): number[] {
  const escaped = escapeForRegExp(name)
  const shape = new RegExp(`^(?:(?:export|readonly|declare|typeset)\\s+(?:-\\w+\\s+)*)?${escaped}=`)
  const found: number[] = []
  source.split('\n').forEach((line, index) => {
    if (shape.test(line)) found.push(index)
  })
  return found
}

/**
 * The text of the one top-level shell function `name`, from `name() {` to the `}` in column 0.
 *
 * Throws if the script defines it a number of times other than once — see the header: the whole
 * point of lifting shipped text is to run what the script runs.
 */
export function shellFunction(source: string, name: string, where = 'the script'): string {
  const definitions = shellFunctionDefinitions(source, name)
  assert.notEqual(definitions.length, 0, `${where} must define ${name}()`)
  assert.equal(definitions.length, 1,
    `${where} defines ${name}() ${definitions.length} times, at lines ${definitions.map((l) => l + 1).join(', ')}. `
    + 'Bash runs the LAST one; a harness that lifts the first would measure code the script no longer executes, '
    + 'and a byte-identity comparison over it would pass while the entrypoint ran something else.')
  const lines = source.split('\n')
  assert.equal(lines[definitions[0]], `${name}() {`,
    `${where}: ${name}() must be defined at column 0 in the form \`${name}() {\`, which is what the `
    + `\`}\`-in-column-0 slice can cut. Found: ${JSON.stringify(lines[definitions[0]])}`)
  const start = source.indexOf(`\n${name}() {\n`)
  assert.notEqual(start, -1, `${where} must define ${name}()`)
  const rest = source.slice(start + 1)
  const end = rest.indexOf('\n}\n')
  assert.notEqual(end, -1, `${name}() must be closed by a } in column 0`)
  return rest.slice(0, end + 2)
}

/**
 * The one `NAME="value"` assignment in column 0, lifted rather than re-typed — and asserted to be
 * the only one, for the reason {@link shellFunction} gives.
 */
export function shellConstant(source: string, name: string, where = 'the script'): string {
  const line = shellConstantOptional(source, name, where)
  assert.ok(line, `${where} must define ${name} on one line`)
  return line
}

/** As {@link shellConstant}, but `undefined` when the script does not assign it at all. Still
 *  refuses a second assignment: "some other file defines it" is not "this file defines it twice". */
export function shellConstantOptional(source: string, name: string, where = 'the script'): string | undefined {
  const assignments = shellConstantAssignments(source, name)
  assert.ok(assignments.length <= 1,
    `${where} assigns ${name} ${assignments.length} times, at lines ${assignments.map((l) => l + 1).join(', ')}. `
    + 'Bash keeps the LAST assignment; a harness that lifts the first would run the script with a value '
    + 'the script itself no longer has.')
  if (assignments.length === 0) return undefined
  return source.split('\n')[assignments[0]]
}
