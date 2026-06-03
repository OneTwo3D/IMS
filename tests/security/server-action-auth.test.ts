import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('shopping product link server action requires an authenticated session', async () => {
  const source = await readFile('app/actions/shopping.ts', 'utf8')
  const actionStart = source.indexOf('export async function fetchShoppingProductLink')
  assert.notEqual(actionStart, -1)

  const actionSource = source.slice(actionStart)
  const authCallIndex = actionSource.indexOf('await requireAuth()')
  const linkCallIndex = actionSource.indexOf('getExternalProductLink')

  assert.notEqual(authCallIndex, -1)
  assert.notEqual(linkCallIndex, -1)
  assert.ok(authCallIndex < linkCallIndex)
})
