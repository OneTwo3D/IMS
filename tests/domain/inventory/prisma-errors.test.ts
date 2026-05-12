import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  getInventoryConstraintMessage,
  toInventoryConstraintMessage,
} from '@/lib/domain/inventory/prisma-errors'

test('maps Prisma check constraint metadata to a user-safe inventory message', () => {
  const error = new Prisma.PrismaClientKnownRequestError('Check constraint failed', {
    code: 'P2004',
    clientVersion: 'test',
    meta: {
      database_error: 'new row for relation "stock_levels" violates check constraint "stock_levels_reserved_nonnegative"',
    },
  })

  assert.equal(
    getInventoryConstraintMessage(error),
    'Reserved stock would become negative. Reload and retry after checking recent allocations or dispatches.',
  )
})

test('maps plain error messages that mention FIFO constraints', () => {
  const error = new Error('update failed: constraint "cost_layers_remaining_qty_non_negative"')

  assert.equal(
    toInventoryConstraintMessage(error, 'fallback'),
    'FIFO remaining quantity would become negative. Reload and retry after checking recent stock activity.',
  )
})

test('falls back when the error is unrelated to inventory constraints', () => {
  const error = new Error('something unrelated')

  assert.equal(getInventoryConstraintMessage(error), null)
  assert.equal(toInventoryConstraintMessage(error, 'fallback message'), 'something unrelated')
})
