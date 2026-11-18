import { Prisma } from '@/app/generated/prisma/client'
import { logActivityInTransaction } from '@/lib/activity-log'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import {
  CUSTOM_FIELD_TYPES,
  customFieldValueColumn,
  formatCustomFieldValue,
  parseCustomFieldValue,
  readCustomFieldOptions,
  storedToColumns,
  type CustomFieldEntityName,
  type CustomFieldTypeName,
  type CustomFieldValueColumns,
} from './values'

/**
 * READING AND WRITING THE VALUES OF CUSTOM FIELDS ON ONE PRODUCT OR ONE SALES ORDER.
 *
 * ONE WRITER. Every write of custom_field_values (the detail-page card and the product CSV import) goes through
 * `applyCustomFieldValues`, which validates each value against its definition's type, refuses a value that is not one of a dropdown's
 * choices, refuses to clear a required field, and writes only what actually changed. tests/custom-fields-writer-census.test.ts pins
 * that no other file writes the table.
 *
 * Variants carry their OWN values: a variant is a Product row, and nothing is inherited from its parent (v1).
 * Nothing here calls the storefront, the warehouse or the ledger: custom fields are internal and are never pushed.
 *
 * A SALES-ORDER WRITE runs under the order lock and reads the erasure marker inside it, exactly like the order notes: an erased order's
 * values are never written back, and an erasure that commits first is seen (it takes the same lock).
 */

export type CustomFieldDefinitionRow = {
  id: string
  entity: CustomFieldEntityName
  namespace: string
  key: string
  label: string
  type: CustomFieldTypeName
  options: string[] | null
  required: boolean
  sortOrder: number
  active: boolean
}

type DefinitionRecord = {
  id: string
  entity: CustomFieldEntityName
  namespace: string
  key: string
  label: string
  type: string
  options: unknown
  required: boolean
  sortOrder: number
  active: boolean
}

export function toDefinitionRow(record: DefinitionRecord): CustomFieldDefinitionRow {
  const type = (CUSTOM_FIELD_TYPES as readonly string[]).includes(record.type) ? (record.type as CustomFieldTypeName) : 'STRING'
  return {
    id: record.id,
    entity: record.entity,
    namespace: record.namespace,
    key: record.key,
    label: record.label,
    type,
    options: type === 'STRING' ? readCustomFieldOptions(record.options) : null,
    required: record.required,
    sortOrder: record.sortOrder,
    active: record.active,
  }
}

export const DEFINITION_SELECT = {
  id: true, entity: true, namespace: true, key: true, label: true, type: true, options: true, required: true, sortOrder: true, active: true,
} as const

/** The order fields are shown and exported in: namespace, then sort order, then label. */
export function compareDefinitions(a: Pick<CustomFieldDefinitionRow, 'namespace' | 'sortOrder' | 'label'>, b: Pick<CustomFieldDefinitionRow, 'namespace' | 'sortOrder' | 'label'>): number {
  return a.namespace.localeCompare(b.namespace) || a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)
}

type ReadClient = Pick<Prisma.TransactionClient, 'customFieldDefinition'>

export async function loadActiveDefinitions(client: ReadClient, entity: CustomFieldEntityName): Promise<CustomFieldDefinitionRow[]> {
  const rows = await client.customFieldDefinition.findMany({ where: { entity, active: true }, select: DEFINITION_SELECT })
  return rows.map(toDefinitionRow).sort(compareDefinitions)
}

export type CustomFieldCardField = CustomFieldDefinitionRow & {
  /** The stored value in the text form the editor and the CSV use; null when there is none. */
  value: string | null
}

export type CustomFieldCardData = {
  entity: CustomFieldEntityName
  entityId: string
  fields: CustomFieldCardField[]
}

export async function loadCustomFieldCard(
  client: Pick<Prisma.TransactionClient, 'customFieldDefinition' | 'customFieldValue'>,
  entity: CustomFieldEntityName,
  entityId: string,
): Promise<CustomFieldCardData> {
  const definitions = await loadActiveDefinitions(client, entity)
  const where = entity === 'PRODUCT' ? { productId: entityId } : { salesOrderId: entityId }
  const values = definitions.length === 0
    ? []
    : await client.customFieldValue.findMany({
        where: { ...where, definitionId: { in: definitions.map((d) => d.id) } },
        select: { definitionId: true, valueText: true, valueDecimal: true, valueBoolean: true, valueDate: true, valueDateTime: true, valueJson: true },
      })
  const byDefinition = new Map(values.map((v) => [v.definitionId, v as CustomFieldValueColumns]))
  return {
    entity,
    entityId,
    fields: definitions.map((d) => {
      const row = byDefinition.get(d.id)
      return { ...d, value: row ? formatCustomFieldValue(d.type, row) : null }
    }),
  }
}

export type ApplyCustomFieldValuesInput = {
  entity: CustomFieldEntityName
  entityId: string
  /** definition id -> the text the operator entered ('' clears the value). Only the fields to change. */
  changes: Record<string, string>
  userId: string | null
  /** A blank cell never reaches here from a CSV; for the editor, a blank clears (and is refused on a required field). */
  source: 'editor' | 'csv'
}

export type ApplyCustomFieldValuesResult =
  | { ok: true; changed: number }
  | { ok: false; error: string; fieldErrors: Record<string, string> }

function fail(error: string, fieldErrors: Record<string, string> = {}): ApplyCustomFieldValuesResult {
  return { ok: false, error, fieldErrors }
}

/**
 * Validate and write the changed values of one entity, in the caller's transaction. All-or-nothing for the validation: if any value is
 * refused, nothing is written and every refusal is reported together. The caller owns the transaction.
 */
export async function applyCustomFieldValues(tx: Prisma.TransactionClient, input: ApplyCustomFieldValuesInput): Promise<ApplyCustomFieldValuesResult> {
  const ids = Object.keys(input.changes)
  if (ids.length === 0) return { ok: true, changed: 0 }

  // A shared lock on the definitions being written: a type or choice-list change (which takes the same row FOR UPDATE) cannot interleave
  // with a value write, so a value is never stored against a definition that has just stopped allowing it.
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "custom_field_definitions" WHERE id IN (${Prisma.join(ids)}) FOR SHARE`)
  const definitionRecords = await tx.customFieldDefinition.findMany({ where: { id: { in: ids } }, select: DEFINITION_SELECT })
  const definitions = new Map(definitionRecords.map((r) => [r.id, toDefinitionRow(r)]))
  const fieldErrors: Record<string, string> = {}
  const planned: Array<{ def: CustomFieldDefinitionRow; text: string | null; stored: ReturnType<typeof storedToColumns> | null }> = []

  for (const id of ids) {
    const def = definitions.get(id)
    if (!def || def.entity !== input.entity) { fieldErrors[id] = 'This field no longer exists. Reload the page.'; continue }
    if (!def.active) { fieldErrors[id] = `${def.label}: this field is switched off.`; continue }
    const parsed = parseCustomFieldValue(def, input.changes[id])
    if (!parsed.ok) { fieldErrors[id] = parsed.error; continue }
    if (parsed.blank) {
      if (def.required) { fieldErrors[id] = `${def.label}: a value is required.`; continue }
      planned.push({ def, text: null, stored: null })
    } else {
      planned.push({ def, text: parsed.text, stored: storedToColumns(parsed.stored) })
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return fail(Object.values(fieldErrors).join(' '), fieldErrors)
  }

  // The owner row: a sales order is locked and checked for erasure inside the lock; a product must exist.
  let ownerName: string
  if (input.entity === 'SALES_ORDER') {
    await lockSalesOrder(tx, input.entityId)
    const order = await tx.salesOrder.findUnique({ where: { id: input.entityId }, select: { erasedAt: true, orderNumber: true, externalOrderNumber: true } })
    if (!order) return fail('This order no longer exists.')
    if (order.erasedAt) return fail('This order\'s personal data has been erased and it can no longer be edited.')
    ownerName = order.orderNumber ?? order.externalOrderNumber ?? input.entityId
  } else {
    const product = await tx.product.findUnique({ where: { id: input.entityId }, select: { sku: true } })
    if (!product) return fail('This product no longer exists.')
    ownerName = product.sku
  }

  const ownerWhere = input.entity === 'PRODUCT' ? { productId: input.entityId } : { salesOrderId: input.entityId }
  const existing = await tx.customFieldValue.findMany({
    where: { ...ownerWhere, definitionId: { in: planned.map((p) => p.def.id) } },
    select: { definitionId: true, valueText: true, valueDecimal: true, valueBoolean: true, valueDate: true, valueDateTime: true, valueJson: true },
  })
  const existingByDefinition = new Map(existing.map((e) => [e.definitionId, e as CustomFieldValueColumns]))

  const changes: Array<{ def: CustomFieldDefinitionRow; oldText: string | null; newText: string | null }> = []
  for (const p of planned) {
    const before = existingByDefinition.get(p.def.id)
    const oldText = before ? formatCustomFieldValue(p.def.type, before) : null
    if (oldText === p.text) continue
    if (p.stored === null) {
      await tx.customFieldValue.deleteMany({ where: { ...ownerWhere, definitionId: p.def.id } })
    } else {
      const data: ValueData = {
        valueText: p.stored.valueText,
        valueDecimal: p.stored.valueDecimal,
        valueBoolean: p.stored.valueBoolean,
        valueDate: p.stored.valueDate,
        valueDateTime: p.stored.valueDateTime,
        // An update must leave exactly one column filled, so a non-JSON value clears the JSON column explicitly.
        valueJson: customFieldValueColumn(p.def.type) === 'valueJson' ? (p.stored.valueJson as Prisma.InputJsonValue) : Prisma.DbNull,
      }
      await upsertValue(tx, input, p.def.id, data)
    }
    changes.push({ def: p.def, oldText, newText: p.text })
  }
  if (changes.length === 0) return { ok: true, changed: 0 }

  if (input.entity === 'PRODUCT') {
    await logActivityInTransaction(tx, {
      userId: input.userId,
      entityType: 'PRODUCT',
      entityId: input.entityId,
      action: 'custom_fields_updated',
      tag: 'inventory',
      level: 'INFO',
      description: `${ownerName}: custom fields changed (${changes.map((c) => c.def.label).join(', ')})${input.source === 'csv' ? ' by CSV import' : ''}`,
      // Product values are not personal data: the before and after are kept, so the change can be traced.
      metadata: { sku: ownerName, source: input.source, changes: changes.map((c) => ({ key: c.def.key, from: c.oldText, to: c.newText })) },
    })
  } else {
    await logActivityInTransaction(tx, {
      userId: input.userId,
      entityType: 'SALES_ORDER',
      entityId: input.entityId,
      action: 'custom_fields_updated',
      tag: 'sales',
      level: 'INFO',
      description: `Order ${ownerName}: custom fields changed (${changes.map((c) => c.def.label).join(', ')})`,
      // Order values can be free text about a person, so the log names the fields only, never the values.
      metadata: { fields: changes.map((c) => c.def.key) },
    })
  }
  return { ok: true, changed: changes.length }
}

type ValueData = {
  valueText: string | null
  valueDecimal: string | null
  valueBoolean: boolean | null
  valueDate: Date | null
  valueDateTime: Date | null
  valueJson: Prisma.InputJsonValue | typeof Prisma.DbNull
}

async function upsertValue(tx: Prisma.TransactionClient, input: ApplyCustomFieldValuesInput, definitionId: string, data: ValueData): Promise<void> {
  if (input.entity === 'PRODUCT') {
    await tx.customFieldValue.upsert({
      where: { definitionId_productId: { definitionId, productId: input.entityId } },
      create: { definitionId, productId: input.entityId, ...data },
      update: data,
    })
  } else {
    await tx.customFieldValue.upsert({
      where: { definitionId_salesOrderId: { definitionId, salesOrderId: input.entityId } },
      create: { definitionId, salesOrderId: input.entityId, ...data },
      update: data,
    })
  }
}
