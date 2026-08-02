// A plain module. "use server" appears only in this comment, so nothing here
// is remotely callable.
export async function ok3(id: string, options?: { skipPermissionCheck?: boolean }) { return { id, options } }
