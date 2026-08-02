'use server'
import type { TransitionOptions } from '../shared/options'
export async function b(id: string, options?: Pick<TransitionOptions, 'skipPermissionCheck'>) { return { id, options } }
