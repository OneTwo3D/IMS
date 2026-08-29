#!/usr/bin/env node

/**
 * o3d-o8cp — fail when a documented environment variable is read by nothing.
 *
 * o3d-9tbz found one documented-but-unread setting; the o3d-esha sweep found 16
 * more. The shape recurs because nothing compares the two lists: a variable is
 * added to .env.example or the CLAUDE.md table during a change that ends up
 * wired differently, and the operator who sets it believes a control exists.
 *
 * FALSE POSITIVES ARE THE FAILURE MODE HERE. A prior guard in this repo fired
 * twice on words like `psql` and `prisma migrate` picked out of doc comments,
 * and a check that cries wolf gets disabled. So both sides are deliberately
 * asymmetric:
 *
 *   - DOCUMENTED is extracted only from anchored, structural positions: an
 *     uncommented `KEY=` assignment at the start of a line in .env.example or
 *     inside the install.sh .env heredoc, or a backticked token in the FIRST
 *     cell of a markdown table row. Prose, descriptions and inline code spans
 *     cannot reach any of those positions. Names must also look like env vars
 *     (ALL_CAPS with at least one underscore), which excludes `POST`, `GET`,
 *     `SQL` and friends from HTTP/verb tables.
 *
 *   - READ is deliberately generous: any mention of the exact name in the CODE
 *     of a TypeScript/JS source file. Reads in this codebase hide behind
 *     `process.env.X`, `env.X`, `env[SOME_CONST]` where the constant holds the
 *     name, `parseEnvList('X')`, and the SETTING_ENV_FALLBACKS map. Enumerating
 *     those patterns would miss one and fail a variable that is genuinely read.
 *     Being generous biases the guard toward missing a defect rather than
 *     inventing one.
 *
 *     Generous stops at "merely NAMED": a comment (including a trailing one) and
 *     a name buried in a longer string are mentions, not reads, and counting
 *     them would pass the guard on exactly the defect it exists for — the
 *     o3d-esha sweep left `// LOG_LEVEL is read by nothing` comments in the very
 *     files this scans. A string that is EXACTLY the name still counts, because
 *     that is how every indirect read passes it. See `extractReadKeys`.
 *
 * The suppression list is scripts/documented-env-var-allowlist.json, which
 * requires a reason string per entry so that a suppression is a decision
 * someone wrote down rather than a silent exception.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// import.meta.dirname is undefined when this module is loaded through tsx.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * ALL_CAPS with at least one underscore. Every environment variable this repo
 * documents matches it; the bare acronyms that appear in unrelated markdown
 * tables (`GET`, `POST`, `SQL`, `FIFO`) do not.
 */
export const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

export const DOC_SOURCES = [
  { file: '.env.example', kind: 'env' },
  { file: 'CLAUDE.md', kind: 'markdown-table' },
  { file: 'docs/installation.md', kind: 'markdown-table' },
  { file: 'scripts/install.sh', kind: 'shell-heredoc' },
]

export const READ_SCAN_DIRS = ['app', 'components', 'lib', 'prisma', 'scripts', 'types']

export const READ_SCAN_ROOT_FILES = [
  'instrumentation.ts',
  'next.config.ts',
  'prisma.config.ts',
  'proxy.ts',
  'eslint.config.mjs',
  'playwright.config.ts',
  'playwright.full-chain.config.ts',
  'playwright.no-webserver.config.ts',
]

/**
 * Excluded from the read scan on purpose. lib/ops/retired-env-vars.ts is a list
 * of names that are read by NOTHING — counting its mentions as reads would make
 * the guard blind to the exact defect it exists to catch.
 */
export const READ_SCAN_EXCLUDED_FILES = ['lib/ops/retired-env-vars.ts']

/**
 * Only the operator-facing surface counts, in BOTH directions.
 *
 * As a read: a variable mentioned solely in a test or a CI check script is not
 * read by the application, so counting it would let a phantom setting keep its
 * documentation alive purely because a test names it — which is exactly how the
 * o3d-tj6v regression tests would have blinded this guard to o3d-tj6v.
 *
 * In the inverse report: test harnesses read whole families (E2E_*, FULL_CHAIN_*,
 * SCHEMA_*) that no operator should ever be told about, and listing them would
 * bury the entries that matter — the connector credentials that silently
 * override the Settings UI.
 */
export function isOperatorFacingFile(file) {
  const normalized = file.split(path.sep).join('/')
  if (normalized.startsWith('tests/') || normalized.startsWith('e2e/')) return false
  if (normalized.startsWith('playwright.')) return false
  return !/^scripts\/check-[^/]+\.mjs$/.test(normalized)
}

const READ_SCAN_EXCLUDED_DIRS = new Set(['node_modules', '.next', '.git', 'generated'])
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs'])

/**
 * Uncommented `KEY=` assignments only. A commented-out line (`# XERO_TOKEN_PATH=...`
 * in .env.example) is a deprecation note, not an instruction to set anything,
 * so it must not count as documentation.
 */
export function extractEnvFileKeys(text) {
  const keys = new Set()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)
    if (match && ENV_VAR_NAME_RE.test(match[1])) keys.add(match[1])
  }
  return keys
}

/**
 * Backticked tokens in the FIRST cell of a markdown table row. Descriptions,
 * blockquotes, bullet lists and inline code spans in prose all sit outside that
 * position, which is what keeps documentation *about* a variable ("`SMTP_PASS`,
 * not `SMTP_PASSWORD`") from registering as documentation *of* it.
 */
export function extractMarkdownTableKeys(text) {
  const keys = new Set()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const firstCell = trimmed.slice(1).split('|')[0]
    if (firstCell === undefined) continue
    for (const [, token] of firstCell.matchAll(/`([^`]+)`/g)) {
      if (ENV_VAR_NAME_RE.test(token)) keys.add(token)
    }
  }
  return keys
}

/**
 * Assignments inside the heredoc that scripts/install.sh writes as the app's
 * .env. Prompts and shell locals elsewhere in the installer are NOT documentation:
 * they are the installer's own variables, and treating them as documented would
 * flag every internal.
 */
export function extractShellEnvHeredocKeys(text) {
  const keys = new Set()
  const lines = text.split(/\r?\n/)
  let inHeredoc = false
  let terminator = null
  // WHICH FUNCTION THE OPENER IS IN, because the redirect is no longer on the opener line
  // (o3d-2sm1.5 r39). The installer used to write `cat > "${APP_DIR}/.env" <<EOF`, and the path in
  // that line was how this scanner recognised the app's environment file. r39 split the writer so
  // that the bytes are rendered first and PUBLISHED BY RENAME afterwards — the heredoc now goes to
  // stdout inside render_app_env_file() and names no path at all. Without this the scanner found
  // no keys and every variable install.sh alone documents looked undocumented.
  let enclosingFunction = ''
  for (const line of lines) {
    if (!inHeredoc) {
      const definition = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/.exec(line)
      if (definition) enclosingFunction = definition[1]
      const open = /<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?\s*$/.exec(line)
      if (open && (/\.env\b/.test(line) || /app_env_file$/.test(enclosingFunction))) {
        inHeredoc = true
        terminator = open[1]
      }
      continue
    }
    if (line.trim() === terminator) {
      inHeredoc = false
      terminator = null
      continue
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)
    if (match && ENV_VAR_NAME_RE.test(match[1])) keys.add(match[1])
  }
  return keys
}

export function extractDocumentedKeys(kind, text) {
  if (kind === 'env') return extractEnvFileKeys(text)
  if (kind === 'markdown-table') return extractMarkdownTableKeys(text)
  if (kind === 'shell-heredoc') return extractShellEnvHeredocKeys(text)
  throw new Error(`Unknown documentation source kind "${kind}"`)
}

/**
 * Keywords after which a `/` opens a REGULAR EXPRESSION rather than being a
 * division operator (`return /x/.test(s)`). Everything else that ends in an
 * identifier character — a variable, a property, a closing bracket — means
 * division. Getting this wrong only matters for regexes containing an unpaired
 * quote (`.replace(/'/g, '')`), which would otherwise open a phantom string.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
])

/**
 * Single pass over a source file, classifying every character as code, comment,
 * string or regex.
 *
 * A hand-rolled scanner rather than regex surgery because the two are not
 * equivalent here. The previous matcher stripped block comments and whole-line
 * `//` comments and deliberately LEFT trailing `//` comments alone, because a
 * naive line strip mangles `https://` inside a string literal — and mangling a
 * line can only DELETE a real read, which becomes a false positive. A scanner
 * that knows it is inside a string when it meets `//` has no such trade-off:
 * it removes every comment, including trailing ones, and never touches a URL.
 *
 * Returns three views of the file:
 *   - `codeWithComments` — comments blanked, string and regex bodies intact.
 *     `process.env.X` / `process.env['X']` matching needs the literals.
 *   - `codeOutsideLiterals` — comments AND literal bodies blanked. What is left
 *     is identifiers, properties and object keys: things the file names because
 *     it USES them.
 *   - `stringLiterals` — the complete content of every string / no-substitution
 *     template literal, so a literal can be judged as a whole.
 *
 * Blanking preserves length and newlines so offsets and line numbers survive.
 */
export function scanCodeRegions(text) {
  const withComments = text.split('')
  const outsideLiterals = text.split('')
  const stringLiterals = []

  const blank = (index) => {
    if (text[index] !== '\n') outsideLiterals[index] = ' '
  }
  const blankBoth = (index) => {
    if (text[index] !== '\n') {
      withComments[index] = ' '
      outsideLiterals[index] = ' '
    }
  }

  // Template literals nest: `a${ `b${ c }` }d`. The stack records, per open
  // template, whether we are inside its `${ }` (code) or its static text.
  const templateStack = []
  let i = 0
  let lastSignificant = ''
  let lastWord = ''

  const startsRegex = () => {
    if (lastSignificant === '') return true
    // A JSX CLOSING TAG. `startsRegex` is only ever asked at a `/`, so a `<` here means `</` — and
    // in .tsx that is `</div>`, never a regex. Read as one it terminates at the NEXT closing tag on
    // the line and blanks everything between them, so
    //     <span>{FIRST}</span> <span>{SECOND}</span>
    // loses SECOND from codeOutsideLiterals entirely. THAT IS A MISSED READ, which this guard turns
    // into a FALSE POSITIVE against a variable that is genuinely used — the one failure mode the
    // whole scanner exists to avoid (see the header on why the old matcher deliberately left
    // trailing comments alone).
    //
    // The trade is safe in this direction and only this direction. Calling a real regex "division"
    // costs nothing but a phantom string if it contains an unpaired quote, and that already
    // self-heals: an unterminated string stops at the newline and `restore` puts the line back.
    // Calling real code "a regex" deletes it with no way back. `a < /x/.test(b)` is the only thing
    // given up, and it does not occur.
    if (lastSignificant === '<') return false
    if (/[)\]}]/.test(lastSignificant)) return false
    if (/[A-Za-z0-9_$]/.test(lastSignificant)) return REGEX_PRECEDING_KEYWORDS.has(lastWord)
    // Quotes end a literal, so `/` after one is division.
    return !/['"`]/.test(lastSignificant)
  }

  const noteSignificant = (char) => {
    lastSignificant = char
    if (/[A-Za-z0-9_$]/.test(char)) lastWord += char
    else lastWord = ''
  }

  /**
   * Put back what a mis-read literal blanked.
   *
   * Blanking is speculative: we do not know a quote was really a string until we
   * find its partner. Rewinding `i` without restoring the characters would leave
   * the rest of the line blank in `codeOutsideLiterals` and DELETE every read on
   * it — the false positive this guard cannot afford. A stray apostrophe in JSX
   * text ("Don't set DATABASE_URL") is the everyday case.
   */
  const restore = (from, to) => {
    for (let index = from; index < to && index < text.length; index += 1) {
      outsideLiterals[index] = text[index]
    }
  }

  while (i < text.length) {
    const char = text[i]
    const next = text[i + 1]

    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') blankBoth(i++)
      continue
    }

    if (char === '/' && next === '*') {
      blankBoth(i++)
      blankBoth(i++)
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) blankBoth(i++)
      if (i < text.length) { blankBoth(i++); blankBoth(i++) }
      lastSignificant = ''
      lastWord = ''
      continue
    }

    if (char === '/' && startsRegex()) {
      const start = i
      i++
      let inClass = false
      let terminated = false
      while (i < text.length) {
        const c = text[i]
        if (c === '\\') { blank(i); blank(i + 1); i += 2; continue }
        if (c === '\n') break
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) { i++; terminated = true; break }
        blank(i)
        i++
      }
      // A regex literal never spans a line, so an unterminated one means the
      // heuristic misfired on a division. Undo it.
      if (!terminated) { restore(start, i); i = start + 1 }
      noteSignificant(terminated ? ')' : '/')
      continue
    }

    if (char === '\'' || char === '"') {
      const quote = char
      const start = i
      i++
      let content = ''
      let terminated = false
      while (i < text.length) {
        const c = text[i]
        if (c === '\\') { blank(i); blank(i + 1); content += text[i + 1] ?? ''; i += 2; continue }
        if (c === quote) { i++; terminated = true; break }
        // An unterminated quote (a stray apostrophe the regex heuristic let
        // through) must not swallow the rest of the file: stop at the newline.
        if (c === '\n') break
        blank(i)
        content += c
        i++
      }
      if (terminated) stringLiterals.push(content)
      else { restore(start, i); i = start + 1 }
      noteSignificant(quote)
      continue
    }

    if (char === '`') {
      const start = i
      i++
      let content = ''
      let substituted = false
      let terminated = false
      while (i < text.length) {
        const c = text[i]
        if (c === '\\') { blank(i); blank(i + 1); content += text[i + 1] ?? ''; i += 2; continue }
        if (c === '`') { i++; terminated = true; break }
        if (c === '$' && text[i + 1] === '{') {
          // Leave the substitution as code and resume the template afterwards.
          substituted = true
          templateStack.push(start)
          i += 2
          break
        }
        blank(i)
        content += c
        i++
      }
      if (terminated && !substituted) stringLiterals.push(content)
      if (!terminated && !substituted) { restore(start, i); i = start + 1 }
      if (!substituted) noteSignificant('`')
      else { lastSignificant = '{'; lastWord = '' }
      continue
    }

    if (char === '}' && templateStack.length > 0) {
      // Back into the static half of the innermost template literal.
      templateStack.pop()
      i++
      while (i < text.length) {
        const c = text[i]
        if (c === '\\') { blank(i); blank(i + 1); i += 2; continue }
        if (c === '`') { i++; break }
        if (c === '$' && text[i + 1] === '{') { templateStack.push(i); i += 2; break }
        blank(i)
        i++
      }
      noteSignificant('`')
      continue
    }

    if (!/\s/.test(char)) noteSignificant(char)
    i++
  }

  return {
    codeWithComments: withComments.join(''),
    codeOutsideLiterals: outsideLiterals.join(''),
    stringLiterals,
  }
}

/**
 * Comments removed, literals preserved. Kept as the name the literal-access
 * matchers below use; `scanCodeRegions` is what actually does the work.
 */
export function stripCodeComments(text) {
  return scanCodeRegions(text).codeWithComments
}

/**
 * READ is deliberately generous — see the file header — but "generous" has to
 * stop short of "a variable that is merely NAMED counts as read", or the guard
 * passes on exactly the defect it exists for. Two mentions are not reads:
 *
 *   - a comment, including a trailing one. `// LOG_LEVEL is read by nothing` is
 *     the opposite of a read, and the o3d-esha sweep left such comments behind
 *     in the very files the guard scans.
 *   - a name buried in a longer string: an error message, a doc string, a
 *     migration's SQL. `'WC_SYNC_STATUSES was documented and read by nothing'`
 *     names the variable; it does not consult it.
 *
 * A string that is EXACTLY the variable name still counts, because that is how
 * every indirect read in this codebase passes it: `parseEnvList('X')`,
 * `process.env['X']`, `const X_ENV = 'X'; env[X_ENV]`, and the
 * SETTING_ENV_FALLBACKS values. No read can arrive with the name glued into a
 * sentence, so requiring the whole literal to match costs nothing and closes
 * the "merely named" hole.
 */
export function extractReadKeys(text) {
  const keys = new Set()
  const { codeOutsideLiterals, stringLiterals } = scanCodeRegions(text)
  for (const [, token] of codeOutsideLiterals.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
    keys.add(token)
  }
  for (const literal of stringLiterals) {
    if (ENV_VAR_NAME_RE.test(literal)) keys.add(literal)
  }
  return keys
}

/**
 * SETTING_ENV_FALLBACKS maps a settings key to an environment variable name, and
 * getEnvFallback reads it as `process.env[envKey]` through a variable — so the
 * literal-access matcher below cannot see it. These are the entries the inverse
 * report most needs to name: getSettingValue PREFERS the environment value, so
 * a connector credential listed here silently overrides the Settings UI.
 */
export function extractSettingEnvFallbackKeys(text) {
  const keys = new Set()
  const block = /SETTING_ENV_FALLBACKS[^=]*=\s*\{([\s\S]*?)\n[ \t]*\}/.exec(stripCodeComments(text))
  if (!block) return keys
  for (const [, token] of block[1].matchAll(/:\s*'([A-Z][A-Z0-9_]*)'/g)) keys.add(token)
  return keys
}

/**
 * The narrow counterpart to extractReadKeys, used ONLY for the inverse
 * "read but undocumented" warning. The generous matcher above matches every
 * SCREAMING_SNAKE constant in the codebase, which is exactly what makes it safe
 * for the failing direction and useless for this one: it would name several
 * thousand ordinary constants. Here a literal `process.env` access is required,
 * so the warning lists things that really are environment inputs.
 */
export function extractEnvAccessKeys(text) {
  const keys = new Set()
  const code = stripCodeComments(text)
  for (const [, token] of code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) keys.add(token)
  for (const [, token] of code.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) keys.add(token)
  for (const [, group] of code.matchAll(/\{([^{}]*)\}\s*=\s*process\.env/g)) {
    for (const [, token] of group.matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)) keys.add(token)
  }
  return keys
}

function collectCodeFiles(root, relativeDir, out) {
  const absolute = path.join(root, relativeDir)
  let entries
  try {
    entries = readdirSync(absolute)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (READ_SCAN_EXCLUDED_DIRS.has(entry)) continue
    const relative = path.join(relativeDir, entry)
    const stats = statSync(path.join(root, relative))
    if (stats.isDirectory()) {
      collectCodeFiles(root, relative, out)
      continue
    }
    if (CODE_EXTENSIONS.has(path.extname(entry))) out.push(relative)
  }
  return out
}

export function collectReadScanFiles(root = REPO_ROOT) {
  const files = []
  for (const dir of READ_SCAN_DIRS) collectCodeFiles(root, dir, files)
  for (const file of READ_SCAN_ROOT_FILES) {
    try {
      if (statSync(path.join(root, file)).isFile()) files.push(file)
    } catch {
      // Optional config file; absence is not a failure.
    }
  }
  const excluded = new Set(READ_SCAN_EXCLUDED_FILES.map((file) => path.normalize(file)))
  return files.filter((file) => !excluded.has(path.normalize(file)))
}

export function loadAllowlist(root = REPO_ROOT) {
  const raw = JSON.parse(readFileSync(path.join(root, 'scripts/documented-env-var-allowlist.json'), 'utf8'))
  for (const section of ['documentedButUnread', 'undocumentedReads']) {
    const entries = raw[section] ?? {}
    for (const [name, reason] of Object.entries(entries)) {
      if (typeof reason !== 'string' || reason.trim().length < 24) {
        throw new Error(
          `Allowlist entry ${section}.${name} needs a reason of at least 24 characters explaining why it is exempt.`,
        )
      }
    }
  }
  return {
    documentedButUnread: raw.documentedButUnread ?? {},
    undocumentedReads: raw.undocumentedReads ?? {},
  }
}

/**
 * @param documented Map of env var name -> array of source labels documenting it.
 * @param read Set of env var names mentioned in code.
 */
export function evaluateEnvVarDocumentation(
  documented,
  read,
  allowlist = { documentedButUnread: {}, undocumentedReads: {} },
  envAccessed = read,
) {
  const failures = []
  const warnings = []
  const staleAllowlistEntries = []

  for (const [name, sources] of documented) {
    if (read.has(name)) continue
    if (Object.hasOwn(allowlist.documentedButUnread, name)) continue
    failures.push({ name, sources })
  }

  for (const name of Object.keys(allowlist.documentedButUnread)) {
    if (!documented.has(name)) {
      staleAllowlistEntries.push({ name, section: 'documentedButUnread' })
      continue
    }
    if (read.has(name)) staleAllowlistEntries.push({ name, section: 'documentedButUnread' })
  }

  for (const name of envAccessed) {
    if (documented.has(name)) continue
    if (Object.hasOwn(allowlist.undocumentedReads, name)) continue
    warnings.push({ name })
  }

  failures.sort((a, b) => a.name.localeCompare(b.name))
  warnings.sort((a, b) => a.name.localeCompare(b.name))
  staleAllowlistEntries.sort((a, b) => a.name.localeCompare(b.name))
  return { failures, warnings, staleAllowlistEntries }
}

export function collectDocumentedKeys(root = REPO_ROOT) {
  const documented = new Map()
  for (const { file, kind } of DOC_SOURCES) {
    let text
    try {
      text = readFileSync(path.join(root, file), 'utf8')
    } catch {
      continue
    }
    for (const key of extractDocumentedKeys(kind, text)) {
      const sources = documented.get(key) ?? []
      sources.push(file)
      documented.set(key, sources)
    }
  }
  return documented
}

export function collectReadKeys(root = REPO_ROOT) {
  const read = new Set()
  const envAccessed = new Set()
  for (const file of collectReadScanFiles(root)) {
    if (!isOperatorFacingFile(file)) continue
    const text = readFileSync(path.join(root, file), 'utf8')
    for (const key of extractReadKeys(text)) read.add(key)
    for (const key of extractEnvAccessKeys(text)) envAccessed.add(key)
    for (const key of extractSettingEnvFallbackKeys(text)) envAccessed.add(key)
  }
  return { read, envAccessed }
}

function main() {
  const documented = collectDocumentedKeys()
  const { read, envAccessed } = collectReadKeys()
  const allowlist = loadAllowlist()
  const { failures, warnings, staleAllowlistEntries } = evaluateEnvVarDocumentation(
    documented,
    read,
    allowlist,
    envAccessed,
  )

  if (warnings.length > 0) {
    console.warn(
      `Warning: ${warnings.length} environment variable(s) are read by application code but documented `
      + `nowhere an operator looks: ${warnings.map((warning) => warning.name).join(', ')}. `
      + 'Any of these that appear in SETTING_ENV_FALLBACKS (lib/settings-store.ts) are OVERRIDES: '
      + 'getSettingValue prefers the environment value, so an operator changing one in the Settings UI '
      + 'has the change silently ignored while the variable is set.',
    )
  }

  if (staleAllowlistEntries.length > 0) {
    for (const { name, section } of staleAllowlistEntries) {
      console.error(`Stale allowlist entry ${section}.${name}: it is no longer documented-but-unread. Delete it.`)
    }
    process.exit(1)
  }

  if (failures.length > 0) {
    console.error('Documented environment variables that no code reads:')
    for (const { name, sources } of failures) {
      console.error(`  - ${name} (documented in ${sources.join(', ')})`)
    }
    console.error(
      '\nAn operator who sets one of these believes a control exists. Either wire it up, or remove it '
      + 'from every place it is documented and add it to lib/ops/retired-env-vars.ts so existing installs '
      + 'are told at preflight. If it is legitimately consumed only by shell scripts or systemd units, add '
      + 'it to scripts/documented-env-var-allowlist.json with a reason.',
    )
    process.exit(1)
  }

  console.log(`Documented environment variables: ${documented.size} checked, all read by code.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
