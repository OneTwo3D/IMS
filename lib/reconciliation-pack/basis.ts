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
 *     - the Xero balance-snapshot stream was fresh and unmoved at both liveness reads.
 *   Otherwise the first failing reason (a closed code), never a substitute date and never a default.
 *
 * Every IMS read is made in ONE READ ONLY REPEATABLE READ transaction with a statement timeout (read-tx.ts). Stored
 * snapshots only: no vendor call, no write, no network. The comparison of the subledger with Inventory plus Allocated
 * is the existing pure `evaluateAccountGlReconciliation`, unchanged.
 *
 * Text safety: a result carries closed reason codes, account KINDS, counts and decimal strings. It does not carry an
 * account code, an account name or any stored text.
 */

import { Prisma } from '@/app/generated/prisma/client'
import { balanceDateString, normalizeBalanceDate } from '@/lib/domain/accounting/account-balance-snapshots'
import { evaluateAccountGlReconciliation, type AccountGlReconciliation } from '@/lib/domain/accounting/account-gl-reconciliation'
import { toDecimal } from '@/lib/domain/math/decimal'
import { xeroTrialBalanceRef } from '@/lib/connectors/xero/account-balance-refs'
import { INTEGRATION_PLUGIN_SETTING_KEYS, parseIntegrationPluginEnabled } from '@/lib/integration-plugin-keys'
import { streamsVerdict, type LivenessBracket } from '@/lib/reconciliation-pack/liveness'
import { PACK_BASIS_ACCOUNTS, type PackBasisAccountKind, type PackBasisReason, type PackEmptyProofCode, type PackReasonCode } from '@/lib/reconciliation-pack/constants'
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
      /** The existing evaluator over the subledger and Inventory plus Allocated, unchanged. */
      inventoryGl: AccountGlReconciliation
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
  balanceDate: Date
  currency: string
  amountBase: unknown
  sourcePayloadRef: string | null
  tenantId: string | null
}

export type BasisTx = {
  setting: { findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true } }): Promise<Array<{ key: string; value: string }>> }
  accountingToken: { findUnique(args: { where: { connector: string }; select: { tenantId: true } }): Promise<{ tenantId: string } | null> }
  organisation: { findFirst(args: { select: { baseCurrency: true } }): Promise<{ baseCurrency: string | null } | null> }
  accountingAccountBalanceSnapshot: {
    findMany(args: { where: { connector: string; currency: string; accountCode: { in: string[] }; balanceDate: Date }; select: { accountCode: true; balanceDate: true; currency: true; amountBase: true; sourcePayloadRef: true; tenantId: true } }): Promise<BasisGlRow[]>
    count(args: { where: { connector: string; currency: string; accountCode: string; tenantId: string } }): Promise<number>
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

const SETTING_KEYS = [INTEGRATION_PLUGIN_SETTING_KEYS.xero, ...PACK_BASIS_ACCOUNTS.map((a) => a.settingKey)]

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

type Resolved = { ok: true; basis: AsOfBasis & { available: true } } | { ok: false; reason: PackBasisReason }

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
  const sharedCodeKinds: PackBasisAccountKind[] = []
  const firstKindOfCode = new Map<string, PackBasisAccountKind>()
  for (const account of PACK_BASIS_ACCOUNTS) {
    const code = codes.get(account.kind)!
    if (firstKindOfCode.has(code)) sharedCodeKinds.push(account.kind)
    else firstKindOfCode.set(code, account.kind)
  }

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
    where: { connector: BASIS_CONNECTOR, currency, accountCode: { in: wanted }, balanceDate: date },
    select: { accountCode: true, balanceDate: true, currency: true, amountBase: true, sourcePayloadRef: true, tenantId: true },
  })
  const gl: BasisGlBalance[] = []
  let failure: PackBasisReason | null = null
  const note = (reason: PackBasisReason) => { failure ??= reason }
  for (const account of PACK_BASIS_ACCOUNTS) {
    const code = codes.get(account.kind)!
    const forAccount = glRows.filter((row) => row.accountCode === code)
    const own = forAccount.filter((row) => row.tenantId === tenant)
    if (own.length === 0 && forAccount.length > 0) { note('gl_snapshot_other_tenant'); continue }
    if (own.length === 0) {
      // Say whether the account has ANY stored balance of this organisation: a different date is `not_for_date`, never a stand-in.
      const anyDate = await tx.accountingAccountBalanceSnapshot.count({ where: { connector: BASIS_CONNECTOR, currency, accountCode: code, tenantId: tenant } })
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
  return {
    ok: true,
    basis: {
      available: true,
      asOf,
      currency,
      gl,
      absentFromTrialBalance: gl.filter((g) => g.provenance === 'absent-from-tb').map((g) => g.kind),
      sharedCodeKinds,
      subledger: { runPresent: true, rows: rowCount, valueBase: sum.toFixed(6), emptyProof: rowCount === 0 ? 'snapshot-run-row-present' : null },
      inventoryGl: evaluateAccountGlReconciliation({ subledgerValue: sum.toNumber(), glBalance: inventory.add(allocated).toNumber() }),
    },
  }
}

/**
 * Load the basis for cycle date `asOf` (YYYY-MM-DD). `liveness` is the run's bracket: the Xero balance-snapshot
 * stream must have been fresh and unmoved at both of its reads. Never throws: a read error is `basis_unreadable`.
 */
export async function loadAsOfBasis(asOf: string, liveness: LivenessBracket, deps: BasisDeps = {}): Promise<AsOfBasis> {
  let date: Date
  try {
    if (typeof asOf !== 'string') return unavailable(null, 'basis_unreadable')
    date = normalizeBalanceDate(asOf)
    if (balanceDateString(date) !== asOf) return unavailable(null, 'basis_unreadable')
  } catch {
    return unavailable(null, 'basis_unreadable')
  }
  let resolved: Resolved
  try {
    const run = deps.run ?? (<T,>(fn: (tx: BasisTx) => Promise<T>) => withReadOnlySnapshot(fn as never) as Promise<T>)
    resolved = await run((tx) => readBasis(tx, asOf, date))
  } catch {
    return unavailable(asOf, 'basis_unreadable')
  }
  if (!resolved.ok) return unavailable(asOf, resolved.reason)
  // The stream check comes last on purpose: a specific missing-data reason is more useful than "stale".
  const stream = streamsVerdict(liveness, [BASIS_STREAM])
  if (!stream.ok) return unavailable(asOf, 'stream_not_fresh', stream.reason)
  return resolved.basis
}
