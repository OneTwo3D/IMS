import type { CustomFieldDefinitionRow } from './values-service'

/**
 * THE SALES-ORDER LIST FILTER BY A CUSTOM FIELD VALUE.
 *
 * Offered for the two kinds of field where picking a value is the natural question: a text field WITH a list of choices (a dropdown) and a
 * yes / no field. The list address carries the field key (`cf`) and the chosen value (`cfv`). An unknown or switched-off key, a type that is
 * not filterable, or a value that is not one of the choices is ignored (the list is simply not filtered), never an error.
 *
 * An order with no value for the field matches no choice (it is not "no" and it is not "the first choice").
 */
export type CustomFieldListFilter = { definitionId: string; valueText?: string; valueBoolean?: boolean }

export type FilterableCustomField = {
  key: string
  label: string
  namespace: string
  type: 'STRING' | 'BOOLEAN'
  /** The choices to pick from: the field's options, or yes / no. */
  choices: Array<{ value: string; label: string }>
}

export function filterableCustomFields(definitions: readonly CustomFieldDefinitionRow[]): FilterableCustomField[] {
  const out: FilterableCustomField[] = []
  for (const d of definitions) {
    if (!d.active) continue
    if (d.type === 'STRING' && d.options && d.options.length > 0) {
      out.push({ key: d.key, label: d.label, namespace: d.namespace, type: 'STRING', choices: d.options.map((o) => ({ value: o, label: o })) })
    } else if (d.type === 'BOOLEAN') {
      out.push({ key: d.key, label: d.label, namespace: d.namespace, type: 'BOOLEAN', choices: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] })
    }
  }
  return out
}

export function resolveCustomFieldListFilter(
  definitions: readonly CustomFieldDefinitionRow[],
  key: string | null | undefined,
  value: string | null | undefined,
): CustomFieldListFilter | null {
  if (!key || value == null || value === '') return null
  const field = filterableCustomFields(definitions).find((f) => f.key === key)
  if (!field) return null
  const definition = definitions.find((d) => d.key === key)
  if (!definition || !field.choices.some((c) => c.value === value)) return null
  return field.type === 'BOOLEAN'
    ? { definitionId: definition.id, valueBoolean: value === 'true' }
    : { definitionId: definition.id, valueText: value }
}
