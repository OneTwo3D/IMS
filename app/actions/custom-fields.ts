'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import {
  createCustomFieldDefinition,
  deleteCustomFieldDefinition,
  updateCustomFieldDefinition,
  type CreateDefinitionInput,
  type UpdateDefinitionInput,
} from '@/lib/custom-fields/definitions-service'
import {
  DEFINITION_SELECT,
  applyCustomFieldValues,
  compareDefinitions,
  loadCustomFieldCard,
  toDefinitionRow,
  type CustomFieldCardData,
  type CustomFieldDefinitionRow,
} from '@/lib/custom-fields/values-service'
import { CUSTOM_FIELD_ENTITIES, type CustomFieldEntityName } from '@/lib/custom-fields/values'

/**
 * Custom fields: the settings page (definitions) and the detail-page card (values).
 *
 *   definitions   need `settings.company`, the permission the other configuration pages use
 *   product values   read with `inventory`, written with `inventory.edit`   (the product edit key)
 *   order values     read with `sales`, written with `sales.create`         (the key that edits an order's notes)
 *
 * A permission denial THROWS (it is not folded into a result), like every other action; a value or definition that is refused for a
 * business reason comes back as `{ success: false, error }`.
 */

const TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

const isEntity = (value: unknown): value is CustomFieldEntityName =>
  typeof value === 'string' && (CUSTOM_FIELD_ENTITIES as readonly string[]).includes(value)

export type CustomFieldDefinitionListRow = CustomFieldDefinitionRow & { valueCount: number }

export async function listCustomFieldDefinitions(): Promise<CustomFieldDefinitionListRow[]> {
  await requirePermission('settings.company')
  const [rows, counts] = await Promise.all([
    db.customFieldDefinition.findMany({ select: DEFINITION_SELECT }),
    db.customFieldValue.groupBy({ by: ['definitionId'], _count: { _all: true } }),
  ])
  const countByDefinition = new Map(counts.map((c) => [c.definitionId, c._count._all]))
  return rows.map((r) => ({ ...toDefinitionRow(r), valueCount: countByDefinition.get(r.id) ?? 0 })).sort(
    (a, b) => a.entity.localeCompare(b.entity) || compareDefinitions(a, b),
  )
}

export type CustomFieldDefinitionActionResult =
  | { success: true; definition: CustomFieldDefinitionRow }
  | { success: false; error: string }

export async function createCustomFieldDefinitionAction(input: CreateDefinitionInput): Promise<CustomFieldDefinitionActionResult> {
  const session = await requirePermission('settings.company')
  const result = await db.$transaction((tx) => createCustomFieldDefinition(tx, input, session.user.id ?? null), TX_OPTIONS)
  if (!result.ok) return { success: false, error: result.error }
  revalidatePath('/settings/custom-fields')
  return { success: true, definition: result.definition }
}

export async function updateCustomFieldDefinitionAction(input: UpdateDefinitionInput): Promise<CustomFieldDefinitionActionResult> {
  const session = await requirePermission('settings.company')
  const result = await db.$transaction((tx) => updateCustomFieldDefinition(tx, input, session.user.id ?? null), TX_OPTIONS)
  if (!result.ok) return { success: false, error: result.error }
  revalidatePath('/settings/custom-fields')
  revalidatePath('/inventory')
  revalidatePath('/sales')
  return { success: true, definition: result.definition }
}

export async function deleteCustomFieldDefinitionAction(id: string): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePermission('settings.company')
  const result = await db.$transaction((tx) => deleteCustomFieldDefinition(tx, String(id), session.user.id ?? null), TX_OPTIONS)
  if (!result.ok) return { success: false, error: result.error }
  revalidatePath('/settings/custom-fields')
  return { success: true }
}

export async function getCustomFieldCardData(entity: CustomFieldEntityName, entityId: string): Promise<CustomFieldCardData> {
  await requirePermission(entity === 'PRODUCT' ? 'inventory' : 'sales')
  if (!isEntity(entity)) return { entity: 'PRODUCT', entityId, fields: [] }
  return loadCustomFieldCard(db, entity, String(entityId))
}

export type SaveCustomFieldValuesResult =
  | { success: true; changed: number }
  | { success: false; error: string; fieldErrors: Record<string, string> }

/**
 * Save the values the operator changed on one product or order. `changes` maps a definition id to the text entered ('' clears it).
 * Only the changed fields are sent, so saving never overwrites a field someone else edited in the meantime.
 */
export async function saveCustomFieldValues(
  entity: CustomFieldEntityName,
  entityId: string,
  changes: Record<string, string>,
): Promise<SaveCustomFieldValuesResult> {
  const session = await requirePermission(entity === 'PRODUCT' ? 'inventory.edit' : 'sales.create')
  if (!isEntity(entity)) return { success: false, error: 'Unknown record type.', fieldErrors: {} }
  const clean: Record<string, string> = {}
  for (const [id, value] of Object.entries(changes ?? {})) clean[String(id)] = typeof value === 'string' ? value : ''
  const result = await db.$transaction(
    (tx) => applyCustomFieldValues(tx, { entity, entityId: String(entityId), changes: clean, userId: session.user.id ?? null, source: 'editor' }),
    TX_OPTIONS,
  )
  if (!result.ok) return { success: false, error: result.error, fieldErrors: result.fieldErrors }
  if (result.changed > 0) revalidatePath(entity === 'PRODUCT' ? `/inventory/${entityId}` : `/sales/${entityId}`)
  return { success: true, changed: result.changed }
}
