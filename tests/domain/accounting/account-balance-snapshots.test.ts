import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateAccountBalanceVarianceBase,
  findLatestAccountBalanceSnapshot,
  getAccountBalancePeriodMovement,
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
    syncRunId: null,
    fetchedAt: new Date('2026-06-01T01:00:00.000Z'),
    ...overrides,
  }
}

function snapshotClient(initial: AccountingAccountBalanceSnapshotRow[] = []) {
  const rows = [...initial]
  return {
    rows,
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
