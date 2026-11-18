import { Prisma } from '@/app/generated/prisma/client'
import { logActivityInTransaction } from '@/lib/activity-log'
import {
  CUSTOM_FIELD_DEFINITIONS_MAX_PER_ENTITY,
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_LABEL_MAX,
  CUSTOM_FIELD_TYPES,
  normaliseCustomFieldOptions,
  validateCustomFieldSlug,
  type CustomFieldEntityName,
  type CustomFieldTypeName,
} from './values'
import { DEFINITION_SELECT, toDefinitionRow, type CustomFieldDefinitionRow } from './values-service'

/**
 * CREATING AND CHANGING CUSTOM-FIELD DEFINITIONS (the settings page). Runs in the caller's transaction.
 *
 * What may change once a definition exists:
 *   key and entity   never (the key is the CSV column and the list-filter address; the entity decides where the field shows)
 *   type             only while NO value exists on it. A type change with values is refused, because the stored values would no longer match.
 *   choices          a STRING field's choice list may change, but never in a way that leaves an existing value outside it
 *   label, namespace, required, sort order, on/off   freely. Switching a field off hides it everywhere and DELETES NOTHING; switching it
 *                    back on shows every value again.
 *   deleting         only a definition with no values. Otherwise switch it off.
 *
 * Every change takes the definition row FOR UPDATE; value writes take it FOR SHARE (values-service.ts), so a change cannot interleave
 * with a write that depends on the rule it changes.
 */

export type CreateDefinitionInput = {
  entity: string
  namespace: string
  key: string
  label: string
  type: string
  options?: readonly string[] | null
  required?: boolean
  sortOrder?: number
}

export type UpdateDefinitionInput = {
  id: string
  namespace: string
  label: string
  type: string
  options?: readonly string[] | null
  required: boolean
  sortOrder: number
  active: boolean
}

export type DefinitionResult =
  | { ok: true; definition: CustomFieldDefinitionRow }
  | { ok: false; error: string }

const isEntity = (value: string): value is CustomFieldEntityName => (CUSTOM_FIELD_ENTITIES as readonly string[]).includes(value)
const isType = (value: string): value is CustomFieldTypeName => (CUSTOM_FIELD_TYPES as readonly string[]).includes(value)

function cleanLabel(label: string): { ok: true; label: string } | { ok: false; error: string } {
  const trimmed = label.trim()
  if (!trimmed) return { ok: false, error: 'A label is required.' }
  if (trimmed.length > CUSTOM_FIELD_LABEL_MAX) return { ok: false, error: `The label must be ${CUSTOM_FIELD_LABEL_MAX} characters or fewer.` }
  return { ok: true, label: trimmed }
}

function cleanSortOrder(value: number | undefined): number | null {
  const n = value ?? 0
  return Number.isInteger(n) && Math.abs(n) <= 100_000 ? n : null
}

/** Choices are kept only on a STRING field. Returns the JSON value to store (DbNull for none). */
function resolveOptions(type: CustomFieldTypeName, options: readonly string[] | null | undefined): { ok: true; options: string[] | null } | { ok: false; error: string } {
  if (type !== 'STRING') {
    if (options && options.some((o) => o.trim())) return { ok: false, error: 'Only a text field can have a list of choices.' }
    return { ok: true, options: null }
  }
  return normaliseCustomFieldOptions(options)
}

export async function createCustomFieldDefinition(tx: Prisma.TransactionClient, input: CreateDefinitionInput, userId: string | null): Promise<DefinitionResult> {
  if (!isEntity(input.entity)) return { ok: false, error: 'Choose whether the field is for products or sales orders.' }
  if (!isType(input.type)) return { ok: false, error: 'Choose a field type.' }
  const key = input.key.trim()
  const namespace = input.namespace.trim()
  const keyError = validateCustomFieldSlug('key', key)
  if (keyError) return { ok: false, error: keyError }
  const namespaceError = validateCustomFieldSlug('namespace', namespace)
  if (namespaceError) return { ok: false, error: namespaceError }
  const label = cleanLabel(input.label)
  if (!label.ok) return label
  const options = resolveOptions(input.type, input.options)
  if (!options.ok) return options
  const sortOrder = cleanSortOrder(input.sortOrder)
  if (sortOrder === null) return { ok: false, error: 'The sort order must be a whole number.' }

  const existing = await tx.customFieldDefinition.count({ where: { entity: input.entity } })
  if (existing >= CUSTOM_FIELD_DEFINITIONS_MAX_PER_ENTITY) {
    return { ok: false, error: `There can be at most ${CUSTOM_FIELD_DEFINITIONS_MAX_PER_ENTITY} custom fields per ${input.entity === 'PRODUCT' ? 'product' : 'order'} type. Switch off or delete one you no longer use.` }
  }
  try {
    const created = await tx.customFieldDefinition.create({
      data: {
        entity: input.entity, namespace, key, label: label.label, type: input.type,
        options: options.options ?? Prisma.DbNull, required: input.required === true, sortOrder,
      },
      select: DEFINITION_SELECT,
    })
    await logActivityInTransaction(tx, {
      userId, entityType: 'SETTING', entityId: created.id, action: 'custom_field_created', tag: 'settings', level: 'INFO',
      description: `Created ${input.entity === 'PRODUCT' ? 'product' : 'sales order'} custom field "${label.label}" (${namespace}.${key}, ${input.type})`,
      metadata: { entity: input.entity, namespace, key, type: input.type },
    })
    return { ok: true, definition: toDefinitionRow(created) }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { ok: false, error: `There is already a ${input.entity === 'PRODUCT' ? 'product' : 'sales order'} custom field with the key "${key}".` }
    }
    throw error
  }
}

async function countValues(tx: Prisma.TransactionClient, definitionId: string): Promise<number> {
  return tx.customFieldValue.count({ where: { definitionId } })
}

export async function updateCustomFieldDefinition(tx: Prisma.TransactionClient, input: UpdateDefinitionInput, userId: string | null): Promise<DefinitionResult> {
  if (!isType(input.type)) return { ok: false, error: 'Choose a field type.' }
  const namespace = input.namespace.trim()
  const namespaceError = validateCustomFieldSlug('namespace', namespace)
  if (namespaceError) return { ok: false, error: namespaceError }
  const label = cleanLabel(input.label)
  if (!label.ok) return label
  const options = resolveOptions(input.type, input.options)
  if (!options.ok) return options
  const sortOrder = cleanSortOrder(input.sortOrder)
  if (sortOrder === null) return { ok: false, error: 'The sort order must be a whole number.' }

  await tx.$queryRaw(Prisma.sql`SELECT id FROM "custom_field_definitions" WHERE id = ${input.id} FOR UPDATE`)
  const current = await tx.customFieldDefinition.findUnique({ where: { id: input.id }, select: DEFINITION_SELECT })
  if (!current) return { ok: false, error: 'This field no longer exists. Reload the page.' }
  const before = toDefinitionRow(current)

  if (input.type !== before.type) {
    const values = await countValues(tx, input.id)
    if (values > 0) {
      return { ok: false, error: `This field already holds ${values} value${values === 1 ? '' : 's'}, so its type cannot be changed. Switch it off and create a new field with the type you want.` }
    }
  }
  if (input.type === 'STRING' && options.options) {
    // Every existing value must still be one of the choices.
    const stray = await tx.customFieldValue.findMany({
      where: { definitionId: input.id, valueText: { notIn: options.options } },
      select: { valueText: true },
      distinct: ['valueText'],
      take: 5,
    })
    if (stray.length > 0) {
      return { ok: false, error: `These values are already in use and are not in the new list of choices: ${stray.map((s) => `"${s.valueText}"`).join(', ')}. Keep them in the list, or change those records first.` }
    }
  }

  const updated = await tx.customFieldDefinition.update({
    where: { id: input.id },
    data: { namespace, label: label.label, type: input.type, options: options.options ?? Prisma.DbNull, required: input.required, sortOrder, active: input.active },
    select: DEFINITION_SELECT,
  })
  const after = toDefinitionRow(updated)
  const changed: string[] = (['namespace', 'label', 'type', 'required', 'sortOrder', 'active'] as const).filter((k) => before[k] !== after[k])
  if (JSON.stringify(before.options) !== JSON.stringify(after.options)) changed.push('options')
  if (changed.length > 0) {
    await logActivityInTransaction(tx, {
      userId, entityType: 'SETTING', entityId: updated.id, action: before.active && !after.active ? 'custom_field_deactivated' : 'custom_field_updated', tag: 'settings', level: 'INFO',
      description: `Changed ${before.entity === 'PRODUCT' ? 'product' : 'sales order'} custom field "${after.label}" (${changed.join(', ')})`,
      metadata: { entity: before.entity, key: before.key, changed },
    })
  }
  return { ok: true, definition: after }
}

export type DeleteDefinitionResult = { ok: true } | { ok: false; error: string }

export async function deleteCustomFieldDefinition(tx: Prisma.TransactionClient, id: string, userId: string | null): Promise<DeleteDefinitionResult> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "custom_field_definitions" WHERE id = ${id} FOR UPDATE`)
  const current = await tx.customFieldDefinition.findUnique({ where: { id }, select: DEFINITION_SELECT })
  if (!current) return { ok: false, error: 'This field no longer exists. Reload the page.' }
  const values = await countValues(tx, id)
  if (values > 0) {
    return { ok: false, error: `This field holds ${values} value${values === 1 ? '' : 's'}, so it cannot be deleted. Switch it off instead: that hides it and keeps its values.` }
  }
  await tx.customFieldDefinition.delete({ where: { id } })
  await logActivityInTransaction(tx, {
    userId, entityType: 'SETTING', entityId: id, action: 'custom_field_deleted', tag: 'settings', level: 'INFO',
    description: `Deleted ${current.entity === 'PRODUCT' ? 'product' : 'sales order'} custom field "${current.label}" (${current.key})`,
    metadata: { entity: current.entity, key: current.key },
  })
  return { ok: true }
}
