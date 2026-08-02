'use server'
// NOT exported: not reachable over RPC, so a legitimate internal flag here
// must not fail CI and force a pointless waiver.
async function helper(id: string, options?: { isInternal?: boolean }) { return { id, options } }
export async function ok4(id: string) { return helper(id, { isInternal: true }) }
