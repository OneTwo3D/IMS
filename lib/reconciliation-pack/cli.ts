/**
 * THE COMMAND LINE OF `npm run reconcile:pack`, WITHOUT ITS SIDE EFFECTS: argument parsing, the environment a run keeps and
 * the account check. Pure functions; scripts/reconciliation-pack.ts does the work.
 *
 * What a name is not: the account is checked by uid against root and the owner of the checkout (a user NAME says nothing),
 * the report directory and the acceptance file are trusted only after the ancestor and owner checks elsewhere, and no flag
 * is ever taken as evidence of what it names. An argument that looks like it carries a credential is refused before
 * anything else happens, and what the command prints about a refusal is a closed code (PACK_CLI_CODES), never the argument.
 */

import { PACK_CLI_FLAGS, PACK_ITEM_IDS, DEFAULT_PACK_REPORT_DIR, type PackCliCode, type PackItemId } from '@/lib/reconciliation-pack/constants'
import { READINESS_PHASES, type ReadinessPhase } from '@/lib/ops/readiness-gate-constants'

export type PackArgs = {
  phase: ReadinessPhase
  asOf: string | null
  items: PackItemId[] | null
  acceptances: string | null
  reportDir: string
  basisOnly: boolean
  vendorReadsOnly: boolean
  help: boolean
}

const VALUE_FLAGS = ['--phase', '--as-of', '--items', '--acceptances', '--report-dir'] as const
const BOOLEAN_FLAGS = ['--basis-only', '--vendor-reads-only', '--help'] as const
/** Every flag the command accepts, taken from the documented table so the two cannot drift. */
export const KNOWN_PACK_FLAGS: readonly string[] = PACK_CLI_FLAGS.map((f) => f.flag)

/** A value that carries a credential: a URL with a user, a query-string secret, or any URL scheme at all (no flag takes one). */
const CREDENTIAL_SHAPE = /[a-z][a-z0-9+.-]*:\/\/|[?&](?:password|passwd|pwd|secret|token|key)=|(?:password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]/i
const CONTROL = /[\u0000-\u001f\u007f]/
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

export function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** The day before `now`, UTC. */
export function defaultAsOf(now: Date): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function parsePackArgs(argv: readonly string[], now: Date): PackArgs | { code: PackCliCode } {
  const bad = (code: PackCliCode = 'BAD_ARGUMENTS'): { code: PackCliCode } => ({ code })
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if ((BOOLEAN_FLAGS as readonly string[]).includes(arg)) {
      if (flags.has(arg)) return bad()
      flags.add(arg)
    } else if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = argv[i + 1]
      if (value === undefined || value === '' || value.startsWith('--') || values.has(arg)) return bad()
      if (CONTROL.test(value)) return bad()
      if (CREDENTIAL_SHAPE.test(value)) return bad('CREDENTIAL_ARGUMENT')
      values.set(arg, value)
      i += 1
    } else {
      // An unknown argument is refused without being looked at; it may be a credential.
      return CREDENTIAL_SHAPE.test(arg) ? bad('CREDENTIAL_ARGUMENT') : bad()
    }
  }
  const out: PackArgs = { phase: 'P0', asOf: null, items: null, acceptances: null, reportDir: DEFAULT_PACK_REPORT_DIR, basisOnly: flags.has('--basis-only'), vendorReadsOnly: flags.has('--vendor-reads-only'), help: flags.has('--help') }
  if (out.help) return out
  const phase = values.get('--phase')
  if (phase === undefined || !(READINESS_PHASES as readonly string[]).includes(phase)) return bad()
  out.phase = phase as ReadinessPhase
  const asOf = values.get('--as-of') ?? defaultAsOf(now)
  // A real calendar date, and a day that has ended (UTC): today's snapshot does not exist yet.
  if (!isCalendarDate(asOf) || asOf >= now.toISOString().slice(0, 10)) return bad()
  out.asOf = asOf
  const items = values.get('--items')
  if (items !== undefined) {
    const ids = items.split(',')
    if (!ids.every((id): id is PackItemId => (PACK_ITEM_IDS as readonly string[]).includes(id)) || new Set(ids).size !== ids.length) return bad()
    out.items = ids as PackItemId[]
  }
  if (out.basisOnly && out.items !== null) return bad()
  out.acceptances = values.get('--acceptances') ?? null
  out.reportDir = values.get('--report-dir') ?? DEFAULT_PACK_REPORT_DIR
  return out
}

/** The only variables a run keeps. Never a PG variable, a grant, a credential other than the database URL, or anything that loads code. */
export const KEPT_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'DATABASE_URL'] as const

export function buildPackEnv(parent: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home }
  for (const name of KEPT_ENV) {
    const value = parent[name]
    if (value !== undefined && value !== '') env[name] = value
  }
  return env
}

/** root, or the account that owns the checkout. Decided by uid; a name is not proof of anything. */
export function accountAllowed(uid: number | null, checkoutOwnerUid: number | null): boolean {
  if (uid === null || checkoutOwnerUid === null) return false
  return uid === 0 || uid === checkoutOwnerUid
}
