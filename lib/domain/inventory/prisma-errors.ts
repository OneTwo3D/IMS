import { Prisma } from '@/app/generated/prisma/client'

const INVENTORY_CONSTRAINT_MESSAGES = [
  {
    constraint: 'stock_levels_quantity_nonnegative',
    message: 'Stock quantity would become negative. Reload and retry after checking recent stock activity.',
  },
  {
    constraint: 'stock_levels_reserved_nonnegative',
    message: 'Reserved stock would become negative. Reload and retry after checking recent allocations or dispatches.',
  },
  {
    constraint: 'stock_levels_reserved_qty_lte_quantity',
    message: 'Reserved stock cannot exceed physical stock. Resolve the overallocation before retrying.',
  },
  {
    constraint: 'cost_layers_received_nonnegative',
    message: 'FIFO received quantity cannot be negative. Check the source stock movement before retrying.',
  },
  {
    constraint: 'cost_layers_remaining_qty_non_negative',
    message: 'FIFO remaining quantity would become negative. Reload and retry after checking recent stock activity.',
  },
  {
    constraint: 'cost_layers_remaining_qty_lte_received_qty',
    message: 'FIFO remaining quantity cannot exceed the received quantity. Check the source stock movement before retrying.',
  },
  {
    constraint: 'stock_movements_qty_nonnegative',
    message: 'Stock movement quantity must be zero or greater.',
  },
] as const

function collectInventoryErrorFragments(error: unknown): string[] {
  const fragments: string[] = []

  if (error instanceof Error) {
    fragments.push(error.message)
    const cause = error.cause
    if (typeof cause === 'string') fragments.push(cause)
    else if (cause instanceof Error) fragments.push(cause.message)
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.meta) fragments.push(JSON.stringify(error.meta))
  } else if (typeof error === 'object' && error !== null) {
    const maybeConstraint = 'constraint' in error ? error.constraint : undefined
    if (typeof maybeConstraint === 'string') fragments.push(maybeConstraint)
    const maybeCode = 'code' in error ? error.code : undefined
    if (typeof maybeCode === 'string') fragments.push(maybeCode)
    const maybeDetail = 'detail' in error ? error.detail : undefined
    if (typeof maybeDetail === 'string') fragments.push(maybeDetail)
  }

  if (typeof error === 'string') fragments.push(error)

  return fragments
}

export function getInventoryConstraintMessage(error: unknown): string | null {
  const haystack = collectInventoryErrorFragments(error).join('\n')
  if (!haystack) return null

  const match = INVENTORY_CONSTRAINT_MESSAGES.find(({ constraint }) => haystack.includes(constraint))
  return match?.message ?? null
}

export function toInventoryConstraintMessage(error: unknown, fallback: string): string {
  return getInventoryConstraintMessage(error)
    ?? (error instanceof Error && error.message ? error.message : fallback)
}
