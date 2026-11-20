/**
 * THE ECB HISTORY BACKFILL (npm run fx:backfill-ecb): a one-off OPERATOR command that loads historical ECB reference rates into IMS's fx_rates table, so that the first load can price an old
 * foreign purchase order (the rate at the end of its created day) and a foreign stock lot (the rate at the end of its received day). IMS only holds rates from the day it first fetched them.
 *
 * NEVER FETCHES. The input is the ECB's `eurofxref-hist.csv`, a FILE the operator downloaded by hand (https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip, unzip it). Tests use a small fixture.
 *
 * CONVERSION. The ECB quotes foreign units per ONE EUR. fx_rates.rate is foreign units per ONE BASE unit (1 base = rate foreign). With the organisation's base B (read from the database, never
 * assumed): for currency X, rate = X_per_EUR / B_per_EUR; for X = EUR, rate = 1 / B_per_EUR. When the base IS EUR, B_per_EUR is 1. The base currency itself is never written. Arithmetic is exact
 * integer arithmetic (BigInt), rounded half to even at 8 decimal places (the column is Decimal(18,8)).
 *
 * ROWS. One row per ECB business day (a day present in the file) per currency, source 'ecb-history' (live rows are 'frankfurter' / 'aelia' / 'manual'), fetchedAt = the ECB's publication time, 16:00
 * Europe/Berlin, converted to UTC with the zone's own DST rules (15:00Z in winter, 14:00Z in summer), so the row sits on the ECB day in UTC and the end-of-day lookup rule finds it.
 *
 * THE BACKFILL WRITES ONLY INTO THE PAST OF THE TABLE. Backfilled rows are older than every live row, so they can never become "the latest row" of a pair, never un-pin a manual override, never fill a
 * gap between live rows and never change a lookup that a live row already answers. Under the exclusive FX table lock the command reads, per (base, currency), the first row that is NOT 'ecb-history'
 * (live, manual or Aelia) and REFUSES, listing the days, any planned day on or after that row's UTC day (it does not clamp, so the operator sees it and lowers --to or drops the currency). It also
 * REFUSES any planned day on or after the UTC day the earliest Aelia interval of the source switch starts (inside an Aelia interval a lookup only accepts aelia rows and manual overrides, so an ECB
 * row there would be ignored anyway). Since no planned day reaches a live row's day, the backfill can never tie a live row on one instant either.
 *
 * IDEMPOTENT. A (currency, UTC day) that already holds an 'ecb-history' row is skipped and counted; re-running the same window is a no-op. The backfill never overwrites or deletes a row.
 *
 * REFUSALS (exit 4, nothing written): a day on or after the first live row of a requested currency or the Aelia start, the base currency missing from the file, a requested currency with a blank / N/A /
 * zero cell on a day in the window (every such day is reported), a requested currency that is not a column of the file, --from/--to outside the file's date range, a requested currency that is not
 * enabled, a malformed file, a lock held by another writer for more than 30 s. A refusal names the currency; re-run with --currencies excluding it, or a smaller --to.
 */
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fxSourceRegimeFromSettings, FX_RATE_SOURCE_HISTORY_SETTING, FX_RATE_SOURCE_SETTING, FX_RATE_SOURCE_SINCE_SETTING } from '../currencies/fx-source-regime'

export const ECB_BACKFILL_SOURCE = 'ecb-history'
export const ECB_BACKFILL_APPLICATION_NAME = 'fx-backfill-ecb'
export const ECB_BACKFILL_EXIT = { OK: 0, USAGE: 2, TARGET: 3, REFUSED: 4, INTERNAL: 6 } as const
/** The advisory lock every fx_rates writer takes exclusively (lib/db/advisory-locks.ts FX_TABLE_LOCK_KEY). A test pins that the two are equal. */
export const ECB_BACKFILL_FX_TABLE_LOCK_KEY = 918_274_401
const MAX_FILE_BYTES = 8 * 1024 * 1024
const DATE = /^\d{4}-\d{2}-\d{2}$/
const CODE = /^[A-Z]{3}$/

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// dates

export function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const t = Date.parse(`${value}T00:00:00.000Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value
}

/** 16:00 Europe/Berlin on `day` (YYYY-MM-DD) as a UTC Date: the candidate (14:00Z or 15:00Z) whose Berlin wall clock reads 16:00 on that day. */
export function ecbPublicationInstant(day: string): Date {
  if (!isRealDate(day)) throw new Error(`not a real date: ${day}`)
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  for (const hourUtc of [14, 15]) {
    const candidate = new Date(`${day}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`)
    const parts = Object.fromEntries(fmt.formatToParts(candidate).map((p) => [p.type, p.value]))
    if (`${parts.year}-${parts.month}-${parts.day}` === day && parts.hour === '16' && parts.minute === '00') return candidate
  }
  throw new Error(`no unambiguous 16:00 Europe/Berlin instant on ${day}`)
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// exact decimal arithmetic

type Dec = { n: bigint; s: number } // n / 10^s
// tsconfig targets below ES2020, so BigInt literals (1n) are not available: named constants instead.
const B0 = BigInt(0)
const B1 = BigInt(1)
const B2 = BigInt(2)
const B10 = BigInt(10)

function parseDec(text: string): Dec | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (!m) return null
  const frac = m[2] ?? ''
  return { n: BigInt(m[1]! + frac), s: frac.length }
}

/** num / den rounded half to even at `places` decimal places, as a plain decimal string. Both operands positive. */
export function divideRounded(num: Dec, den: Dec, places = 8): string {
  // num/den = (num.n * 10^den.s) / (den.n * 10^num.s); scale by 10^places.
  const top = num.n * B10 ** BigInt(den.s + places)
  const bottom = den.n * B10 ** BigInt(num.s)
  let q = top / bottom
  const r = top % bottom
  const twice = r * B2
  if (twice > bottom || (twice === bottom && q % B2 === B1)) q += B1
  const digits = q.toString().padStart(places + 1, '0')
  return `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the ECB file

export interface EcbFile {
  /** Column codes, in file order (EUR is implicit and not a column). */
  currencies: string[]
  /** day -> currency -> exact decimal text, or null for a blank / N/A cell. */
  days: Map<string, Map<string, string | null>>
  firstDay: string
  lastDay: string
}

/** Parse eurofxref-hist.csv. Returns the file or the problems (nothing is guessed: a malformed line refuses the whole file). */
export function parseEcbCsv(text: string): { ok: true; file: EcbFile } | { ok: false; problems: string[] } {
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return { ok: false, problems: ['the ECB file is larger than 8 MiB; it is not eurofxref-hist.csv'] }
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return { ok: false, problems: ['the ECB file has no data rows'] }
  const head = lines[0]!.split(',').map((c) => c.trim())
  while (head.length > 0 && head[head.length - 1] === '') head.pop() // the ECB writes a trailing comma
  if (head[0] !== 'Date') return { ok: false, problems: ['the ECB file does not start with a "Date" column'] }
  const currencies = head.slice(1)
  const problems: string[] = []
  if (currencies.length === 0) problems.push('the ECB file has no currency columns')
  const seen = new Set<string>()
  for (const c of currencies) {
    if (!CODE.test(c)) problems.push(`the ECB file has a column that is not a currency code: ${JSON.stringify(c.slice(0, 12))}`)
    if (seen.has(c)) problems.push(`the ECB file has the column ${c} twice`)
    seen.add(c)
  }
  const days = new Map<string, Map<string, string | null>>()
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i]!.split(',').map((c) => c.trim())
    const day = cells[0] ?? ''
    if (!isRealDate(day)) { problems.push(`line ${i + 1}: the first cell is not a YYYY-MM-DD date`); continue }
    if (days.has(day)) { problems.push(`line ${i + 1}: the day ${day} appears twice`); continue }
    const row = new Map<string, string | null>()
    for (let c = 0; c < currencies.length; c += 1) {
      const cell = cells[c + 1] ?? ''
      if (cell === '' || cell.toUpperCase() === 'N/A') row.set(currencies[c]!, null)
      else if (/^\d+(\.\d+)?$/.test(cell)) row.set(currencies[c]!, cell)
      else problems.push(`line ${i + 1}: the ${currencies[c]} cell is not a number, blank or N/A`)
    }
    days.set(day, row)
  }
  if (problems.length > 0) return { ok: false, problems: problems.slice(0, 20) }
  const sorted = [...days.keys()].sort()
  return { ok: true, file: { currencies, days, firstDay: sorted[0]!, lastDay: sorted[sorted.length - 1]! } }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the plan

export interface PlannedRow { currency: string; day: string; rate: string; fetchedAt: Date }

export interface BackfillInputs {
  file: EcbFile
  baseCurrency: string
  /** Enabled (active) currencies other than... any; the base is filtered here. */
  enabledCurrencies: readonly string[]
  /** --currencies, or null for every enabled foreign currency. */
  requested: readonly string[] | null
  from: string
  to: string
  /** `${currency}|${YYYY-MM-DD UTC}` of every existing 'ecb-history' fx_rates row of the base against that currency inside the window. */
  existing: ReadonlySet<string>
  /** currency -> UTC day (YYYY-MM-DD) of the FIRST row of the pair that is not 'ecb-history' (live, manual, Aelia). Absent: the pair has no live row. */
  firstLiveDay?: ReadonlyMap<string, string>
  /** UTC day (YYYY-MM-DD) the earliest Aelia interval starts, or null when there is none. */
  aeliaFromDay?: string | null
}

export interface CurrencyCounts { currency: string; businessDays: number; toWrite: number; skippedExisting: number }

export type BackfillPlan =
  | { ok: true; rows: PlannedRow[]; counts: CurrencyCounts[]; businessDays: number }
  | { ok: false; refusals: string[] }

export function planBackfill(i: BackfillInputs): BackfillPlan {
  const refusals: string[] = []
  const base = i.baseCurrency
  if (!isRealDate(i.from) || !isRealDate(i.to)) return { ok: false, refusals: ['--from and --to must be real YYYY-MM-DD dates'] }
  if (i.from > i.to) return { ok: false, refusals: ['--from is after --to'] }
  if (i.from < i.file.firstDay || i.to > i.file.lastDay) {
    refusals.push(`the window ${i.from}..${i.to} is outside the ECB file's range ${i.file.firstDay}..${i.file.lastDay}`)
  }
  const enabledForeign = [...new Set(i.enabledCurrencies)].filter((c) => c !== base).sort()
  let currencies: string[]
  if (i.requested === null) currencies = enabledForeign
  else {
    currencies = [...new Set(i.requested)].sort()
    for (const c of currencies) {
      if (c === base) refusals.push(`${c} is the base currency; it has no rate against itself and is never written`)
      else if (!enabledForeign.includes(c)) refusals.push(`${c} is not an enabled currency of this installation`)
    }
    currencies = currencies.filter((c) => c !== base)
  }
  if (currencies.length === 0 && refusals.length === 0) refusals.push('there is no enabled foreign currency to backfill')
  const baseIsEur = base === 'EUR'
  if (!baseIsEur && !i.file.currencies.includes(base)) refusals.push(`the base currency ${base} is not a column of the ECB file, so no rate can be converted`)
  for (const c of currencies) if (c !== 'EUR' && !i.file.currencies.includes(c)) refusals.push(`${c} is not a column of the ECB file`)
  if (refusals.length > 0) return { ok: false, refusals }

  const days = [...i.file.days.keys()].filter((d) => d >= i.from && d <= i.to).sort()
  if (days.length === 0) return { ok: false, refusals: [`the ECB file has no business day inside ${i.from}..${i.to}`] }
  const rows: PlannedRow[] = []
  const livePast = new Map<string, string[]>()
  const aeliaPast: string[] = []
  const counts = new Map<string, CurrencyCounts>(currencies.map((c) => [c, { currency: c, businessDays: days.length, toWrite: 0, skippedExisting: 0 }]))
  for (const day of days) {
    const cells = i.file.days.get(day)!
    let baseDec: Dec | null = { n: B1, s: 0 }
    if (!baseIsEur) {
      const cell = cells.get(base) ?? null
      baseDec = cell === null ? null : parseDec(cell)
      if (baseDec === null || baseDec.n === B0) { refusals.push(`${day}: the base currency ${base} has a blank, N/A or zero cell`); continue }
    }
    for (const c of currencies) {
      let num: Dec | null = { n: B1, s: 0 }
      if (c !== 'EUR') {
        const cell = cells.get(c) ?? null
        num = cell === null ? null : parseDec(cell)
        if (num === null || num.n === B0) { refusals.push(`${day}: ${c} has a blank, N/A or zero cell (re-run with --currencies excluding ${c}, or a window without this day)`); continue }
      }
      const key = counts.get(c)!
      const live = i.firstLiveDay?.get(c)
      if (live !== undefined && day >= live) { livePast.set(c, [...(livePast.get(c) ?? []), day]); continue }
      if (i.aeliaFromDay != null && day >= i.aeliaFromDay) { aeliaPast.push(`${c} ${day}`); continue }
      if (i.existing.has(`${c}|${day}`)) { key.skippedExisting += 1; continue }
      const rate = divideRounded(num, baseDec!)
      if (/^0\.0+$/.test(rate)) { refusals.push(`${day}: ${c} rounds to zero at 8 decimal places`); continue }
      rows.push({ currency: c, day, rate, fetchedAt: ecbPublicationInstant(day) })
      key.toWrite += 1
    }
  }
  for (const [c, list] of livePast) {
    const live = i.firstLiveDay!.get(c)!
    const before = new Date(Date.parse(`${live}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)
    refusals.push(`${c}: ${list.length} planned day(s) on or after the first live row of ${c} (${live}): ${listDays(list)}. The backfill only writes before the first live row: lower --to to ${before} at most, or re-run with --currencies excluding ${c}`)
  }
  if (aeliaPast.length > 0) refusals.push(`${aeliaPast.length} planned currency/day(s) on or after the start of the Aelia period (${i.aeliaFromDay}): ${listDays(aeliaPast)}. Lower --to before that day`)
  if (refusals.length > 0) return { ok: false, refusals: capRefusals(refusals) }
  return { ok: true, rows, counts: [...counts.values()], businessDays: days.length }
}

function listDays(list: string[]): string {
  return list.length <= 8 ? list.join(', ') : `${list.slice(0, 8).join(', ')}, ... (${list.length - 8} more)`
}

function capRefusals(list: string[]): string[] {
  return list.length <= 50 ? list : [...list.slice(0, 50), `... and ${list.length - 50} more`]
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the database side

export interface BackfillPort {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
}

/** The only statements this module sends (a test pins the list). Parameters are bound; nothing is interpolated. */
export const ECB_BACKFILL_STATEMENTS = {
  beginWrite: 'BEGIN ISOLATION LEVEL READ COMMITTED',
  beginDryRun: 'BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ',
  lock: 'SELECT pg_advisory_xact_lock($1::bigint)',
  identity: `select current_database() as db, (select system_identifier::text from pg_control_system()) as sid`,
  base: `select coalesce((select "baseCurrency" from "organisations" order by "createdAt", "id" limit 1), 'GBP') as base`,
  enabled: `select "code" from "currencies" where "active" = true order by "code"`,
  existing: `select "toCurrency" as cur, to_char("fetchedAt", 'YYYY-MM-DD') as day from "fx_rates" where "fromCurrency" = $1 and "toCurrency" = any($2::text[]) and "source" = '${ECB_BACKFILL_SOURCE}' and "fetchedAt" >= $3::timestamp and "fetchedAt" < $4::timestamp group by 1, 2`,
  lockTimeout: "SET LOCAL lock_timeout = '30s'",
  firstLive: `select "toCurrency" as cur, to_char(min("fetchedAt"), 'YYYY-MM-DD') as day from "fx_rates" where "fromCurrency" = $1 and "toCurrency" = any($2::text[]) and "source" <> '${ECB_BACKFILL_SOURCE}' group by 1`,
  fxSource: `select "key", "value" from "settings" where "key" = any($1::text[])`,
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
} as const

export function insertStatement(rowCount: number): string {
  const tuples: string[] = []
  for (let r = 0; r < rowCount; r += 1) {
    const b = r * 5
    tuples.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::numeric, $${b + 5}::timestamp, '${ECB_BACKFILL_SOURCE}', false)`)
  }
  return `insert into "fx_rates" ("id", "fromCurrency", "toCurrency", "rate", "fetchedAt", "source", "manualOverride") values ${tuples.join(', ')}`
}

/** fx_rates.fetchedAt is `timestamp(3) without time zone` holding UTC (Prisma's convention): bind a zone-less UTC text so no session TimeZone can shift it. */
const utcNaive = (d: Date): string => d.toISOString().replace('Z', '')
const newId = (): string => `ecbbf${randomBytes(10).toString('hex')}`
const INSERT_CHUNK = 500

export interface BackfillArgs {
  from: string
  to: string
  currencies: string[] | null
  expectDb: string
  expectSystemId: string
  dryRun: boolean
}

export type BackfillOutcome =
  | { kind: 'target-refused'; problem: string }
  | { kind: 'refused'; baseCurrency: string; refusals: string[] }
  | { kind: 'done'; baseCurrency: string; dryRun: boolean; businessDays: number; counts: CurrencyCounts[]; written: number; skippedExisting: number }

/**
 * One transaction. A real run: BEGIN, exclusive FX table lock, the target is confirmed twice from inside the transaction BEFORE anything is read for the plan or written, the existing days are read
 * under the lock (so a live writer cannot add a row between the read and the insert), the plan is computed, refusal rolls back, otherwise insert and COMMIT. A dry run is READ ONLY and takes no lock.
 */
export async function runBackfill(port: BackfillPort, file: EcbFile, args: BackfillArgs): Promise<BackfillOutcome> {
  await port.query(args.dryRun ? ECB_BACKFILL_STATEMENTS.beginDryRun : ECB_BACKFILL_STATEMENTS.beginWrite)
  let committed = false
  try {
    // The target is confirmed BEFORE the lock is asked for, so a wrong database never waits on, or takes, anything.
    const id = (await port.query<{ db: string; sid: string }>(ECB_BACKFILL_STATEMENTS.identity)).rows[0]
    if (!id || id.db !== args.expectDb) return { kind: 'target-refused', problem: '--expect-db does not equal the database the server reports; the target is not the database you named' }
    if (id.sid !== args.expectSystemId) return { kind: 'target-refused', problem: '--expect-system-id does not equal the cluster system identifier the server reports' }
    if (!args.dryRun) {
      await port.query(ECB_BACKFILL_STATEMENTS.lockTimeout)
      try {
        await port.query(ECB_BACKFILL_STATEMENTS.lock, [ECB_BACKFILL_FX_TABLE_LOCK_KEY])
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') return { kind: 'target-refused', problem: 'the exchange-rate table is locked by another writer (waited 30 s); nothing was written. Try again in a moment.' }
        throw error
      }
    }
    const baseCurrency = ((await port.query<{ base: string }>(ECB_BACKFILL_STATEMENTS.base)).rows[0]?.base ?? '').trim().toUpperCase()
    if (!CODE.test(baseCurrency)) return { kind: 'target-refused', problem: 'the database has no usable organisation base currency' }
    const enabled = (await port.query<{ code: string }>(ECB_BACKFILL_STATEMENTS.enabled)).rows.map((r) => r.code)
    const wanted = (args.currencies ?? enabled).filter((c) => c !== baseCurrency)
    const dayAfter = utcNaive(new Date(Date.parse(`${args.to}T00:00:00.000Z`) + 86_400_000))
    const existing = new Set<string>()
    const firstLiveDay = new Map<string, string>()
    if (wanted.length > 0 && isRealDate(args.from) && isRealDate(args.to)) {
      const rows = (await port.query<{ cur: string; day: string }>(ECB_BACKFILL_STATEMENTS.existing, [baseCurrency, wanted, `${args.from}T00:00:00.000`, dayAfter])).rows
      for (const r of rows) existing.add(`${r.cur}|${r.day}`)
      for (const r of (await port.query<{ cur: string; day: string }>(ECB_BACKFILL_STATEMENTS.firstLive, [baseCurrency, wanted])).rows) firstLiveDay.set(r.cur, r.day)
    }
    const settings = (await port.query<{ key: string; value: string }>(ECB_BACKFILL_STATEMENTS.fxSource, [[FX_RATE_SOURCE_SETTING, FX_RATE_SOURCE_SINCE_SETTING, FX_RATE_SOURCE_HISTORY_SETTING]])).rows
    const setting = (k: string): string | null => settings.find((r) => r.key === k)?.value ?? null
    const regime = fxSourceRegimeFromSettings(setting(FX_RATE_SOURCE_SETTING), setting(FX_RATE_SOURCE_SINCE_SETTING), setting(FX_RATE_SOURCE_HISTORY_SETTING))
    if (regime?.unreadable) return { kind: 'refused', baseCurrency, refusals: ['the stored FX source switch history is unreadable, so the Aelia period cannot be known; repair it (docs/installation.md) before backfilling'] }
    const aeliaFromDay = regime && regime.aelia.length > 0 ? new Date(Math.min(...regime.aelia.map((a) => a.since.getTime()))).toISOString().slice(0, 10) : null
    const plan = planBackfill({ file, baseCurrency, enabledCurrencies: enabled, requested: args.currencies, from: args.from, to: args.to, existing, firstLiveDay, aeliaFromDay })
    if (!plan.ok) return { kind: 'refused', baseCurrency, refusals: plan.refusals }
    if (!args.dryRun) {
      for (let at = 0; at < plan.rows.length; at += INSERT_CHUNK) {
        const chunk = plan.rows.slice(at, at + INSERT_CHUNK)
        const params: unknown[] = []
        for (const r of chunk) params.push(newId(), baseCurrency, r.currency, r.rate, utcNaive(r.fetchedAt))
        await port.query(insertStatement(chunk.length), params)
      }
      try {
        await port.query(ECB_BACKFILL_STATEMENTS.commit)
      } catch {
        committed = true // the connection may be gone: no rollback to send
        throw new Error('COMMIT_OUTCOME_UNKNOWN')
      }
      committed = true
    }
    return {
      kind: 'done', baseCurrency, dryRun: args.dryRun, businessDays: plan.businessDays, counts: plan.counts,
      written: args.dryRun ? 0 : plan.rows.length, skippedExisting: plan.counts.reduce((a, c) => a + c.skippedExisting, 0),
    }
  } finally {
    if (!committed) await port.query(ECB_BACKFILL_STATEMENTS.rollback).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the command line

export const ECB_BACKFILL_HELP = [
  'Usage: fx-backfill-ecb --env-file <file> --expect-db <name> --expect-system-id <id> --ecb-csv <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--currencies EUR,USD] [--dry-run]',
  '',
  'Backfills historical ECB rates into fx_rates (source "ecb-history") so first-load:prepare can price old foreign purchase orders and stock lots. NEVER downloads anything:',
  'download https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip by hand, unzip it, and pass eurofxref-hist.csv as --ecb-csv.',
  '',
  '  --env-file <file>          the installation env file (DATABASE_URL inside): a regular file you own, mode 600. The environment is replaced by a short whitelist.',
  '  --expect-db <name>         must equal current_database(); otherwise nothing is read or written.',
  '  --expect-system-id <id>    must equal the cluster system identifier; otherwise nothing is read or written.',
  '  --ecb-csv <path>           the ECB eurofxref-hist.csv file.',
  '  --from / --to <YYYY-MM-DD> the window (inclusive); must lie inside the file\'s date range.',
  '  --currencies <A,B>         only these (each must be an enabled currency). DEFAULT: every enabled foreign currency.',
  '  --dry-run                  prints the counts per currency and writes nothing (a read-only transaction).',
  '  --help                     this text',
  '',
  'A currency/day that already has ANY fx_rates row (live, manual, earlier backfill) is skipped and counted; re-running is a no-op. A blank or N/A ECB cell for a requested currency, a window outside',
  'the file, or a base currency missing from the file refuses the run and writes nothing. A real run is one transaction under the exclusive FX table lock.',
  '',
  'Exit codes: 0 done (or dry run); 2 usage; 3 target not confirmed or unreadable; 4 refused (gaps, window, currencies, malformed file); 6 internal error.',
  '',
].join('\n')

export type BackfillParsed = { kind: 'help' } | { kind: 'usage'; problems: string[] } | { kind: 'run'; args: BackfillArgs & { envFile: string; ecbCsv: string } }

const CREDENTIAL_IN_ARG = /[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@|[?&](password|passwd|pwd|secret|token|key)=/i

export function parseBackfillArgs(argv: readonly string[]): BackfillParsed {
  const problems: string[] = []
  const values = new Map<string, string>()
  const valued = ['--env-file', '--expect-db', '--expect-system-id', '--ecb-csv', '--from', '--to', '--currencies']
  let dryRun = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    if (arg === '--dry-run') { dryRun = true; continue }
    if (!valued.includes(arg)) { problems.push(`an argument is not recognised (position ${i + 1})`); continue }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) { problems.push(`${arg} needs a value`); continue }
    if (values.has(arg)) problems.push(`${arg} was given twice`)
    if (CREDENTIAL_IN_ARG.test(value)) problems.push(`the value of ${arg} looks like it carries a credential; name the target by an env file`)
    values.set(arg, value)
    i += 1
  }
  for (const required of ['--env-file', '--expect-db', '--expect-system-id', '--ecb-csv', '--from', '--to']) if (!values.has(required)) problems.push(`${required} is required`)
  const from = values.get('--from')
  const to = values.get('--to')
  if (from !== undefined && !isRealDate(from)) problems.push('--from must be a real date, YYYY-MM-DD')
  if (to !== undefined && !isRealDate(to)) problems.push('--to must be a real date, YYYY-MM-DD')
  if (from !== undefined && to !== undefined && isRealDate(from) && isRealDate(to) && from > to) problems.push('--from is after --to')
  let currencies: string[] | null = null
  if (values.has('--currencies')) {
    currencies = values.get('--currencies')!.split(',').map((c) => c.trim().toUpperCase()).filter((c) => c !== '')
    if (currencies.length === 0 || currencies.some((c) => !CODE.test(c))) problems.push('--currencies must be a comma-separated list of three-letter currency codes')
  }
  if (problems.length > 0) return { kind: 'usage', problems }
  return {
    kind: 'run',
    args: {
      envFile: values.get('--env-file')!, expectDb: values.get('--expect-db')!, expectSystemId: values.get('--expect-system-id')!, ecbCsv: path.resolve(values.get('--ecb-csv')!),
      from: from!, to: to!, currencies, dryRun,
    },
  }
}

/** The report: counts only, never a connection string. */
export function renderBackfillReport(o: Extract<BackfillOutcome, { kind: 'done' }>, args: Pick<BackfillArgs, 'from' | 'to'>): string {
  const lines = [`fx-backfill-ecb: ${o.dryRun ? 'DRY RUN (nothing written)' : 'done'}; base ${o.baseCurrency}; window ${args.from}..${args.to}; ${o.businessDays} ECB business day(s) in the window`]
  for (const c of o.counts) lines.push(`  ${c.currency}: ${o.dryRun ? 'would write' : 'written'} ${c.toWrite}, skipped existing ${c.skippedExisting}`)
  lines.push(`  total: ${o.dryRun ? 'would write' : 'written'} ${o.counts.reduce((a, c) => a + c.toWrite, 0)}, skipped existing ${o.skippedExisting}`)
  return `${lines.join('\n')}\n`
}
