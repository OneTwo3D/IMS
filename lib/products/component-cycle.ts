import { db } from '@/lib/db'

export type ComponentCycleResult =
  | { kind: 'ok' }
  | { kind: 'self' }
  | { kind: 'cycle' }

/**
 * Detect self-reference or circular references in the product component graph.
 *
 * `self` — one of `componentIds` is `productId` directly.
 * `cycle` — a path through existing `productComponent` rows leads back to `productId`.
 */
export async function detectComponentCycle(
  productId: string,
  componentIds: string[],
): Promise<ComponentCycleResult> {
  if (componentIds.some((id) => id === productId)) return { kind: 'self' }

  const visited = new Set<string>()
  const queue = [...componentIds]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === productId) return { kind: 'cycle' }
    if (visited.has(current)) continue
    visited.add(current)

    const children = await db.productComponent.findMany({
      where: { productId: current },
      select: { componentId: true },
    })
    for (const child of children) queue.push(child.componentId)
  }

  return { kind: 'ok' }
}
