'use server'
import type { Capability } from '../shared/options'
export async function ok1(id: string, options?: Capability) { return { id, options } }
