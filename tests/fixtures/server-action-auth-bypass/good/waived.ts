'use server'
export async function ok6(id: string, options?: {
  // server-action-auth-bypass-ok: o3d-43oz: fixture proving the waiver works
  skipPermissionCheck?: boolean
}) { return { id, options } }
