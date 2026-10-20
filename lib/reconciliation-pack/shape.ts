/**
 * COPYING CALLER-OWNED DATA INTO PLAIN, WHITELISTED OBJECTS.
 *
 * Nothing a caller owns is ever serialised, rendered or stored. Every record the builder receives is first copied
 * field by field, through these two functions, into a fresh object that holds only the fields the schema names:
 *
 *   - a record must be a plain object (prototype Object.prototype or null), not a Proxy, class instance, Map, Date,
 *     array or function; every own key must be a string in the allowed list; every property must be an enumerable DATA
 *     property (an accessor, which could return something else each time it is read, is refused); a symbol key, an
 *     unknown key, `__proto__`, `constructor` and `toJSON` as own keys are all "unknown key" and refused;
 *   - a list must be a real Array with the Array prototype, not a Proxy, with no extra own property and no hole,
 *     and no longer than the stated bound.
 *
 * The copy has a null prototype, so nothing is inherited from it either. The schema is a fixed depth, so there is no
 * recursion over caller data and no nesting to blow up. Callers then validate the primitive values they copied.
 */

import { types } from 'node:util'

export class ShapeError extends Error {}

const hasOwn = (target: object, key: string) => Object.prototype.hasOwnProperty.call(target, key)

export function plainRecord(value: unknown, allowed: readonly string[], required: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || types.isProxy(value)) throw new ShapeError(`${what} is not a plain object`)
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) throw new ShapeError(`${what} is not a plain object`)
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new ShapeError(`${what} has a symbol key`)
    if (!allowed.includes(key)) throw new ShapeError(`${what} has an unknown field`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw new ShapeError(`${what} has a field that is not plain data`)
    out[key] = descriptor.value
  }
  for (const key of required) if (!hasOwn(out, key)) throw new ShapeError(`${what} is missing a required field`)
  return out
}

export function plainList(value: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new ShapeError(`${what} is not a plain list`)
  const length = value.length
  if (!Number.isSafeInteger(length) || length > max) throw new ShapeError(`${what} is longer than ${max}`)
  const keys = Reflect.ownKeys(value)
  if (keys.length !== length + 1) throw new ShapeError(`${what} has holes or extra properties`)
  const out: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw new ShapeError(`${what} has an element that is not plain data`)
    out.push(descriptor.value)
  }
  return out
}
