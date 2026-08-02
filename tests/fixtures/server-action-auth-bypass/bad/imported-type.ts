'use server'
import type { TransitionOptions } from '../shared/options'
export async function a(id: string, options?: TransitionOptions) { return { id, options } }
