'use server'
export async function ok2(id: string, opts?: {
  force?: boolean; allowCache?: boolean; skipLog?: boolean; skipPreferredSupplierUpdate?: boolean; forceLive?: boolean
}) { return { id, opts } }
