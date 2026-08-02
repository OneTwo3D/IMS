'use server'
export async function d(id: string, options = { skipAuthorization: false }) { return { id, options } }
