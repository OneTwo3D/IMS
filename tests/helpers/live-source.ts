/**
 * ONE RULE, ONE READER: A COMMENT IS NOT CODE.
 *
 * o3d-11rf r15 (Codex r15, HIGH). A standing guard in `tests/db-suite-ci-wiring.test.ts` asserted
 * that CI runs the database suites by searching a workflow job's RAW TEXT for `npm run test:db`.
 * Prefixing that line with `#` left the search satisfied: GitHub then ran no suite, `test:unit`
 * collected the gated tests and skipped them, and the guard stayed green — which is the exact
 * failure the guard exists to prevent.
 *
 * It had been caught on the same rule once already. Round 14 hardened the workflow PATH FILTER
 * reader so that prose and commented-out list entries could not supply coverage, and left the STEP
 * reader greping raw text one field away. One rule, two readers, one fixed. That is why the readers
 * now live HERE, in one module, instead of being re-derived per assertion: the next check that needs
 * to ask "does this actually execute?" imports the answer rather than writing a third regex.
 *
 * Three readers, one for each language the guard has to read:
 *
 *   - `parseWorkflowYaml`   .github/workflows/*.yml -> a structure. Comments are not nodes, so a
 *                           commented-out step, job, or list entry simply does not exist in the
 *                           result. There is nothing left to match against.
 *   - `stripTsComments`     TypeScript, for "this suite really READS the tripwire and throws" —
 *                           a `//`-commented statement and a doc-comment sentence are both prose.
 *   - `stripShellComments`  one `run:` command or npm script, for "this command really runs" —
 *                           `# npm run test:db` inside a `run: |` block executes nothing.
 *
 * WHY A HAND-ROLLED YAML PARSER. This repository declares no YAML dependency, and adding one to
 * satisfy a test would put a parser in the production dependency graph to serve a guard. The subset
 * accepted is the subset GitHub Actions workflows are written in: block mappings, block sequences,
 * plain and quoted scalars, and block scalars (`|`, `>`, with chomping and explicit indentation).
 * Anything outside it — flow collections, anchors, aliases, multi-line plain scalars, tabs — THROWS
 * by name rather than being silently mis-read, because a parser that quietly returns less than the
 * document says turns every "for every X" assertion above it into a loop over nothing.
 *
 * Validated against PyYAML 6.0.2 over all eight checked-in workflows: identical structures, node for
 * node, after normalising YAML 1.1 scalar typing (`on:` -> True, `22` -> int) which this parser
 * deliberately does not do — every scalar stays the string the file contains.
 */

export type YamlNode = string | null | YamlNode[] | YamlMap
export interface YamlMap { [key: string]: YamlNode }

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.\-/]*)\s*:(?:(\s.*)?)$/
const BLOCK_SCALAR_HEADER = /^([|>])([0-9]*)([+-]?)$|^([|>])([+-]?)([0-9]*)$/

function indentOf(line: string): number {
  return /^ */.exec(line)![0].length
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isComment(line: string): boolean {
  return line.trimStart().startsWith('#')
}

/** Blank lines and whole-line comments are not nodes. Outside a block scalar they are skipped. */
function nextSignificant(lines: string[], from: number): number {
  let index = from
  while (index < lines.length && (isBlank(lines[index]) || isComment(lines[index]))) index += 1
  return index
}

/**
 * A plain scalar ends at ` #`, whatever quotes appear inside it — that is YAML's own rule and not a
 * simplification: `run: echo "# x"` really does carry the comment. Quoted scalars are read to their
 * closing quote and whatever follows is discarded.
 */
function parseScalar(text: string, where: string): string {
  if (text.startsWith('"')) {
    let out = ''
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index]
      if (char === '\\') {
        const escaped = text[index + 1]
        index += 1
        if (escaped === 'n') out += '\n'
        else if (escaped === 't') out += '\t'
        else if (escaped === 'r') out += '\r'
        else if (escaped === '0') out += '\0'
        else if (escaped === 'u') { out += String.fromCharCode(parseInt(text.slice(index + 1, index + 5), 16)); index += 4 }
        else out += escaped
        continue
      }
      if (char === '"') return out
      out += char
    }
    throw new Error(`${where}: unterminated double-quoted scalar`)
  }
  if (text.startsWith("'")) {
    let out = ''
    for (let index = 1; index < text.length; index += 1) {
      if (text[index] === "'") {
        if (text[index + 1] === "'") { out += "'"; index += 1; continue }
        return out
      }
      out += text[index]
    }
    throw new Error(`${where}: unterminated single-quoted scalar`)
  }
  const comment = /\s#/.exec(text)
  return (comment ? text.slice(0, comment.index) : text).trimEnd()
}

function readBlockScalar(lines: string[], start: number, parentIndent: number, header: string, where: string):
{ value: string; next: number } {
  const match = BLOCK_SCALAR_HEADER.exec(header)
  if (!match) throw new Error(`${where}: unreadable block scalar header ${JSON.stringify(header)}`)
  const style = match[1] ?? match[4]
  const digits = match[2] || match[6] || ''
  const chomp = match[3] || match[5] || ''

  let contentIndent = digits ? parentIndent + Number(digits) : -1
  if (contentIndent < 0) {
    const first = nextSignificantOrBlankEnd(lines, start + 1)
    if (first >= lines.length || indentOf(lines[first]) <= parentIndent) {
      return { value: chomp === 'keep' ? '\n' : '', next: start + 1 }
    }
    contentIndent = indentOf(lines[first])
  }

  const body: string[] = []
  let index = start + 1
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    if (isBlank(line)) { body.push(''); continue }
    if (indentOf(line) < contentIndent) break
    body.push(line.slice(contentIndent))
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()

  let value: string
  if (style === '|') {
    value = body.join('\n')
  } else {
    // Folded: a line break inside a paragraph becomes a space; a blank line becomes a break.
    value = body
      .join('\n')
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.split('\n').join(' '))
      .join('\n')
  }
  if (body.length > 0 && chomp !== '-') value += '\n'
  return { value, next: index }
}

/** Like `nextSignificant`, but a comment line inside a block scalar is content, not a comment. */
function nextSignificantOrBlankEnd(lines: string[], from: number): number {
  let index = from
  while (index < lines.length && isBlank(lines[index])) index += 1
  return index
}

function parseBlock(lines: string[], start: number, indent: number, where: string): { value: YamlNode; next: number } {
  const seq: YamlNode[] = []
  const map: YamlMap = {}
  let kind: 'seq' | 'map' | null = null
  let index = start

  while (index < lines.length) {
    const line = lines[index]
    if (isBlank(line) || isComment(line)) { index += 1; continue }
    if (/\t/.test(/^\s*/.exec(line)![0])) throw new Error(`${where}: line ${index + 1} is indented with a tab`)
    const at = indentOf(line)
    if (at < indent) break
    if (at > indent) throw new Error(`${where}: line ${index + 1} is indented past its block (a multi-line plain `
      + `scalar is not supported; quote it or use a block scalar): ${JSON.stringify(line)}`)

    const content = line.slice(at)
    if (/^-(\s|$)/.test(content)) {
      if (kind === 'map') throw new Error(`${where}: line ${index + 1} puts a sequence item in a mapping`)
      kind = 'seq'
      const rest = content.slice(1)
      const trimmed = rest.trim()
      if (trimmed === '' || trimmed.startsWith('#')) {
        const following = nextSignificant(lines, index + 1)
        if (following < lines.length && indentOf(lines[following]) > at) {
          const parsed = parseBlock(lines, following, indentOf(lines[following]), where)
          seq.push(parsed.value)
          index = parsed.next
        } else {
          seq.push(null)
          index += 1
        }
        continue
      }
      const itemIndent = at + 1 + (rest.length - rest.trimStart().length)
      if (KEY.test(trimmed) || /^-(\s|$)/.test(trimmed)) {
        // A compact entry: `- key: value` opens a mapping whose block starts at the item's own
        // column, so the dash is blanked out and the block is parsed from there.
        const rewritten = lines.slice()
        rewritten[index] = ' '.repeat(itemIndent) + trimmed
        const parsed = parseBlock(rewritten, index, itemIndent, where)
        seq.push(parsed.value)
        index = parsed.next
        continue
      }
      const blockHeader = BLOCK_SCALAR_HEADER.test(trimmed)
      if (blockHeader) {
        const parsed = readBlockScalar(lines, index, at, trimmed, where)
        seq.push(parsed.value)
        index = parsed.next
        continue
      }
      seq.push(parseScalar(trimmed, `${where}:${index + 1}`))
      index += 1
      continue
    }

    const keyMatch = KEY.exec(content)
    if (!keyMatch) throw new Error(`${where}: line ${index + 1} is neither a sequence item nor a `
      + `key: value pair: ${JSON.stringify(line)}`)
    if (kind === 'seq') throw new Error(`${where}: line ${index + 1} puts a mapping key in a sequence`)
    kind = 'map'
    const key = parseScalar(keyMatch[1], `${where}:${index + 1}`)
    const valueText = (keyMatch[2] ?? '').trim()

    if (valueText === '' || valueText.startsWith('#')) {
      const following = nextSignificant(lines, index + 1)
      if (following < lines.length && indentOf(lines[following]) > at) {
        const parsed = parseBlock(lines, following, indentOf(lines[following]), where)
        map[key] = parsed.value
        index = parsed.next
      } else {
        map[key] = null
        index += 1
      }
      continue
    }
    if (BLOCK_SCALAR_HEADER.test(valueText)) {
      const parsed = readBlockScalar(lines, index, at, valueText, where)
      map[key] = parsed.value
      index = parsed.next
      continue
    }
    map[key] = parseScalar(valueText, `${where}:${index + 1}`)
    index += 1
  }

  if (kind === 'seq') return { value: seq, next: index }
  if (kind === 'map') return { value: map, next: index }
  return { value: null, next: index }
}

/**
 * A GitHub Actions workflow read as a structure. Every scalar comes back as the string the file
 * contains: no YAML 1.1 typing, so `on` stays the key `on` and `22` stays `"22"`.
 */
export function parseWorkflowYaml(source: string, where = 'workflow'): YamlNode {
  if (/^\s*(---|\.\.\.)\s*$/m.test(source)) throw new Error(`${where}: multi-document YAML is not supported`)
  if (/^\s*[^#\s].*[:-]\s+[&*][A-Za-z]/m.test(source)) throw new Error(`${where}: anchors and aliases are not supported`)
  const lines = source.split('\n')
  const first = nextSignificant(lines, 0)
  if (first >= lines.length) return null
  const parsed = parseBlock(lines, first, indentOf(lines[first]), where)
  const trailing = nextSignificant(lines, parsed.next)
  if (trailing < lines.length) throw new Error(`${where}: line ${trailing + 1} was left unparsed: `
    + JSON.stringify(lines[trailing]))
  return parsed.value
}

/** Narrowing helpers, so callers read the tree without casting at every step. */
export function asMap(node: YamlNode): YamlMap | null {
  return node !== null && typeof node === 'object' && !Array.isArray(node) ? node : null
}

export function asSeq(node: YamlNode): YamlNode[] | null {
  return Array.isArray(node) ? node : null
}

export function asString(node: YamlNode): string | null {
  return typeof node === 'string' ? node : null
}

/**
 * TypeScript with its comments replaced by spaces, character for character, so that offsets and line
 * numbers still refer to the original file.
 *
 * String and template literals are preserved — a comment marker inside one is data. Regular
 * expression literals are recognised by the token before the `/`, which is how every JavaScript
 * lexer distinguishes `a / b` from `/a/b`; without it a regex containing `//` would swallow the rest
 * of the line.
 */
export function stripTsComments(source: string): string {
  const out = source.split('')
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== '\n') out[index] = ' '
    }
  }
  const KEYWORDS_BEFORE_REGEX = /(?:^|[^\w$.])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/
  let previousSignificant = ''
  let previousIndex = -1
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      let end = source.indexOf('\n', index)
      if (end < 0) end = source.length
      blank(index, end)
      index = end
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      let end = source.indexOf('*/', index + 2)
      end = end < 0 ? source.length : end + 2
      blank(index, end)
      index = end
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === '\\') { cursor += 2; continue }
        if (source[cursor] === char) break
        cursor += 1
      }
      index = cursor + 1
      previousSignificant = char
      previousIndex = index - 1
      continue
    }
    if (char === '/') {
      const before = source.slice(Math.max(0, previousIndex - 12), previousIndex + 1)
      const regexPosition = previousIndex < 0
        || '=(,:[!&|?{};+-*%^~<>'.includes(previousSignificant)
        || KEYWORDS_BEFORE_REGEX.test(before)
      if (regexPosition) {
        let cursor = index + 1
        let inClass = false
        while (cursor < source.length && source[cursor] !== '\n') {
          if (source[cursor] === '\\') { cursor += 2; continue }
          if (source[cursor] === '[') inClass = true
          else if (source[cursor] === ']') inClass = false
          else if (source[cursor] === '/' && !inClass) break
          cursor += 1
        }
        index = cursor + 1
        previousSignificant = '/'
        previousIndex = index - 1
        continue
      }
    }
    if (!/\s/.test(char)) { previousSignificant = char; previousIndex = index }
    index += 1
  }
  return out.join('')
}

/**
 * One shell command with its comments removed. A `#` opens a comment only where the shell says it
 * does: at the start of a word, outside quotes. `echo a#b` keeps its `#`.
 */
export function stripShellComments(command: string): string {
  let out = ''
  let quote: string | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      out += char
      if (char === '\\' && quote === '"') { out += command[index + 1] ?? ''; index += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '\\') { out += char + (command[index + 1] ?? ''); index += 1; continue }
    if (char === '"' || char === "'") { quote = char; out += char; continue }
    if (char === '#' && (index === 0 || /[\s;&|(]/.test(command[index - 1]))) {
      let end = command.indexOf('\n', index)
      if (end < 0) end = command.length
      index = end - 1
      continue
    }
    out += char
  }
  return out
}

/**
 * The leading `NAME=value` assignments of a shell command — the ones that actually export into the
 * process the command starts. `echo RUN_DB_MIGRATION_TESTS=1` sets nothing, and neither does an
 * assignment written after the command name, so position is the whole question.
 */
export function leadingAssignments(command: string): { assignments: Map<string, string>; rest: string } {
  const assignments = new Map<string, string>()
  let rest = stripShellComments(command).trim()
  for (;;) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)\s+/.exec(rest)
    if (!match) break
    const raw = match[2]
    const value = /^["']/.test(raw) ? raw.slice(1, -1) : raw
    assignments.set(match[1], value)
    rest = rest.slice(match[0].length)
  }
  return { assignments, rest }
}

/**
 * One shell script split into the commands it runs, each as its words with quoting removed.
 *
 * WHY WORDS AND NOT A SEARCH. `echo "npm run test:db"` contains the command and runs nothing —
 * removing comments is not enough, because an ARGUMENT is text that never executes either. Splitting
 * into words puts the question where it belongs: is this string in COMMAND POSITION, or is it
 * something a command was handed? A quoted argument stays one word and can never match a multi-word
 * invocation; an unquoted one is a word whose predecessor is `echo`, and `echo` is not a wrapper.
 *
 * The subset is the one CI `run:` scripts and npm scripts are written in: words, quotes, escapes,
 * and the separators `;` `&&` `||` `|` `&` and newline. Redirections and substitutions are left
 * inside the words they appear in — they cannot turn a non-invocation into one.
 */
export function shellCommands(script: string): string[][] {
  const commands: string[][] = []
  const text = stripShellComments(script)
  let words: string[] = []
  let current = ''
  let started = false
  let quote: string | null = null
  const endWord = (): void => {
    if (started) { words.push(current); current = ''; started = false }
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\' && quote === '"') { current += text[index + 1] ?? ''; index += 1; started = true; continue }
      if (char === quote) { quote = null; continue }
      current += char
      started = true
      continue
    }
    if (char === '\\') { current += text[index + 1] ?? ''; index += 1; started = true; continue }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    if (char === ';' || char === '&' || char === '|') {
      endCommand()
      if (text[index + 1] === char) index += 1
      continue
    }
    if (/\s/.test(char)) {
      if (char === '\n') endCommand()
      else endWord()
      continue
    }
    current += char
    started = true
  }
  endCommand()
  return commands
}

/** Programs that stand in front of the real command without changing what is being invoked. */
const WRAPPERS = new Set(['npx', 'pnpm', 'yarn', 'bun', 'bunx', 'sudo', 'env', 'time', 'nice', 'exec',
  'command', 'cross-env', 'dotenv', 'xvfb-run', 'node_modules/.bin/npx'])

/**
 * Whether one command's words really INVOKE `sequence` — the words appearing consecutively in
 * command position, reached past nothing but leading assignments, option flags and known wrappers.
 * `npx prisma migrate deploy` invokes `prisma migrate deploy`; `echo prisma migrate deploy` does not.
 */
export function invokes(words: string[], sequence: string[]): boolean {
  for (let start = 0; start + sequence.length <= words.length; start += 1) {
    if (!sequence.every((word, offset) => words[start + offset] === word)) continue
    const before = words.slice(0, start)
    if (before.every((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word.startsWith('-') || WRAPPERS.has(word))) {
      return true
    }
  }
  return false
}

/** Whether a whole script (a `run:` block, an npm script) invokes `sequence` in any of its commands. */
export function scriptInvokes(script: string, sequence: string[]): boolean {
  return shellCommands(script).some((words) => invokes(words, sequence))
}
