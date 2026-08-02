'use server'
export async function h(
  id: string,
  options?: {
    push?: boolean
    skipAuth?:
      | boolean
      | undefined
  },
) { return { id, options } }
