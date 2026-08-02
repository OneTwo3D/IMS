'use server'
type Wrapper<T> = { payload: T } & T
export async function c(id: string, options?: Wrapper<{ bypassAuth?: boolean }>) { return { id, options } }
