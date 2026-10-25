/**
 * THE AS-OF BASIS: the stored evidence a ledger item compares on, for ONE cycle date D.
 *
 * It is the exact-date counterpart of the loaders behind the GL reconciliation invariant. Those take the latest
 * balance on or before "now" and so can silently compare a subledger of one day with a ledger of another. This one
 * reads each balance for EXACTLY D and says why when it cannot:
 *
 *   AVAILABLE only when ALL hold -
 *     - the Xero plugin is on and Inventory, Allocated, Transit, COGS and Unearned Revenue each have a configured code;
 *     - each has exactly ONE stored trial-balance balance whose balance date is D, in the base currency, and says whether
 *       Xero reported the account or the account was absent from the trial balance (a zero it never reported);
 *     - an inventory snapshot run row exists for D, every inventory snapshot row for D is point-in-time reliable, and
 *       the rows are as many as the run row recorded;
 *     - the Xero balance-snapshot stream was fresh and unmoved at both liveness reads;
 *     - the stored evidence did not move during the run: the basis is READ inside the liveness bracket (readAsOfBasis)
 *       and SETTLED after its end read (settleAsOfBasis), which reads it again and compares a digest of every row it used,
 *       update times included. The stream stamp alone cannot show this: an on-demand Xero refresh rewrites the stored
 *       balances without advancing it.
 *   Otherwise the first failing reason (a closed code), never a substitute date and never a default.
 *
 * A SEPARATE transit leg (R10 only, `AsOfBasis.transit`) carries the movement of the cycle day on the Stock in Transit account against
 * the transit sub-ledger movement. It follows the same rules (an exact opening balance for the day before D, the connected organisation,
 * a provenance label, the sub-ledger's recorded coverage) and is part of the change token, but when it cannot be built the basis stays
 * available for the inventory comparison: only R10 is then inconclusive, with the leg's own reason.
 *
 * Every IMS read is made in ONE READ ONLY REPEATABLE READ transaction with a statement timeout (read-tx.ts). Stored
 * snapshots only: no vendor call, no write, no network. The comparison of the subledger with Inventory plus Allocated
 * is the existing pure `evaluateAccountGlReconciliation`, unchanged.
 *
 * Text safety: a result carries closed reason codes, account KINDS, counts and decimal strings. It does not carry an
 * account code, an account name or any stored text.
 */

import { createHash } from 'node:crypto'

import { Prisma } from '@/app/generated/prisma/client'
import { balanceDateString, normalizeBalanceDate } from '@/lib/domain/accounting/balance-date'
import { evaluateAccountGlReconciliation, type AccountGlReconciliation } from '@/lib/domain/accounting/account-gl-reconciliation'
import { isTransitLedgerCoverageSatisfied } from '@/lib/domain/accounting/transit-ledger-coverage'
import { toDecimal } from '@/lib/domain/math/decimal'
import { xeroTrialBalanceRef } from '@/lib/connectors/xero/account-balance-refs'
import { INTEGRATION_PLUGIN_SETTING_KEYS, parseIntegrationPluginEnabled } from '@/lib/integration-plugin-keys'
import { streamsVerdict, type LivenessBracket } from '@/lib/reconciliation-pack/liveness'
import { XERO_TRIAL_BALANCE_PARSER_VERSION } from '@/lib/domain/accounting/snapshot-provenance'
import { PACK_BASIS_ACCOUNTS, TRANSIT_COVERAGE_SETTING_KEY, type PackBasisAccountKind, type PackBasisReason, type PackEmptyProofCode, type PackReasonCode, type PackTransitLegReason } from '@/lib/reconciliation-pack/constants'
import { withReadOnlySnapshot } from '@/lib/reconciliation-pack/read-tx'

export const BASIS_CONNECTOR = 'xero'
export const BASIS_STREAM = 'xero-balance-snapshots' as const
const DEFAULT_BASE_CURRENCY = 'GBP'

export type BasisProvenance = 'trial-balance-row' | 'absent-from-tb'

export type BasisGlBalance = {
  kind: PackBasisAccountKind
  /** A plain decimal string, six places. For `absent-from-tb` it is the zero the pull recorded, NOT a reported zero. */
  amountBase: string
  provenance: BasisProvenance
}

export type BasisSubledger = {
  /** The run row for D exists. */
  runPresent: true
  rows: number
  valueBase: string
  /** Set when the run row exists and there are no rows: the named empty-population proof. */
  emptyProof: PackEmptyProofCode | null
}

/**
 * The Stock in Transit leg of R10, for the movement of the cycle day (the day before D, up to and including D): the existing
 * transit evaluator over the transit sub-ledger movement in that window and the movement of the stored transit balance between
 * the day before D and D. Transit is a clearing account whose sub-ledger has no opening balance, so only a MOVEMENT is comparable
 * (lib/domain/accounting/transit-gl-reconciliation.ts says why). It is a separate leg: when it cannot be built the basis is still
 * available for the inventory comparison, and R10 alone is inconclusive.
 */
export type BasisTransit =
  | { available: true; glMovement: string; subledgerMovement: string; reconciliation: AccountGlReconciliation }
  | { available: false; reason: PackTransitLegReason }

export type AsOfBasis =
  | {
      available: true
      asOf: string
      currency: string
      gl: readonly BasisGlBalance[]
      /** Kinds whose balance is the zero the pull recorded for an account absent from the trial balance. */
      absentFromTrialBalance: readonly PackBasisAccountKind[]
      /** Kinds that share one configured code with an earlier kind (they resolve to the same stored balance). */
      sharedCodeKinds: readonly PackBasisAccountKind[]
      subledger: BasisSubledger
      /**
       * The existing evaluator over the subledger and Inventory plus Allocated, unchanged; NULL when either of those two
       * balances is a zero the pull synthesised for an account the trial balance omitted (inventoryGlWithheld says so). An
       * absent account is not a reported zero, so no comparison, `balanced` least of all, may rest on it.
       */
      inventoryGl: AccountGlReconciliation | null
      inventoryGlWithheld: 'absent-from-tb' | null
      transit: BasisTransit
    }
  | { available: false; asOf: string | null; reason: PackBasisReason; packReason: PackReasonCode }

function unavailable(asOf: string | null, reason: PackBasisReason, packReason: PackReasonCode = 'SOURCE_UNREADABLE'): AsOfBasis {
  return { available: false, asOf, reason, packReason }
}

// ---------------------------------------------------------------------------------------------
// The reads. Typed narrowly so a test can hand a double with exactly these methods.
// ---------------------------------------------------------------------------------------------

export type BasisGlRow = {
  accountCode: string | null
  /** The Xero account id the balance was pulled for. A code can be reassigned; the id cannot. */
  externalAccountId: string
  /** The parser that wrote the balance; only the current version is a value, anything else is absent. */
  parserVersion: number | null
  balanceDate: Date
  currency: string
  amountBase: unknown
  sourcePayloadRef: string | null
  tenantId: string | null
  updatedAt: Date
}

export type BasisTx = {
  setting: { findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true } }): Promise<Array<{ key: string; value: string }>> }
  accountingToken: { findUnique(args: { where: { connector: string }; select: { tenantId: true } }): Promise<{ tenantId: string } | null> }
  organisation: { findFirst(args: { select: { baseCurrency: true } }): Promise<{ baseCurrency: string | null } | null> }
  /** The chart: which account id is the configured account for a code (active accounts only). */
  accountingAccount: { findMany(args: { where: { connector: string; code: { in: string[] }; active: true }; select: { code: true; externalAccountId: true } }): Promise<Array<{ code: string | null; externalAccountId: string }>> }
  accountingAccountBalanceSnapshot: {
    findMany(args: { where: { connector: string; currency: string; accountCode: { in: string[] }; balanceDate: Date; parserVersion: number }; select: { accountCode: true; externalAccountId: true; parserVersion: true; balanceDate: true; currency: true; amountBase: true; sourcePayloadRef: true; tenantId: true; updatedAt: true } }): Promise<BasisGlRow[]>
    count(args: { where: { connector: string; currency: string; accountCode: string; tenantId: string; parserVersion: number } }): Promise<number>
  }
  transitSubledgerMovement: {
    aggregate(args: { where: { journalDate: { gt: Date; lte: Date } }; _sum: { baseDelta: true } }): Promise<{ _sum: { baseDelta: unknown } }>
  }
  inventorySnapshotRun: { findUnique(args: { where: { snapshotDate: Date }; select: { snapshotCount: true } }): Promise<{ snapshotCount: number } | null> }
  inventorySnapshot: {
    aggregate(args: { where: { snapshotDate: Date }; _count: { _all: true }; _sum: { valueBase: true } }): Promise<{ _count: { _all: number }; _sum: { valueBase: unknown } }>
    count(args: { where: { snapshotDate: Date; valueReplayReliable: false } }): Promise<number>
  }
}

export type BasisDeps = {
  /** Runs `fn` inside the one read transaction. Tests hand a double; the default is the real read-only snapshot. */
  run?: <T>(fn: (tx: BasisTx) => Promise<T>) => Promise<T>
}

const SETTING_KEYS = [INTEGRATION_PLUGIN_SETTING_KEYS.xero, TRANSIT_COVERAGE_SETTING_KEY, ...PACK_BASIS_ACCOUNTS.map((a) => a.settingKey)]

const PLAIN_DECIMAL = /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,12})?$/

/**
 * A stored amount as a decimal, or null. Only a decimal object the database layer returns, a finite number, or a plain
 * decimal string is a number here: null, undefined, an empty string, a boolean, a list or anything else is NOT zero.
 */
function finiteDecimal(value: unknown): ReturnType<typeof toDecimal> | null {
  try {
    if (typeof value === 'string') return PLAIN_DECIMAL.test(value) ? toDecimal(value) : null
    if (typeof value === 'number') return Number.isFinite(value) ? toDecimal(value) : null
    if (Prisma.Decimal.isDecimal(value)) { const d = toDecimal(value as never); return d.isFinite() ? d : null }
    return null
  } catch {
    return null
  }
}


const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The transit leg (see BasisTransit). Every rule of the main balances applies to the opening balance too: exactly one stored row,
 * for exactly the day before D, under the connected organisation, in the base currency, a finite amount, and a provenance label.
 * A balance that is the zero the pull synthesised for an account the trial balance omitted is NOT a reported zero, at either end of
 * the window. Never throws: anything it cannot read is a named reason, and the change token still covers what it did read.
 */
async function readTransitLeg(tx: BasisTx, input: { asOf: string; date: Date; currency: string; tenant: string; transitCode: string; transitAccountId: string; closing: BasisGlBalance; transitShared: boolean; coverageStart: string | undefined }): Promise<{ leg: BasisTransit; evidence: unknown }> {
  const unavailable = (reason: PackTransitLegReason, evidence: unknown = null) => ({ leg: { available: false, reason } as BasisTransit, evidence })
  const opening = new Date(input.date.getTime() - DAY_MS)
  const openingString = balanceDateString(opening)
  if (!isTransitLedgerCoverageSatisfied(input.coverageStart, opening)) return unavailable('transit_ledger_not_covering')
  if (input.transitShared) return unavailable('transit_balance_unusable')
  const rows = await tx.accountingAccountBalanceSnapshot.findMany({
    where: { connector: BASIS_CONNECTOR, currency: input.currency, accountCode: { in: [input.transitCode] }, balanceDate: opening, parserVersion: XERO_TRIAL_BALANCE_PARSER_VERSION },
    select: { accountCode: true, externalAccountId: true, parserVersion: true, balanceDate: true, currency: true, amountBase: true, sourcePayloadRef: true, tenantId: true, updatedAt: true },
  })
  const own = rows.filter((row) => row.parserVersion === XERO_TRIAL_BALANCE_PARSER_VERSION && row.accountCode === input.transitCode && row.externalAccountId === input.transitAccountId && row.tenantId === input.tenant)
  const evidence = { opening: rows.map((row) => [row.accountCode, row.externalAccountId, row.balanceDate instanceof Date ? row.balanceDate.toISOString() : null, row.currency, row.amountBase === null || row.amountBase === undefined ? null : String(row.amountBase), row.sourcePayloadRef, row.tenantId, row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }
  if (own.length !== 1) return unavailable('transit_balance_unusable', evidence)
  const row = own[0]!
  if (!(row.balanceDate instanceof Date) || Number.isNaN(row.balanceDate.getTime()) || balanceDateString(row.balanceDate) !== openingString || row.currency !== input.currency) return unavailable('transit_balance_unusable', evidence)
  const amount = finiteDecimal(row.amountBase)
  if (amount === null) return unavailable('transit_balance_unusable', evidence)
  let openingAbsent: boolean
  if (row.sourcePayloadRef === xeroTrialBalanceRef(openingString, false)) openingAbsent = false
  else if (row.sourcePayloadRef === xeroTrialBalanceRef(openingString, true)) openingAbsent = true
  else return unavailable('transit_balance_unusable', evidence)
  if (openingAbsent && !amount.isZero()) return unavailable('transit_balance_unusable', evidence)
  if (openingAbsent || input.closing.provenance === 'absent-from-tb') return unavailable('transit_absent_from_tb', evidence)
  const movement = await tx.transitSubledgerMovement.aggregate({ where: { journalDate: { gt: opening, lte: input.date } }, _sum: { baseDelta: true } })
  // The coverage watermark (checked above) is the proof that the ledger covers the window, so a sum of no rows is a true zero.
  const raw = movement?._sum?.baseDelta
  const subledger = raw === null ? toDecimal(0) : finiteDecimal(raw)
  const withEvidence = { ...evidence, sum: raw === null || raw === undefined ? null : String(raw) }
  if (subledger === null) return unavailable('transit_balance_unusable', withEvidence)
  const closing = finiteDecimal(input.closing.amountBase)!
  const glMovement = closing.sub(amount)
  return { leg: { available: true, glMovement: glMovement.toFixed(6), subledgerMovement: subledger.toFixed(6), reconciliation: evaluateAccountGlReconciliation({ subledgerValue: subledger.toNumber(), glBalance: glMovement.toNumber() }) }, evidence: withEvidence }
}

type Resolved = { ok: true; basis: AsOfBasis & { available: true }; token: string } | { ok: false; reason: PackBasisReason }

async function readBasis(tx: BasisTx, asOf: string, date: Date): Promise<Resolved> {
  const fail = (reason: PackBasisReason): Resolved => ({ ok: false, reason })

  // 1. Configuration, read inside the transaction: the plugin switch and the five account codes.
  const settingRows = await tx.setting.findMany({ where: { key: { in: SETTING_KEYS } }, select: { key: true, value: true } })
  const settings = new Map<string, string>()
  for (const row of settingRows) {
    if (settings.has(row.key)) return fail('basis_unreadable')
    settings.set(row.key, row.value)
  }
  if (!parseIntegrationPluginEnabled(settings.get(INTEGRATION_PLUGIN_SETTING_KEYS.xero))) return fail('no_account_configured')
  const codes = new Map<PackBasisAccountKind, string>()
  for (const account of PACK_BASIS_ACCOUNTS) {
    const raw = settings.get(account.settingKey)
    const code = typeof raw === 'string' ? raw.trim() : ''
    if (code.length === 0) return fail('no_account_configured')
    codes.set(account.kind, code)
  }
  // EVERY kind whose code is also another kind's code, whatever their order in the catalogue (marking only the later one let an
  // earlier kind, e.g. Transit before COGS, read a balance it shares as if it were its own).
  const kindsOfCode = new Map<string, PackBasisAccountKind[]>()
  for (const account of PACK_BASIS_ACCOUNTS) {
    const code = codes.get(account.kind)!
    kindsOfCode.set(code, [...(kindsOfCode.get(code) ?? []), account.kind])
  }
  const sharedCodeKinds: PackBasisAccountKind[] = PACK_BASIS_ACCOUNTS.map((account) => account.kind).filter((kind) => kindsOfCode.get(codes.get(kind)!)!.length > 1)
  // The inventory comparison adds the Inventory and Allocated Inventory balances. Either one sharing its code (with the other,
  // or with Transit, COGS or Unearned Revenue) makes that sum a balance that is not the inventory ledger's: no usable basis
  // rather than a false one.
  if (sharedCodeKinds.includes('inventory') || sharedCodeKinds.includes('allocated')) return fail('inventory_accounts_shared')

  // 2. The base currency, by the same rule as everywhere else (the organisation row, else the default).
  const org = await tx.organisation.findFirst({ select: { baseCurrency: true } })
  const currency = (org?.baseCurrency ?? DEFAULT_BASE_CURRENCY).trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) return fail('basis_unreadable')

  // 2b. The connected organisation, in the same transaction. A stored balance counts only if it was fetched under THIS
  // organisation: the table has no other way to tell one organisation's ledger from another's after a rebind.
  const token = await tx.accountingToken.findUnique({ where: { connector: BASIS_CONNECTOR }, select: { tenantId: true } })
  const tenant = typeof token?.tenantId === 'string' ? token.tenantId.trim() : ''
  if (tenant.length === 0) return fail('no_account_configured')

  // 3. The ledger balances for EXACTLY D. One query, then every row is judged against its account.
  const wanted = [...new Set(codes.values())]
  const glRows = await tx.accountingAccountBalanceSnapshot.findMany({
    where: { connector: BASIS_CONNECTOR, currency, accountCode: { in: wanted }, balanceDate: date, parserVersion: XERO_TRIAL_BALANCE_PARSER_VERSION },
    select: { accountCode: true, externalAccountId: true, parserVersion: true, balanceDate: true, currency: true, amountBase: true, sourcePayloadRef: true, tenantId: true, updatedAt: true },
  })
  // WHICH account: the configured code names exactly one active chart account, and a stored balance counts only if it was
  // pulled for THAT account id (a code reassigned to another account leaves the old account's balances under the same code).
  const chartRows = await tx.accountingAccount.findMany({ where: { connector: BASIS_CONNECTOR, code: { in: wanted }, active: true }, select: { code: true, externalAccountId: true } })
  const chartIds = new Map<string, string[]>()
  for (const row of chartRows) if (row.code !== null) chartIds.set(row.code, [...(chartIds.get(row.code) ?? []), row.externalAccountId])
  const gl: BasisGlBalance[] = []
  let failure: PackBasisReason | null = null
  const note = (reason: PackBasisReason) => { failure ??= reason }
  for (const account of PACK_BASIS_ACCOUNTS) {
    const code = codes.get(account.kind)!
    const accountIds = chartIds.get(code) ?? []
    if (accountIds.length !== 1) { note('gl_account_identity'); continue }
    // A balance written by an earlier parser is ABSENT, not a value (the query already excludes it; this is the second wall).
    const forCode = glRows.filter((row) => row.accountCode === code && row.parserVersion === XERO_TRIAL_BALANCE_PARSER_VERSION)
    const forAccount = forCode.filter((row) => row.externalAccountId === accountIds[0])
    if (forCode.length > 0 && forAccount.length === 0) { note('gl_account_identity'); continue }
    const own = forAccount.filter((row) => row.tenantId === tenant)
    if (own.length === 0 && forAccount.length > 0) { note('gl_snapshot_other_tenant'); continue }
    if (own.length === 0) {
      // Say whether the account has ANY stored balance of this organisation: a different date is `not_for_date`, never a stand-in.
      const anyDate = await tx.accountingAccountBalanceSnapshot.count({ where: { connector: BASIS_CONNECTOR, currency, accountCode: code, tenantId: tenant, parserVersion: XERO_TRIAL_BALANCE_PARSER_VERSION } })
      note(anyDate > 0 ? 'not_for_date' : 'no_gl_snapshot')
      continue
    }
    if (own.length > 1) { note('gl_snapshot_ambiguous'); continue }
    const row = own[0]!
    // The row must be for D and the base currency whatever the query said: the query is not trusted to have been honoured.
    if (!(row.balanceDate instanceof Date) || Number.isNaN(row.balanceDate.getTime()) || balanceDateString(row.balanceDate) !== asOf || row.currency !== currency) { note('basis_unreadable'); continue }
    const amount = finiteDecimal(row.amountBase)
    if (amount === null) { note('basis_unreadable'); continue }
    const ref = row.sourcePayloadRef
    let provenance: BasisProvenance
    if (ref === xeroTrialBalanceRef(asOf, false)) provenance = 'trial-balance-row'
    else if (ref === xeroTrialBalanceRef(asOf, true)) provenance = 'absent-from-tb'
    else { note('gl_snapshot_unlabelled'); continue }
    // A zero the pull synthesised is zero by construction; anything else under that label is not what the pull writes.
    if (provenance === 'absent-from-tb' && !amount.isZero()) { note('basis_unreadable'); continue }
    gl.push({ kind: account.kind, amountBase: amount.toFixed(6), provenance })
  }
  if (failure) return fail(failure)

  // 3b. The transit leg (R10 only): a separate result; its unavailability never makes the inventory basis unavailable.
  const transit = await readTransitLeg(tx, { asOf, date, currency, tenant, transitCode: codes.get('transit')!, transitAccountId: chartIds.get(codes.get('transit')!)?.[0] ?? '', closing: gl.find((g) => g.kind === 'transit')!, transitShared: sharedCodeKinds.includes('transit'), coverageStart: settings.get(TRANSIT_COVERAGE_SETTING_KEY) })

  // 4. The subledger for D: the run row, then the rows (counted and summed in the same snapshot), then the reliable flag.
  const run = await tx.inventorySnapshotRun.findUnique({ where: { snapshotDate: date }, select: { snapshotCount: true } })
  if (!run) return fail('no_subledger_snapshot')
  const totals = await tx.inventorySnapshot.aggregate({ where: { snapshotDate: date }, _count: { _all: true }, _sum: { valueBase: true } })
  const unreliable = await tx.inventorySnapshot.count({ where: { snapshotDate: date, valueReplayReliable: false } })
  if (!Number.isSafeInteger(unreliable) || unreliable < 0) return fail('basis_unreadable')
  if (unreliable > 0) return fail('unreliable_subledger_snapshot')
  const rowCount = totals._count._all
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || !Number.isSafeInteger(run.snapshotCount) || run.snapshotCount < 0) return fail('basis_unreadable')
  if (rowCount !== run.snapshotCount) return fail('subledger_snapshot_incomplete')
  // A sum of no rows is null: a run row with no rows is a true zero, a sum that is anything else non-finite is unreadable.
  const sum = rowCount === 0 && totals._sum.valueBase === null ? toDecimal(0) : finiteDecimal(totals._sum.valueBase)
  if (sum === null) return fail('basis_unreadable')
  if (rowCount === 0 && !sum.isZero()) return fail('basis_unreadable')

  const byKind = new Map(gl.map((g) => [g.kind, g]))
  const inventory = finiteDecimal(byKind.get('inventory')!.amountBase)!
  const allocated = finiteDecimal(byKind.get('allocated')!.amountBase)!
  const inventoryLegAbsent = byKind.get('inventory')!.provenance === 'absent-from-tb' || byKind.get('allocated')!.provenance === 'absent-from-tb'
  // The change token: a digest of everything this basis rests on, as stored, update times included. Two reads with the same
  // token read the same evidence; an upsert of any balance row (whatever path wrote it) changes its update time.
  const stamp = (value: unknown) => (value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value))
  const changeToken = createHash('sha256').update(JSON.stringify({
    settings: settingRows.map((row) => [row.key, row.value]).sort(),
    tenant, currency,
    gl: glRows.map((row) => [row.accountCode, row.externalAccountId, row.parserVersion, stamp(row.balanceDate), row.currency, stamp(row.amountBase), row.sourcePayloadRef, row.tenantId, stamp(row.updatedAt)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    run: run.snapshotCount, rows: rowCount, sum: sum.toFixed(6), unreliable,
    transit: { leg: transit.leg, evidence: transit.evidence },
  })).digest('hex')
  return {
    ok: true,
    token: changeToken,
    basis: {
      available: true,
      asOf,
      currency,
      gl,
      absentFromTrialBalance: gl.filter((g) => g.provenance === 'absent-from-tb').map((g) => g.kind),
      sharedCodeKinds,
      subledger: { runPresent: true, rows: rowCount, valueBase: sum.toFixed(6), emptyProof: rowCount === 0 ? 'snapshot-run-row-present' : null },
      inventoryGl: inventoryLegAbsent ? null : evaluateAccountGlReconciliation({ subledgerValue: sum.toNumber(), glBalance: inventory.add(allocated).toNumber() }),
      inventoryGlWithheld: inventoryLegAbsent ? 'absent-from-tb' : null,
      transit: transit.leg,
    },
  }
}

/** The basis as read inside the run's liveness bracket; usable only through settleAsOfBasis. */
export type BasisRead = { readonly asOf: string | null; readonly date: Date | null; readonly resolved: Resolved | null }

function defaultRun(deps: BasisDeps) {
  return deps.run ?? (<T,>(fn: (tx: BasisTx) => Promise<T>) => withReadOnlySnapshot(fn as never) as Promise<T>)
}

/**
 * Read the basis for cycle date `asOf` (YYYY-MM-DD), INSIDE the run's liveness bracket (after its start read). The result
 * is not a basis: settleAsOfBasis turns it into one after the end read. Never throws.
 */
export async function readAsOfBasis(asOf: string, deps: BasisDeps = {}): Promise<BasisRead> {
  let date: Date
  try {
    if (typeof asOf !== 'string') return { asOf: null, date: null, resolved: null }
    date = normalizeBalanceDate(asOf)
    if (balanceDateString(date) !== asOf) return { asOf: null, date: null, resolved: null }
  } catch {
    return { asOf: null, date: null, resolved: null }
  }
  try {
    return { asOf, date, resolved: await defaultRun(deps)((tx) => readBasis(tx, asOf, date)) }
  } catch {
    return { asOf, date, resolved: null }
  }
}

/**
 * Settle a basis read AFTER the bracket's end read (`liveness` exists only once both reads are made). The evidence is read
 * again in a fresh read-only snapshot and must carry the same change token: anything written in between, by the scheduled
 * pull or an on-demand refresh, is BASIS_MOVED. Then the Xero balance-snapshot stream must have been fresh and unmoved at
 * both liveness reads. Never throws: a read error is `basis_unreadable`.
 */
export async function settleAsOfBasis(read: BasisRead, liveness: LivenessBracket, deps: BasisDeps = {}): Promise<AsOfBasis> {
  if (read.asOf === null || read.date === null) return unavailable(null, 'basis_unreadable')
  const { asOf, date, resolved } = read
  if (resolved === null) return unavailable(asOf, 'basis_unreadable')
  if (!resolved.ok) return unavailable(asOf, resolved.reason)
  let again: Resolved
  try {
    again = await defaultRun(deps)((tx) => readBasis(tx, asOf, date))
  } catch {
    return unavailable(asOf, 'basis_unreadable')
  }
  if (!again.ok || again.token !== resolved.token) return unavailable(asOf, 'basis_moved', 'BASIS_MOVED')
  // The stream check comes last on purpose: a specific missing-data reason is more useful than "stale".
  const stream = streamsVerdict(liveness, [BASIS_STREAM])
  if (!stream.ok) return unavailable(asOf, 'stream_not_fresh', stream.reason)
  return resolved.basis
}
