import assert from 'node:assert/strict'
import test from 'node:test'

import {
  derivedLink,
  effectiveLink,
  newestOperatorDecisions,
  resolveCluster,
  type ClusterCustomer,
  type OperatorDecision,
} from '@/lib/domain/crm/cluster-resolver'

const c = (id: string, email: string | null, storefrontIds: string[] = [], anonymised = false): ClusterCustomer => ({ id, email, storefrontIds, anonymised })
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

test('two different storefront accounts are two people even with the same email; one shared id or none recorded still joins', () => {
  assert.equal(derivedLink(c('a', 'x@example.com', ['10']), c('b', 'x@example.com', ['11'])), false)
  assert.equal(derivedLink(c('a', 'x@example.com', ['10']), c('b', 'x@example.com', ['10', '11'])), true)
  assert.equal(derivedLink(c('a', 'x@example.com', ['10']), c('b', 'x@example.com', [])), true)
})

test('an anonymised customer is never in a live cluster, and a placeholder or empty email never joins anyone', () => {
  const customers = [c('a', 'x@example.com'), c('b', 'x@example.com', [], true), c('p', 'deleted@site.invalid'), c('q', 'deleted@site.invalid'), c('n', null), c('m', null)]
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
  const customers = [c('a', 'one@example.com'), c('b', 'two@example.org'), c('x', 'three@example.net', [], true)]
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
