'use server'
export async function ok5(id: string) {
  const skipPermissionCheck = false
  return { id, skipPermissionCheck }
}
