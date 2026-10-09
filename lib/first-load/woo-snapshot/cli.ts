/**
 * The first-load WooCommerce snapshot command line, as a function so tests can drive it without a subprocess.
 * scripts/first-load-woo-snapshot.ts is a thin wrapper around `runSnapshotCli`.
 *
 * READ-ONLY, END TO END. It reads a WooCommerce store's variable products and their variations through the connector's read function and writes
 * three files into a new directory: the checksummed snapshot, a provenance file (store origin, time, request and page counts), and the canonical
 * `variant-parents.csv` that `first-load:prepare` joins Qoblex variants to. It writes nothing to the store, to the IMS database or to any setting.
 *
 * CREDENTIALS come from a file given by path (never from the command line, never from the IMS database): a READ-ONLY WooCommerce REST key, in a file
 * only its owner can read. Putting a store key into the target IMS would make its stock-sync paths live, which a first load must not do.
 *
 * A STORE IS ONLY CONTACTED WHEN ITS ORIGIN IS ALLOWLISTED (`--allow-origin`, or FIRST_LOAD_WOO_ALLOWED_ORIGINS in the credentials file), unless
 * `--allow-any-origin` says otherwise out loud. The check happens before the first request and before anything is written.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SNAPSHOT_EXIT_CODES, SNAPSHOT_EXIT_CODE_TABLE, SNAPSHOT_FILE_NAMES } from '../spec'
import { SNAPSHOT_FORMAT_VERSION, parseSnapshotFile, renderSnapshotFile, renderVariantParentsCsv, sha256Hex } from '../snapshot'
import { WALK_MAX_ATTEMPTS, SnapshotFetchError, SnapshotInconsistentError, freshState, walkStore, type PageResult, type WalkState } from './walk'

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export interface SnapshotCliDeps {
  /** Builds the function that performs one GET for the given store. Production: the connector's read function. */
  makeFetchPage?: (credentials: { url: string; key: string; secret: string }) => Promise<(path: string, params: Record<string, string>) => Promise<PageResult>>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export const ENV_KEYS = {
  url: 'FIRST_LOAD_WOO_URL',
  key: 'FIRST_LOAD_WOO_KEY',
  secret: 'FIRST_LOAD_WOO_SECRET',
  allowedOrigins: 'FIRST_LOAD_WOO_ALLOWED_ORIGINS',
} as const

export const DEFAULT_MIN_INTERVAL_MS = 500

export function usageText(): string {
  return [
    'Usage: first-load-woo-snapshot --env-file <credentials> --out <dir> (--allow-origin <origin> ... | --allow-any-origin) [--resume] [--min-interval-ms <n>]',
    '       first-load-woo-snapshot --verify <woo-snapshot.json>',
    '',
    'Reads a WooCommerce store\'s variable products and their variations (GET requests only) and writes the snapshot, its provenance and variant-parents.csv.',
    '',
    `  --env-file <file>      credentials: ${ENV_KEYS.url}, ${ENV_KEYS.key}, ${ENV_KEYS.secret} (a READ-ONLY REST key), optionally ${ENV_KEYS.allowedOrigins}.`,
    '                         The file must be readable by its owner only (mode 600). Credentials are never accepted on the command line.',
    '  --out <dir>            output directory; must not exist or must be empty (with --resume it may hold only an unfinished walk)',
    '  --allow-origin <o>     an origin (scheme://host[:port]) the command may contact; repeatable',
    '  --allow-any-origin     contact the store even though its origin is not on the allowlist',
    '  --resume               continue an unfinished walk kept in --out (same store only)',
    `  --min-interval-ms <n>  minimum milliseconds between two requests (default ${DEFAULT_MIN_INTERVAL_MS})`,
    '  --verify <file>        offline: recompute the checksum of a snapshot and re-run its consistency rules; no request, no credentials',
    '  --help                 this text',
    '',
    'Exit codes:',
    ...SNAPSHOT_EXIT_CODE_TABLE.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
    '',
  ].join('\n')
}

class UsageError extends Error {}
class RefusedError extends Error {}

interface Args {
  envFile: string | null
  out: string | null
  allowOrigins: string[]
  allowAnyOrigin: boolean
  resume: boolean
  minIntervalMs: number
  verify: string | null
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { envFile: null, out: null, allowOrigins: [], allowAnyOrigin: false, resume: false, minIntervalMs: DEFAULT_MIN_INTERVAL_MS, verify: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      return next
    }
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--env-file') args.envFile = value()
    else if (arg === '--out') args.out = value()
    else if (arg === '--allow-origin') args.allowOrigins.push(value())
    else if (arg === '--allow-any-origin') args.allowAnyOrigin = true
    else if (arg === '--resume') args.resume = true
    else if (arg === '--min-interval-ms') {
      const raw = value()
      if (!/^\d{1,6}$/.test(raw)) throw new UsageError('--min-interval-ms must be a whole number of milliseconds (0 to 999999)')
      args.minIntervalMs = Number(raw)
    } else if (arg === '--verify') args.verify = value()
    else throw new UsageError(`unknown argument ${JSON.stringify(arg)} (credentials are never accepted on the command line: put them in the --env-file)`)
  }
  if (args.help) return args
  if (args.verify !== null) {
    if (args.envFile !== null || args.out !== null || args.resume || args.allowOrigins.length > 0 || args.allowAnyOrigin) throw new UsageError('--verify reads one file and takes no other option')
    return args
  }
  if (args.envFile === null) throw new UsageError('--env-file is required')
  if (args.out === null) throw new UsageError('--out is required')
  return args
}

/** The credentials file: KEY=VALUE lines, `#` comments, optional quotes. Unknown keys are refused so a typo cannot silently leave one out. */
function readCredentials(file: string): { url: string; key: string; secret: string; allowedOrigins: string[] } {
  let stat
  try {
    stat = lstatSync(file)
  } catch (error) {
    throw new RefusedError(`cannot read the credentials file ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new RefusedError(`the credentials file ${file} must be a regular file, not a link or directory`)
  if ((stat.mode & 0o077) !== 0) throw new RefusedError(`the credentials file ${file} is readable by group or others (mode ${(stat.mode & 0o777).toString(8)}): run chmod 600 on it`)
  const values = new Map<string, string>()
  const known = new Set<string>(Object.values(ENV_KEYS))
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed)
    // The line itself is never echoed: it may hold a secret.
    if (!match) throw new RefusedError(`line ${index + 1} of the credentials file is not KEY=VALUE`)
    if (!known.has(match[1])) throw new RefusedError(`line ${index + 1} of the credentials file sets ${match[1]}, which is not one of ${[...known].join(', ')}`)
    if (values.has(match[1])) throw new RefusedError(`${match[1]} is set twice in the credentials file`)
    let value = match[2].trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    values.set(match[1], value)
  })
  const need = (name: string): string => {
    const v = values.get(name)
    if (v === undefined || v === '') throw new RefusedError(`the credentials file does not set ${name}`)
    return v
  }
  const allowedOrigins = (values.get(ENV_KEYS.allowedOrigins) ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return { url: need(ENV_KEYS.url), key: need(ENV_KEYS.key), secret: need(ENV_KEYS.secret), allowedOrigins }
}

function originOf(raw: string, where: string, fail: (message: string) => Error): string {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http or https')
    return url.origin
  } catch {
    throw fail(`${where} ${JSON.stringify(raw)} is not an origin such as https://shop.example`)
  }
}

function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp`
  writeFileSync(tmp, content, { flag: 'w', encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, target)
}

function runVerify(file: string, io: CliIo): number {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    io.stderr(`first-load-woo-snapshot: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}\n`)
    return SNAPSHOT_EXIT_CODES.INCONSISTENT
  }
  const parsed = parseSnapshotFile(text)
  if (!parsed.ok) {
    io.stderr(`first-load-woo-snapshot: the snapshot ${file} cannot be trusted:\n${parsed.problems.map((p) => `  - ${p}`).join('\n')}\n`)
    return SNAPSHOT_EXIT_CODES.INCONSISTENT
  }
  io.stdout(`Snapshot verified: payload SHA-256 ${parsed.payloadSha256}; ${parsed.payload.parents.length} variable product(s), ${parsed.payload.variations.length} variation(s); no consistency problem.\n`)
  return SNAPSHOT_EXIT_CODES.OK
}

export async function runSnapshotCli(argv: string[], io: CliIo, deps: SnapshotCliDeps = {}): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`first-load-woo-snapshot: ${error.message}\n\n${usageText()}`)
      return SNAPSHOT_EXIT_CODES.USAGE
    }
    throw error
  }
  if (args.help) {
    io.stdout(usageText())
    return SNAPSHOT_EXIT_CODES.OK
  }
  if (args.verify !== null) return runVerify(args.verify, io)

  // ---- preconditions: nothing has left the machine and nothing has been written ----
  let credentials: ReturnType<typeof readCredentials>
  let origin: string
  let baseUrl: string
  try {
    credentials = readCredentials(args.envFile!)
    const { validateWooCommerceBaseUrl } = await import('@/lib/connectors/woocommerce/url-safety')
    const validated = validateWooCommerceBaseUrl(credentials.url)
    if (!validated.ok) throw new RefusedError(`the store URL in the credentials file is not usable: ${validated.error}`)
    baseUrl = validated.normalizedUrl
    origin = new URL(baseUrl).origin
    const allowed = new Set([
      ...args.allowOrigins.map((o) => originOf(o, '--allow-origin', (m) => new UsageError(m))),
      ...credentials.allowedOrigins.map((o) => originOf(o, ENV_KEYS.allowedOrigins, (m) => new RefusedError(m))),
    ])
    if (!allowed.has(origin) && !args.allowAnyOrigin) {
      throw new RefusedError(`the store origin ${origin} is not on the allowlist (${allowed.size === 0 ? 'the allowlist is empty' : [...allowed].sort().join(', ')}). Nothing was requested. Name it with --allow-origin ${origin} if this is the store you mean, or pass --allow-any-origin.`)
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`first-load-woo-snapshot: ${error.message}\n\n${usageText()}`)
      return SNAPSHOT_EXIT_CODES.USAGE
    }
    if (error instanceof RefusedError) {
      io.stderr(`first-load-woo-snapshot: refused: ${error.message}\n`)
      return SNAPSHOT_EXIT_CODES.REFUSED
    }
    throw error
  }

  // ---- the output directory ----
  const outDir = path.resolve(args.out!)
  const partialPath = path.join(outDir, SNAPSHOT_FILE_NAMES.partial)
  let state: WalkState = freshState(origin)
  let resumed = false
  let createdDir = false
  try {
    if (existsSync(outDir)) {
      const entries = readdirSync(outDir)
      const onlyPartial = entries.length === 1 && entries[0] === SNAPSHOT_FILE_NAMES.partial
      if (entries.length > 0 && !(args.resume && onlyPartial)) {
        io.stderr(`first-load-woo-snapshot: the output directory ${args.out} is not empty${onlyPartial ? ' (it holds an unfinished walk: add --resume to continue it)' : ''}; nothing was requested or written\n`)
        return SNAPSHOT_EXIT_CODES.OUTPUT_FAILED
      }
      if (onlyPartial) {
        let saved: unknown
        try {
          saved = JSON.parse(readFileSync(partialPath, 'utf8'))
        } catch (error) {
          io.stderr(`first-load-woo-snapshot: the unfinished walk in ${args.out} cannot be read (${error instanceof Error ? error.message : String(error)}); remove it and run again without --resume\n`)
          return SNAPSHOT_EXIT_CODES.OUTPUT_FAILED
        }
        const candidate = saved as WalkState
        if (typeof candidate !== 'object' || candidate === null || candidate.formatVersion !== SNAPSHOT_FORMAT_VERSION || typeof candidate.origin !== 'string' || typeof candidate.variations !== 'object') {
          io.stderr(`first-load-woo-snapshot: the unfinished walk in ${args.out} is not a walk of this tool; nothing was requested\n`)
          return SNAPSHOT_EXIT_CODES.OUTPUT_FAILED
        }
        if (candidate.origin !== origin) {
          io.stderr(`first-load-woo-snapshot: refused: the unfinished walk in ${args.out} belongs to ${candidate.origin}, not ${origin}; nothing was requested\n`)
          return SNAPSHOT_EXIT_CODES.REFUSED
        }
        state = candidate
        resumed = true
      }
    } else {
      mkdirSync(outDir, { recursive: true, mode: 0o700 })
      createdDir = true
    }
  } catch (error) {
    io.stderr(`first-load-woo-snapshot: the output directory ${args.out} is unusable (${error instanceof Error ? error.message : String(error)}); nothing was requested\n`)
    return SNAPSHOT_EXIT_CODES.OUTPUT_FAILED
  }

  // ---- the walk ----
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => Date.now())
  const makeFetchPage = deps.makeFetchPage ?? (async (creds) => {
    const { wcFetch } = await import('@/lib/connectors/woocommerce/api')
    // wcFetch is the connector's GET-only reader: it takes no method and no body, and with explicit credentials it never reads the IMS database.
    return (p, params) => wcFetch(p, params, { url: creds.url, key: creds.key, secret: creds.secret })
  })
  let result
  try {
    const fetchPage = await makeFetchPage({ url: baseUrl, key: credentials.key, secret: credentials.secret })
    result = await walkStore(state, {
      fetchPage, sleep, now, minIntervalMs: args.minIntervalMs,
      onProgress: (s) => writeAtomic(partialPath, JSON.stringify(s)),
    })
  } catch (error) {
    if (error instanceof SnapshotInconsistentError) {
      rmSync(partialPath, { force: true })
      if (createdDir) rmSync(outDir, { recursive: true, force: true })
      io.stderr(`first-load-woo-snapshot: the store's answer cannot be trusted as a complete catalogue, so no snapshot was written:\n${error.message}\n`)
      return SNAPSHOT_EXIT_CODES.INCONSISTENT
    }
    if (error instanceof SnapshotFetchError) {
      io.stderr(`first-load-woo-snapshot: ${error.message} (after ${WALK_MAX_ATTEMPTS} attempt(s)).\nWhat was read is kept in ${args.out}; run the same command with --resume to continue. Nothing was written to the store.\n`)
      return SNAPSHOT_EXIT_CODES.FETCH_FAILED
    }
    io.stderr(`first-load-woo-snapshot: internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    return SNAPSHOT_EXIT_CODES.INTERNAL
  }

  // ---- the files, with a self-check that what is written reads back ----
  const snapshotText = renderSnapshotFile(result.payload)
  const reread = parseSnapshotFile(snapshotText)
  if (!reread.ok) {
    io.stderr(`first-load-woo-snapshot: internal error: the snapshot just built does not verify:\n${reread.problems.map((p) => `  - ${p}`).join('\n')}\n`)
    return SNAPSHOT_EXIT_CODES.INTERNAL
  }
  const csv = renderVariantParentsCsv(reread.payload)
  const provenance = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    source: 'woocommerce',
    origin,
    fetchedAt: new Date(now()).toISOString(),
    resumed,
    minIntervalMs: args.minIntervalMs,
    requests: result.requests,
    proof: result.proof,
    snapshotFile: { name: SNAPSHOT_FILE_NAMES.snapshot, sha256: sha256Hex(snapshotText), bytes: Buffer.byteLength(snapshotText, 'utf8'), payloadSha256: reread.payloadSha256 },
    variantParentsFile: { name: SNAPSHOT_FILE_NAMES.variantParents, sha256: sha256Hex(csv), rows: csv.split('\r\n').filter((l) => l !== '').length - 1 },
  }
  const created: string[] = []
  try {
    for (const [name, content] of [
      [SNAPSHOT_FILE_NAMES.snapshot, snapshotText],
      [SNAPSHOT_FILE_NAMES.provenance, `${JSON.stringify(provenance, null, 2)}\n`],
      [SNAPSHOT_FILE_NAMES.variantParents, csv],
    ] as const) {
      const target = path.join(outDir, name)
      writeFileSync(target, content, { flag: 'wx', encoding: 'utf8', mode: 0o600 })
      created.push(target)
    }
    rmSync(partialPath, { force: true })
  } catch (error) {
    for (const file of created) rmSync(file, { force: true })
    io.stderr(`first-load-woo-snapshot: writing the output failed (${error instanceof Error ? error.message : String(error)}); the files this run had written were removed\n`)
    return SNAPSHOT_EXIT_CODES.OUTPUT_FAILED
  }

  const p = result.proof
  io.stdout([
    `Snapshot of ${origin} written to ${args.out}${resumed ? ' (resumed)' : ''}.`,
    `  variable products: ${p.parents.rowsRead} read = ${p.parents.totalHeader} (X-WP-Total) in ${p.parents.pages} page(s)`,
    `  variations: ${p.variations.rowsRead} read = ${p.variations.totalHeaderSum} (sum of X-WP-Total over ${p.variations.parentsWithVariations} product(s)) and equal to the ids the products list`,
    `  variations without a SKU (cannot be joined, not in ${SNAPSHOT_FILE_NAMES.variantParents}): ${p.variationsWithoutSku}`,
    `  requests this run: ${result.requests}; payload SHA-256 ${reread.payloadSha256}`,
    '  every request was a GET.',
    '',
  ].join('\n'))
  return SNAPSHOT_EXIT_CODES.OK
}
