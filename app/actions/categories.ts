'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import {
  buildProductCategoryPathDisplay,
  buildProductCategoryPathMap,
  buildProductCategoryPathNormalized,
  cleanProductCategoryName,
  listProductCategoryNodes,
  listProductCategoryOptions,
  parseProductCategoryPath,
  PRODUCT_CATEGORY_NAME_MAX_LENGTH,
  type ProductCategoryNode,
  type ProductCategoryOption,
} from '@/lib/products/categories'

export type CategoryActionResult =
  | { ok: true; categoryId: string }
  | { ok: false; error: string }

export type DeleteCategoryResult =
  | { ok: true; promotedChildren: number; reassignedProducts: number }
  | { ok: false; error: string }

const NameSchema = z.string().max(PRODUCT_CATEGORY_NAME_MAX_LENGTH * 4, 'Name too long')
const IdSchema = z.string().min(1, 'Missing id')

export async function listCategoryTree(): Promise<ProductCategoryNode[]> {
  await requireAuth()
  return listProductCategoryNodes()
}

export async function createCategory(input: {
  name: string
  parentId?: string | null
}): Promise<CategoryActionResult> {
  await requirePermission('inventory.edit')
  const rawName = NameSchema.safeParse(input.name)
  if (!rawName.success) return { ok: false, error: rawName.error.issues[0]?.message ?? 'Invalid name' }
  const segments = parseProductCategoryPath(rawName.data)
  if (segments.length === 0) return { ok: false, error: 'Name is required' }
  if (segments.length > 1) {
    return { ok: false, error: `Use the parent picker instead of '${segments.join(' > ')}'.` }
  }
  for (const segment of segments) {
    if (segment.length > PRODUCT_CATEGORY_NAME_MAX_LENGTH) {
      return { ok: false, error: `Name must be ${PRODUCT_CATEGORY_NAME_MAX_LENGTH} characters or fewer` }
    }
  }
  const leafName = segments[0]
  const parentId = input.parentId ?? null

  const options = await listProductCategoryOptions()
  const pathMap = buildProductCategoryPathMap(options)
  const parentPath = parentId ? pathMap.get(parentId) : null
  if (parentId && !parentPath) {
    return { ok: false, error: 'Parent category not found' }
  }
  const ancestrySegments = parentPath ? parseProductCategoryPath(parentPath) : []
  const nameNormalized = buildProductCategoryPathNormalized([...ancestrySegments, leafName])

  try {
    const existing = await db.productCategory.findUnique({ where: { nameNormalized } })
    if (existing) return { ok: false, error: 'A category with that name already exists at this level' }
    const created = await db.productCategory.create({
      data: { name: leafName, nameNormalized, parentId },
      select: { id: true },
    })
    await logActivity({
      entityType: 'SETTING',
      entityId: created.id,
      tag: 'inventory',
      action: 'created',
      description: `Created product category: ${parentPath ? `${parentPath} > ${leafName}` : leafName}`,
    })
    revalidatePath('/settings/inventory/categories')
    revalidatePath('/inventory')
    return { ok: true, categoryId: created.id }
  } catch (err) {
    await logActivity({
      entityType: 'SETTING',
      tag: 'inventory',
      action: 'created',
      level: 'ERROR',
      description: `Failed to create product category: ${leafName}`,
    })
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to create category' }
  }
}

export async function renameCategory(input: { id: string; name: string }): Promise<CategoryActionResult> {
  await requirePermission('inventory.edit')
  const idParse = IdSchema.safeParse(input.id)
  if (!idParse.success) return { ok: false, error: 'Missing id' }
  const cleaned = cleanProductCategoryName(input.name)
  if (!cleaned) return { ok: false, error: 'Name is required' }
  if (cleaned.length > PRODUCT_CATEGORY_NAME_MAX_LENGTH) {
    return { ok: false, error: `Name must be ${PRODUCT_CATEGORY_NAME_MAX_LENGTH} characters or fewer` }
  }
  if (cleaned.includes('>')) {
    return { ok: false, error: "Name cannot contain '>'" }
  }

  try {
    await db.$transaction(async (tx) => {
      const target = await tx.productCategory.findUnique({
        where: { id: idParse.data },
        select: { id: true, name: true, parentId: true },
      })
      if (!target) throw new Error('Category not found')
      if (target.name === cleaned) return // no-op

      const options = await tx.productCategory.findMany({ select: { id: true, name: true, parentId: true } })
      const pathMap = buildProductCategoryPathMap(options)
      const parentPath = target.parentId ? pathMap.get(target.parentId) : null
      const newAncestrySegments = parentPath ? parseProductCategoryPath(parentPath) : []
      const newNameNormalized = buildProductCategoryPathNormalized([...newAncestrySegments, cleaned])

      const clash = await tx.productCategory.findUnique({ where: { nameNormalized: newNameNormalized } })
      if (clash && clash.id !== target.id) {
        throw new Error('A category with that name already exists at this level')
      }

      await renameSubtree(tx, target.id, cleaned, options)
    })
    await logActivity({
      entityType: 'SETTING',
      entityId: idParse.data,
      tag: 'inventory',
      action: 'updated',
      description: `Renamed product category to: ${cleaned}`,
    })
    revalidatePath('/settings/inventory/categories')
    revalidatePath('/inventory')
    return { ok: true, categoryId: idParse.data }
  } catch (err) {
    await logActivity({
      entityType: 'SETTING',
      entityId: idParse.data,
      tag: 'inventory',
      action: 'updated',
      level: 'ERROR',
      description: `Failed to rename product category`,
    })
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to rename category' }
  }
}

export async function moveCategory(input: {
  id: string
  newParentId: string | null
}): Promise<CategoryActionResult> {
  await requirePermission('inventory.edit')
  const idParse = IdSchema.safeParse(input.id)
  if (!idParse.success) return { ok: false, error: 'Missing id' }

  try {
    await db.$transaction(async (tx) => {
      const target = await tx.productCategory.findUnique({
        where: { id: idParse.data },
        select: { id: true, name: true, parentId: true },
      })
      if (!target) throw new Error('Category not found')
      if (target.parentId === input.newParentId) return // no-op

      const options = await tx.productCategory.findMany({ select: { id: true, name: true, parentId: true } })
      if (input.newParentId) {
        const descendantIds = collectDescendantIds(target.id, options)
        if (input.newParentId === target.id || descendantIds.has(input.newParentId)) {
          throw new Error('Cannot move a category under itself or its descendants')
        }
      }

      await tx.productCategory.update({
        where: { id: target.id },
        data: { parentId: input.newParentId },
      })

      // Recompute normalized paths for target + descendants after re-parenting.
      const refreshed = await tx.productCategory.findMany({ select: { id: true, name: true, parentId: true } })
      const pathMap = buildProductCategoryPathMap(refreshed)
      const stack = [target.id, ...collectDescendantIds(target.id, refreshed)]
      for (const id of stack) {
        const display = pathMap.get(id)
        if (!display) continue
        const segments = parseProductCategoryPath(display)
        const nameNormalized = buildProductCategoryPathNormalized(segments)
        await tx.productCategory.update({ where: { id }, data: { nameNormalized } })
      }
    })
    await logActivity({
      entityType: 'SETTING',
      entityId: idParse.data,
      tag: 'inventory',
      action: 'updated',
      description: `Moved product category to ${input.newParentId ? 'new parent' : 'top level'}`,
    })
    revalidatePath('/settings/inventory/categories')
    revalidatePath('/inventory')
    return { ok: true, categoryId: idParse.data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to move category' }
  }
}

export async function deleteCategory(input: { id: string }): Promise<DeleteCategoryResult> {
  await requirePermission('inventory.edit')
  const idParse = IdSchema.safeParse(input.id)
  if (!idParse.success) return { ok: false, error: 'Missing id' }

  try {
    let promotedChildren = 0
    let reassignedProducts = 0
    await db.$transaction(async (tx) => {
      const target = await tx.productCategory.findUnique({
        where: { id: idParse.data },
        select: { id: true, parentId: true },
      })
      if (!target) throw new Error('Category not found')

      // Promote direct children to the deleted category's parent.
      const directChildren = await tx.productCategory.findMany({
        where: { parentId: target.id },
        select: { id: true },
      })
      promotedChildren = directChildren.length
      if (promotedChildren > 0) {
        await tx.productCategory.updateMany({
          where: { parentId: target.id },
          data: { parentId: target.parentId },
        })
      }

      // Reassign products linked to the deleted category to its parent (may be null).
      const updated = await tx.product.updateMany({
        where: { categoryId: target.id },
        data: { categoryId: target.parentId },
      })
      reassignedProducts = updated.count

      // Delete the target.
      await tx.productCategory.delete({ where: { id: target.id } })

      // Recompute normalized paths for the promoted children and their descendants.
      if (promotedChildren > 0) {
        const refreshed = await tx.productCategory.findMany({ select: { id: true, name: true, parentId: true } })
        const pathMap = buildProductCategoryPathMap(refreshed)
        const toUpdate = new Set<string>()
        for (const child of directChildren) {
          toUpdate.add(child.id)
          for (const desc of collectDescendantIds(child.id, refreshed)) toUpdate.add(desc)
        }
        for (const id of toUpdate) {
          const display = pathMap.get(id)
          if (!display) continue
          const segments = parseProductCategoryPath(display)
          const nameNormalized = buildProductCategoryPathNormalized(segments)
          await tx.productCategory.update({ where: { id }, data: { nameNormalized } })
        }
      }
    })
    await logActivity({
      entityType: 'SETTING',
      entityId: idParse.data,
      tag: 'inventory',
      action: 'deleted',
      description: `Deleted product category (promoted ${promotedChildren} child${promotedChildren === 1 ? '' : 'ren'}, reassigned ${reassignedProducts} product${reassignedProducts === 1 ? '' : 's'})`,
    })
    revalidatePath('/settings/inventory/categories')
    revalidatePath('/inventory')
    return { ok: true, promotedChildren, reassignedProducts }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to delete category' }
  }
}

function collectDescendantIds(rootId: string, options: readonly ProductCategoryOption[]): Set<string> {
  const childrenByParent = new Map<string, string[]>()
  for (const o of options) {
    if (!o.parentId) continue
    const arr = childrenByParent.get(o.parentId) ?? []
    arr.push(o.id)
    childrenByParent.set(o.parentId, arr)
  }
  const result = new Set<string>()
  const stack = [...(childrenByParent.get(rootId) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (result.has(id)) continue
    result.add(id)
    for (const childId of childrenByParent.get(id) ?? []) stack.push(childId)
  }
  return result
}

type TxCategoryClient = {
  productCategory: {
    findMany: (args: { select: { id: true; name: true; parentId: true } }) => Promise<ProductCategoryOption[]>
    update: (args: { where: { id: string }; data: { name?: string; nameNormalized?: string } }) => Promise<unknown>
  }
}

async function renameSubtree(
  tx: TxCategoryClient,
  targetId: string,
  newName: string,
  options: ProductCategoryOption[],
): Promise<void> {
  // Apply the rename in-memory to compute the new path map.
  const updated = options.map((o) => (o.id === targetId ? { ...o, name: newName } : o))
  const pathMap = buildProductCategoryPathMap(updated)
  const descendantIds = collectDescendantIds(targetId, updated)
  await tx.productCategory.update({ where: { id: targetId }, data: { name: newName, nameNormalized: buildProductCategoryPathNormalized(parseProductCategoryPath(pathMap.get(targetId) ?? newName)) } })
  for (const id of descendantIds) {
    const display = pathMap.get(id)
    if (!display) continue
    const nameNormalized = buildProductCategoryPathNormalized(parseProductCategoryPath(display))
    await tx.productCategory.update({ where: { id }, data: { nameNormalized } })
  }
}

// Re-export the path-display helper so consumers don't have to reach into lib/products/categories.
export { buildProductCategoryPathDisplay }
