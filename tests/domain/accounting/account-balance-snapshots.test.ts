import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateAccountBalanceVarianceBase,
  findLatestAccountBalanceSnapshot,
  getAccountBalancePeriodMovement,
  AccountBalanceMovementWithheldError,
  MissingAccountBalanceSnapshotError,
  normalizeBalanceDate,
  persistAccountingAccountBalanceSnapshots,
  type AccountingAccountBalanceSnapshotRow,
} from '@/lib/domain/accounting/account-balance-snapshots'
import { toDecimal } from '@/lib/domain/math/decimal'

function makeSnapshot(overrides: Partial<AccountingAccountBalanceSnapshotRow>): AccountingAccountBalanceSnapshotRow {
  return {
    id: 'snapshot',
    connector: 'xero',
    externalAccountId: 'account-1',
    accountCode: '500',
    accountName: 'Inventory Asset',
    balanceDate: new Date('2026-06-01T00:00:00.000Z'),
    currency: 'GBP',
    amountForeign: toDecimal('0'),
    amountBase: toDecimal('0'),
    sourcePayloadRef: null,
    tenantId: null,
    syncRunId: null,
    fetchedAt: new Date('2026-06-01T01:00:00.000Z'),
    ...overrides,
  }
}

function snapshotClient(
  initial: AccountingAccountBalanceSnapshotRow[] = [],
  chart: { accountType: string | null; yearEnd: string | null } = { accountType: 'EXPENSE', yearEnd: '12-31' },
) {
  const rows = [...initial]
  return {
    rows,
    accountingAccount: { findFirst: async () => (chart.accountType === null ? null : { type: chart.accountType }) },
    setting: { findUnique: async () => (chart.yearEnd === null ? null : { value: chart.yearEnd }) },
    accountingAccountBalanceSnapshot: {
      async upsert(args: {
        where: { connector_externalAccountId_balanceDate_currency: { connector: string; externalAccountId: string; balanceDate: Date; currency: string } }
        create: Record<string, unknown>
        update: Record<string, unknown>
      }) {
        const key = args.where.connector_externalAccountId_balanceDate_currency
        const existing = rows.find((row) =>
          row.connector === key.connector &&
          row.externalAccountId === key.externalAccountId &&
          row.balanceDate.toISOString() === key.balanceDate.toISOString() &&
          row.currency === key.currency,
        )
        if (existing) {
          Object.assign(existing, args.update)
          return existing
        }
        const created = {
          id: `snapshot-${rows.length + 1}`,
          connector: args.create.connector,
          externalAccountId: args.create.externalAccountId,
          accountCode: args.create.accountCode,
          accountName: args.create.accountName,
          balanceDate: args.create.balanceDate,
          currency: args.create.currency,
          amountForeign: args.create.amountForeign,
          amountBase: args.create.amountBase,
          sourcePayloadRef: args.create.sourcePayloadRef,
          tenantId: args.create.tenantId,
          syncRunId: args.create.syncRunId,
          fetchedAt: args.create.fetchedAt,
        } as AccountingAccountBalanceSnapshotRow
        rows.push(created)
        return created
      },
      async findFirst(args: { where: Record<string, unknown>; orderBy: Array<Record<string, string>> }) {
        const where = args.where as {
          connector: string
          balanceDate: { lte: Date }
          currency?: string
          externalAccountId?: string
          accountCode?: string
        }
        return rows
          .filter((row) =>
            row.connector === where.connector &&
            row.balanceDate <= where.balanceDate.lte &&
            (!where.currency || row.currency === where.currency) &&
            (!where.externalAccountId || row.externalAccountId === where.externalAccountId) &&
            (!where.accountCode || row.accountCode === where.accountCode),
          )
          .sort((a, b) => b.balanceDate.getTime() - a.balanceDate.getTime() || b.fetchedAt.getTime() - a.fetchedAt.getTime() || b.id.localeCompare(a.id))[0] ?? null
      },
    },
  }
}

test('persistAccountingAccountBalanceSnapshots upserts by connector account date and currency', async () => {
  const client = snapshotClient()

  await persistAccountingAccountBalanceSnapshots([
    {
      connector: 'xero',
      externalAccountId: 'account-1',
      accountCode: '500',
      accountName: 'Inventory Asset',
      balanceDate: '2026-06-01',
      currency: 'gbp',
      amountForeign: '100.1234567',
      amountBase: '100.1234567',
      sourcePayloadRef: 'xero:trial-balance:2026-06-01',
    },
  ], client as never)
  const second = await persistAccountingAccountBalanceSnapshots([
    {
      connector: 'xero',
      externalAccountId: 'account-1',
      accountCode: '500',
      accountName: 'Inventory Asset',
      balanceDate: '2026-06-01',
      currency: 'GBP',
      amountForeign: '101.25',
      amountBase: '101.25',
      syncRunId: 'sync-2',
    },
  ], client as never)

  assert.equal(client.rows.length, 1)
  assert.equal(second.snapshots[0]?.amountBase.toFixed(6), '101.250000')
  assert.equal(second.snapshots[0]?.syncRunId, 'sync-2')
})

test('getAccountBalancePeriodMovement subtracts opening from closing balance in base currency', async () => {
  const client = snapshotClient([
    makeSnapshot({
      id: 'opening',
      externalAccountId: 'cogs-account',
      accountCode: '600',
      accountName: 'COGS',
      balanceDate: new Date('2026-05-31T00:00:00.000Z'),
      amountForeign: toDecimal('12.50'),
      amountBase: toDecimal('12.50'),
      fetchedAt: new Date('2026-05-31T01:00:00.000Z'),
    }),
    makeSnapshot({
      id: 'closing',
      externalAccountId: 'cogs-account',
      accountCode: '600',
      accountName: 'COGS',
      balanceDate: new Date('2026-06-30T00:00:00.000Z'),
      amountForeign: toDecimal('20.75'),
      amountBase: toDecimal('20.75'),
      fetchedAt: new Date('2026-06-30T01:00:00.000Z'),
    }),
  ])

  const movement = await getAccountBalancePeriodMovement({
    connector: 'xero',
    accountCode: '600',
    dateFrom: '2026-06-01',
    dateTo: '2026-06-30',
    currency: 'GBP',
  }, client as never)

  assert.equal(movement?.movementBase.toFixed(6), '8.250000')
})

test('calculateAccountBalanceVarianceBase subtracts accounting balance from IMS value', () => {
  assert.equal(calculateAccountBalanceVarianceBase('125.50', '120.25').toFixed(6), '5.250000')
})

test('getAccountBalancePeriodMovement throws when the opening snapshot is stale', async () => {
  const client = snapshotClient([
    makeSnapshot({
      id: 'stale-opening',
      externalAccountId: 'cogs-account',
      accountCode: '600',
      balanceDate: new Date('2026-01-31T00:00:00.000Z'),
      amountBase: toDecimal('12.50'),
    }),
    makeSnapshot({
      id: 'closing',
      externalAccountId: 'cogs-account',
      accountCode: '600',
      balanceDate: new Date('2026-06-30T00:00:00.000Z'),
      amountBase: toDecimal('20.75'),
    }),
  ])

  await assert.rejects(
    () => getAccountBalancePeriodMovement({
      connector: 'xero',
      accountCode: '600',
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      currency: 'GBP',
    }, client as never),
    (error) => {
      assert.equal(error instanceof MissingAccountBalanceSnapshotError, true)
      assert.equal((error as MissingAccountBalanceSnapshotError).reason, 'missing_previous_day_snapshot')
      assert.equal((error as MissingAccountBalanceSnapshotError).requiredBalanceDate, '2026-05-31')
      assert.equal((error as MissingAccountBalanceSnapshotError).foundBalanceDate, '2026-01-31')
      return true
    },
  )
})

test('getAccountBalancePeriodMovement throws when the previous-day opening snapshot is missing by default', async () => {
  const client = snapshotClient([
    makeSnapshot({
      id: 'two-day-old-opening',
      externalAccountId: 'cogs-account',
      accountCode: '600',
      balanceDate: new Date('2026-05-30T00:00:00.000Z'),
      amountBase: toDecimal('12.50'),
    }),
    makeSnapshot({
      id: 'closing',
      externalAccountId: 'cogs-account',
      accountCode: '600',
      balanceDate: new Date('2026-06-30T00:00:00.000Z'),
      amountBase: toDecimal('20.75'),
    }),
  ])

  await assert.rejects(
    () => getAccountBalancePeriodMovement({
      connector: 'xero',
      accountCode: '600',
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      currency: 'GBP',
    }, client as never),
    (error) => {
      assert.equal(error instanceof MissingAccountBalanceSnapshotError, true)
      assert.equal((error as MissingAccountBalanceSnapshotError).reason, 'missing_previous_day_snapshot')
      assert.equal((error as MissingAccountBalanceSnapshotError).requiredBalanceDate, '2026-05-31')
      assert.equal((error as MissingAccountBalanceSnapshotError).foundBalanceDate, '2026-05-30')
      return true
    },
  )
})

test('findLatestAccountBalanceSnapshot prefers external account id before account code', async () => {
  const client = snapshotClient([
    makeSnapshot({
      id: 'wanted-by-id',
      externalAccountId: 'account-x',
      accountCode: '500',
      balanceDate: new Date('2026-06-01T00:00:00.000Z'),
    }),
    makeSnapshot({
      id: 'newer-same-code',
      externalAccountId: 'account-y',
      accountCode: '500',
      balanceDate: new Date('2026-06-02T00:00:00.000Z'),
    }),
  ])

  const snapshot = await findLatestAccountBalanceSnapshot({
    connector: 'xero',
    externalAccountId: 'account-x',
    accountCode: '500',
    balanceDate: '2026-06-03',
    currency: 'GBP',
  }, client as never)

  assert.equal(snapshot?.id, 'wanted-by-id')
})

test('findLatestAccountBalanceSnapshot filters by currency', async () => {
  const client = snapshotClient([
    makeSnapshot({ id: 'gbp', accountCode: '500', currency: 'GBP', amountBase: toDecimal('10') }),
    makeSnapshot({ id: 'usd', accountCode: '500', currency: 'USD', amountBase: toDecimal('20') }),
  ])

  const snapshot = await findLatestAccountBalanceSnapshot({
    connector: 'xero',
    accountCode: '500',
    balanceDate: '2026-06-03',
    currency: 'USD',
  }, client as never)

  assert.equal(snapshot?.id, 'usd')
})

test('normalizeBalanceDate rejects invalid date strings', () => {
  assert.throws(() => normalizeBalanceDate('2026-02-30'), /real calendar date/)
  assert.throws(() => normalizeBalanceDate('2026/02/28'), /YYYY-MM-DD/)
})

// [mutation: tenantId left out of the update arm / the create arm]
test('the organisation a balance was fetched under is stored, and a later pull under another organisation replaces it', async () => {
  const client = snapshotClient()
  const base = { connector: 'xero', externalAccountId: 'account-1', accountCode: '500', accountName: 'Inventory Asset', balanceDate: '2026-06-01', currency: 'GBP', amountForeign: '1', amountBase: '1' }
  await persistAccountingAccountBalanceSnapshots([{ ...base, tenantId: ' tenant-a ' }], client as never)
  assert.equal(client.rows[0]!.tenantId, 'tenant-a')
  await persistAccountingAccountBalanceSnapshots([{ ...base, tenantId: 'tenant-b' }], client as never)
  assert.equal(client.rows.length, 1)
  assert.equal(client.rows[0]!.tenantId, 'tenant-b')
  await persistAccountingAccountBalanceSnapshots([{ ...base }], client as never)
  assert.equal(client.rows[0]!.tenantId, null, 'a pull that cannot name its organisation records none, not the previous one')
})

// P&L accounts are year-to-date in a Trial Balance: they restart at the financial-year start.
function windowRows(openingDate: string, closingDate: string) {
  const base = { externalAccountId: 'cogs-account', accountCode: '600', accountName: 'COGS' }
  return [
    makeSnapshot({ ...base, id: 'o', balanceDate: new Date(`${openingDate}T00:00:00.000Z`), amountBase: toDecimal('900'), amountForeign: toDecimal('900') }),
    makeSnapshot({ ...base, id: 'c', balanceDate: new Date(`${closingDate}T00:00:00.000Z`), amountBase: toDecimal('40'), amountForeign: toDecimal('40') }),
  ]
}
const lookup = (dateFrom: string, dateTo: string) => ({ connector: 'xero', accountCode: '600', dateFrom, dateTo, currency: 'GBP' })

test('a profit-and-loss account is WITHHELD, not differenced, when the window crosses the financial-year start', async () => {
  const client = snapshotClient(windowRows('2026-12-30', '2027-01-02'), { accountType: 'DIRECTCOSTS', yearEnd: '12-31' })
  await assert.rejects(
    () => getAccountBalancePeriodMovement(lookup('2026-12-31', '2027-01-02'), client as never),
    (error) => error instanceof AccountBalanceMovementWithheldError && error.reason === 'window_crosses_financial_year_start',
  )
})

test('the financial-year start day itself is inside the window; the day before is not', async () => {
  const crossing = snapshotClient(windowRows('2026-12-31', '2027-01-01'), { accountType: 'EXPENSE', yearEnd: '12-31' })
  await assert.rejects(() => getAccountBalancePeriodMovement(lookup('2027-01-01', '2027-01-01'), crossing as never), AccountBalanceMovementWithheldError)
  const inside = snapshotClient(windowRows('2026-12-30', '2026-12-31'), { accountType: 'EXPENSE', yearEnd: '12-31' })
  assert.equal((await getAccountBalancePeriodMovement(lookup('2026-12-31', '2026-12-31'), inside as never)).movementBase.toFixed(2), '-860.00')
})

test('a profit-and-loss window inside one financial year is a plain difference', async () => {
  const client = snapshotClient(windowRows('2026-05-31', '2026-06-30'), { accountType: 'EXPENSE', yearEnd: '03-31' })
  assert.equal((await getAccountBalancePeriodMovement(lookup('2026-06-01', '2026-06-30'), client as never)).movementBase.toFixed(2), '-860.00')
})

test('a non-calendar year end (31 March) is honoured', async () => {
  const client = snapshotClient(windowRows('2026-03-30', '2026-04-02'), { accountType: 'REVENUE', yearEnd: '03-31' })
  await assert.rejects(() => getAccountBalancePeriodMovement(lookup('2026-03-31', '2026-04-02'), client as never), AccountBalanceMovementWithheldError)
})

test('a profit-and-loss account with an unknown financial-year end is withheld', async () => {
  for (const yearEnd of [null, 'garbage', '02-30']) {
    const client = snapshotClient(windowRows('2026-05-31', '2026-06-30'), { accountType: 'EXPENSE', yearEnd })
    await assert.rejects(
      () => getAccountBalancePeriodMovement(lookup('2026-06-01', '2026-06-30'), client as never),
      (error) => error instanceof AccountBalanceMovementWithheldError && error.reason === 'financial_year_end_unknown',
      String(yearEnd),
    )
  }
})

test('a balance-sheet account (lifetime balance) is differenced across a financial-year start', async () => {
  for (const accountType of ['INVENTORY', 'CURRENT', 'CURRLIAB', 'ASSET']) {
    const client = snapshotClient(windowRows('2026-12-30', '2027-01-02'), { accountType, yearEnd: '12-31' })
    assert.equal((await getAccountBalancePeriodMovement(lookup('2026-12-31', '2027-01-02'), client as never)).movementBase.toFixed(2), '-860.00', accountType)
  }
})

test('an account the chart does not know is treated as profit-and-loss (withheld, not guessed)', async () => {
  const client = snapshotClient(windowRows('2026-12-30', '2027-01-02'), { accountType: null, yearEnd: '12-31' })
  await assert.rejects(() => getAccountBalancePeriodMovement(lookup('2026-12-31', '2027-01-02'), client as never), AccountBalanceMovementWithheldError)
})
