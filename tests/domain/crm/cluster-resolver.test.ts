import assert from 'node:assert/strict'
import test from 'node:test'

import {
  derivedLink,
  erasureOrder,
  effectiveLink,
  newestOperatorDecisions,
  resolveCluster,
  type ClusterCustomer,
  type OperatorDecision,
} from '@/lib/domain/crm/cluster-resolver'

const c = (id: string, email: string | null, anonymised = false): ClusterCustomer => ({ id, email, anonymised })
const d = (customerId: string, otherCustomerId: string, kind: 'MERGE' | 'UNMERGE', seq: number): OperatorDecision => ({ customerId, otherCustomerId, kind, seq: BigInt(seq) })

test('the owner identity rule: case, +tag and Gmail dots all fold to one person', () => {
  const customers = [c('a', 'Jane.Doe@Gmail.com'), c('b', 'janedoe+shop@googlemail.com'), c('c', ' janedoe@gmail.com '), c('z', 'other@gmail.com')]
  assert.deepEqual(resolveCluster('b', customers, []), ['a', 'b', 'c'])
  assert.deepEqual(resolveCluster('z', customers, []), ['z'])
})

test('a non-Gmail address folds case and +tag but NOT dots', () => {
  const customers = [c('a', 'first.last@example.com'), c('b', 'firstlast@example.com'), c('c', 'First.Last+x@Example.com')]
  assert.deepEqual(resolveCluster('a', customers, []), ['a', 'c'])
})

test('owner 2026-11-19: aliases of one mailbox are one person, so the cluster does not look at storefront ids at all', () => {
  // WooCommerce cannot hold the same email on two accounts: two accounts for jane@x.com and jane+shop@x.com are one person (two different storefront ids).
  assert.equal(derivedLink(c('a', 'jane@example.com'), c('b', 'jane+shop@example.com')), true)
  // the three-record case from the review: account, guest record and a second account all join through the shared folded key
  const customers = [c('acct5', 'jane@gmail.com'), c('guest', 'j.ane@gmail.com'), c('acct9', 'jane+z@gmail.com')]
  assert.deepEqual(resolveCluster('acct5', customers, []), ['acct5', 'acct9', 'guest'])
  assert.deepEqual(resolveCluster('acct9', customers, []), ['acct5', 'acct9', 'guest'])
  assert.equal(Object.keys(customers[0]!).includes('storefrontIds'), false)
})

test('an anonymised customer is never in a live cluster, and a placeholder or empty email never joins anyone', () => {
  const customers = [c('a', 'x@example.com'), c('b', 'x@example.com', true), c('p', 'deleted@site.invalid'), c('q', 'deleted@site.invalid'), c('n', null), c('m', null)]
  assert.deepEqual(resolveCluster('a', customers, []), ['a'])
  assert.deepEqual(resolveCluster('b', customers, []), ['b'])
  assert.deepEqual(resolveCluster('p', customers, []), ['p'])
  assert.deepEqual(resolveCluster('n', customers, []), ['n'])
})

test('the newest operator row decides a pair: UNMERGE beats the email rule, a later MERGE beats the UNMERGE', () => {
  const customers = [c('a', 'x@example.com'), c('b', 'x+tag@example.com')]
  assert.deepEqual(resolveCluster('a', customers, [d('a', 'b', 'UNMERGE', 1)]), ['a'])
  assert.deepEqual(resolveCluster('a', customers, [d('a', 'b', 'UNMERGE', 1), d('a', 'b', 'MERGE', 2)]), ['a', 'b'])
  assert.deepEqual(resolveCluster('a', customers, [d('a', 'b', 'MERGE', 1), d('a', 'b', 'UNMERGE', 2)]), ['a'])
  assert.equal(newestOperatorDecisions([d('a', 'b', 'MERGE', 5), d('b', 'a', 'UNMERGE', 3)]).get('a|b')!.kind, 'MERGE', 'order of input and of the pair does not matter')
})

test('an operator MERGE joins customers whose emails differ; it is inert when one is anonymised', () => {
  const customers = [c('a', 'one@example.com'), c('b', 'two@example.org'), c('x', 'three@example.net', true)]
  assert.deepEqual(resolveCluster('a', customers, [d('a', 'b', 'MERGE', 1)]), ['a', 'b'])
  assert.deepEqual(resolveCluster('a', customers, [d('a', 'x', 'MERGE', 1)]), ['a'])
  assert.equal(effectiveLink(customers[0]!, customers[2]!, d('a', 'x', 'MERGE', 1)), false)
})

test('the cluster is transitive, and separating one member leaves the others together', () => {
  const customers = [c('a', 'p@example.com'), c('b', 'p+1@example.com'), c('c', 'p+2@example.com')]
  const split = [d('a', 'b', 'UNMERGE', 1), d('a', 'c', 'UNMERGE', 2)]
  assert.deepEqual(resolveCluster('a', customers, split), ['a'])
  assert.deepEqual(resolveCluster('b', customers, split), ['b', 'c'])
  // blocking only one pair does not split a cluster that is still connected through a third member
  assert.deepEqual(resolveCluster('a', customers, [d('a', 'b', 'UNMERGE', 1)]), ['a', 'b', 'c'])
})

test('an unknown seed is a cluster of itself', () => {
  assert.deepEqual(resolveCluster('missing', [c('a', 'x@example.com')], []), ['missing'])
})

test('the erasure order puts the members that hold the cluster together last, and the requested customer at the very end', () => {
  // chain a - b - c: b links the other two (a MERGE joins b-c, the email joins a-b)
  const customers = [c('a', 'p@example.com'), c('b', 'p+1@example.com'), c('c', 'other@example.org')]
  const merge = [d('b', 'c', 'MERGE', 1)]
  const ids = resolveCluster('a', customers, merge)
  assert.deepEqual(ids, ['a', 'b', 'c'])
  assert.deepEqual(erasureOrder('a', ids, customers, merge), ['c', 'b', 'a'])
  // from the other end the linking member is still second-to-last, the requested customer last
  assert.deepEqual(erasureOrder('c', ids, customers, merge), ['a', 'b', 'c'])
  // from the middle: both leaves first, the requested linking member last
  assert.deepEqual(erasureOrder('b', ids, customers, merge), ['a', 'c', 'b'])
  // a clique has no linking member: id order, seed last
  const clique = [c('x', 'q@example.com'), c('y', 'q+1@example.com'), c('z', 'q+2@example.com')]
  assert.deepEqual(erasureOrder('y', ['x', 'y', 'z'], clique, []), ['x', 'z', 'y'])
})
