import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountingSyncType } from '../../app/generated/prisma/enums.ts'
import { INTEGRATION_OUTBOX_REGISTRY } from '../../lib/domain/integrations/outbox-registry.ts'
import {
  ACCOUNTING_POST_OUTBOX_OPERATION,
  ACCOUNTING_SYNC_TYPE_EXCLUSIONS,
  OUTBOX_OPERATION_EXCLUSIONS,
  WRITER_OWNERS,
  WRITER_OWNERSHIP_MAP,
  outboxOperationIsMapped,
  type OwnershipRow,
} from '../../lib/security/writer-ownership-map.ts'

/**
 * THE OWNERSHIP MAP IS COMPLETE AND SHRINK-ONLY.
 *
 * Every AccountingSyncType member and every outbox operation in the registry is either in exactly one map
 * row or in an explicit exclusion list with a reason. The exclusion lists may only shrink: the ceilings
 * below are the sizes at the time of writing; a new entry fails the test until a person decides, here,
 * that it really is not a destination write.
 *
 * Mutation (recorded in the PR): delete a sync type from its row => red; add an exclusion past the ceiling => red.
 */

const rows = WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]

const SYNC_TYPE_EXCLUSION_CEILING = 2
const OUTBOX_EXCLUSION_CEILING = 5

test('map shape: unique keys, every owner is a known owner, P0 is owned by nobody, no empty notes', () => {
  const keys = rows.map((row) => `${row.destination}.${row.operation}`)
  console.log(`# map: rows=${rows.length} unique=${new Set(keys).size}`)
  assert.ok(rows.length > 30)
  assert.equal(new Set(keys).size, keys.length, 'duplicate destination.operation')
  for (const row of rows) {
    for (const phase of ['P0', 'P1', 'P2'] as const) {
      assert.ok((WRITER_OWNERS as readonly string[]).includes(row.owners[phase]), `${row.destination}.${row.operation} ${phase}`)
    }
    assert.equal(row.owners.P0, 'nobody', `${row.destination}.${row.operation}: IMS and the incumbents are all untouched in P0`)
    assert.ok(row.note.length >= 10, `${row.destination}.${row.operation} needs a note`)
    assert.ok(!/o3d-[a-z0-9]{3,}/.test(`${row.operation} ${row.destination}`), 'no tracker ids in identifiers')
  }
})

test('owner answers of 2026-10-08 are in the map', () => {
  const owner = (key: string, phase: 'P1' | 'P2') => {
    const row = rows.find((candidate) => `${candidate.destination}.${candidate.operation}` === key)
    assert.ok(row, `${key} is mapped`)
    return row.owners[phase]
  }
  assert.equal(owner('woocommerce.product.meta', 'P1'), 'woo-mintsoft-plugin')
  assert.equal(owner('woocommerce.product.meta', 'P2'), 'IMS')
  assert.equal(owner('woocommerce.order.invoice-note', 'P1'), 'xeroom')
  assert.equal(owner('woocommerce.order.invoice-note', 'P2'), 'IMS')
  assert.equal(owner('woocommerce.order.invoice-document', 'P2'), 'IMS')
  assert.equal(owner('xero.sales.payment', 'P1'), 'nobody')
  assert.equal(owner('xero.sales.payment', 'P2'), 'IMS')
  assert.equal(owner('xero.sales.invoice', 'P2'), 'xeroom')
  assert.equal(owner('xero.sales.credit-note', 'P2'), 'xeroom')
  assert.equal(owner('woocommerce.order.withdrawal-outcome', 'P2'), 'woo-mintsoft-plugin')
  assert.equal(owner('woocommerce.order.trackship-reconcile', 'P2'), 'woo-mintsoft-plugin')
  assert.equal(owner('mintsoft.product.upsert', 'P2'), 'IMS')
  assert.equal(owner('mintsoft.order.cancel', 'P2'), 'IMS')
  assert.equal(owner('mintsoft.order.amend', 'P2'), 'unknown', 'amending a bridge-created order is not settled, so it stays in shadow')
  assert.equal(owner('mintsoft.order.create', 'P2'), 'IMS')
})

test('unknown owners are exactly the listed set (a change here is a decision, not an accident)', () => {
  const unknowns = rows
    .flatMap((row) => (['P1', 'P2'] as const).filter((phase) => row.owners[phase] === 'unknown').map((phase) => `${row.destination}.${row.operation}@${phase}`))
    .sort()
  console.log(`# unknown owners: ${unknowns.length}`)
  assert.deepEqual(unknowns, [
    'customer-email.despatch@P1',
    'customer-email.despatch@P2',
    'customer-email.invoice@P1',
    'customer-email.invoice@P2',
    'customer-email.order-confirmation@P1',
    'customer-email.order-confirmation@P2',
    'mintsoft.asn.create@P1',
    'mintsoft.order.amend@P2',
    'mintsoft.order.comment@P1',
    'woocommerce.fx-rates@P1',
    'woocommerce.stock@P1',
    'xero.daily-batch@P1',
    'xero.inventory.journals@P1',
    'xero.purchase.bill-attachment@P1',
    'xero.purchase.bill-payment@P1',
    'xero.purchase.bill@P1',
    'xero.purchase.supplier-credit@P1',
    'xero.tax-rate@P1',
    'xero.tax-rate@P2',
  ])
})

test('every AccountingSyncType member is in exactly one map row or an explicit exclusion; the exclusions only shrink', () => {
  const members = Object.values(AccountingSyncType) as string[]
  const owners = new Map<string, string[]>()
  for (const row of rows) {
    for (const type of row.accountingSyncTypes ?? []) owners.set(type, [...(owners.get(type) ?? []), `${row.destination}.${row.operation}`])
  }
  const excluded = Object.keys(ACCOUNTING_SYNC_TYPE_EXCLUSIONS)
  console.log(`# sync types: members=${members.length} mapped=${owners.size} excluded=${excluded.length} (ceiling ${SYNC_TYPE_EXCLUSION_CEILING})`)
  assert.ok(members.length >= 30, 'precondition: the enum was read')
  for (const member of members) {
    const mapped = owners.get(member) ?? []
    const isExcluded = excluded.includes(member)
    assert.ok(mapped.length + (isExcluded ? 1 : 0) === 1, `${member}: mapped in ${JSON.stringify(mapped)}, excluded ${isExcluded}; need exactly one`)
  }
  for (const type of owners.keys()) assert.ok(members.includes(type), `${type} is not an AccountingSyncType member`)
  for (const type of excluded) {
    assert.ok(members.includes(type), `exclusion ${type} is not an AccountingSyncType member`)
    assert.ok(ACCOUNTING_SYNC_TYPE_EXCLUSIONS[type]!.length > 20, `exclusion ${type} needs a reason`)
  }
  assert.ok(excluded.length <= SYNC_TYPE_EXCLUSION_CEILING, 'the sync-type exclusions may only shrink')
  assert.equal(
    owners.get('WC_INVOICE_NOTE')?.[0],
    'woocommerce.order.invoice-note',
    'a queued type whose destination is WooCommerce is mapped to woocommerce, not xero',
  )
})

test('every outbox registry operation is mapped or explicitly excluded; the exclusions only shrink', () => {
  const names = Object.entries(INTEGRATION_OUTBOX_REGISTRY).flatMap(([connector, operations]) => Object.keys(operations).map((operation) => `${connector}/${operation}`))
  const excluded = Object.keys(OUTBOX_OPERATION_EXCLUSIONS)
  const mapped = names.filter((name) => outboxOperationIsMapped(name))
  console.log(`# outbox operations: registry=${names.length} mapped=${mapped.length} excluded=${excluded.length} (ceiling ${OUTBOX_EXCLUSION_CEILING})`)
  assert.ok(names.length >= 10, 'precondition: the registry was read')
  assert.ok(names.includes(ACCOUNTING_POST_OUTBOX_OPERATION), 'the Xero carrier operation exists in the registry')
  for (const name of names) {
    assert.ok(outboxOperationIsMapped(name) !== excluded.includes(name), `${name}: must be mapped XOR excluded (mapped ${outboxOperationIsMapped(name)}, excluded ${excluded.includes(name)})`)
  }
  for (const name of excluded) {
    assert.ok(names.includes(name), `exclusion ${name} is not in the registry`)
    assert.ok(OUTBOX_OPERATION_EXCLUSIONS[name]!.length > 20, `exclusion ${name} needs a reason`)
  }
  for (const row of rows) for (const name of row.outboxOperations ?? []) assert.ok(names.includes(name), `${row.destination}.${row.operation} names ${name}, which is not in the registry`)
  assert.ok(excluded.length <= OUTBOX_EXCLUSION_CEILING, 'the outbox exclusions may only shrink')
})
