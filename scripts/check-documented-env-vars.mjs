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
 *   - READ is deliberately generous: any mention of the exact name in a
 *     TypeScript/JS source file outside comments. Reads in this codebase hide
 *     behind `process.env.X`, `env.X`, `env[SOME_CONST]` where the constant
 *     holds the name, `parseEnvList('X')`, and the SETTING_ENV_FALLBACKS map.
 *     Enumerating those patterns would miss one and fail a variable that is
 *     genuinely read. Being generous biases the guard toward missing a defect
 *     rather than inventing one.
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
  for (const line of lines) {
    if (!inHeredoc) {
      const open = /<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?\s*$/.exec(line)
      if (open && /\.env\b/.test(line)) {
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
 * Strip block comments and whole-line `//` comments. Trailing `//` comments are
 * left alone deliberately: stripping them would have to cope with `https://`
 * inside string literals, and mangling a line can only ever DELETE a real read,
 * which turns into a false positive.
 */
export function stripCodeComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
}

export function extractReadKeys(text) {
  const keys = new Set()
  for (const [, token] of stripCodeComments(text).matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
    keys.add(token)
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
