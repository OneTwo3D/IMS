/**
 * Wait for a promise for at most `ms`, without cancelling it. The timer is cleared as soon as either side
 * settles so it cannot fire later; with `unref` it also cannot keep a process alive. Rejects only if
 * `promise` does (callers pass promises that do not).
 */
export async function raceWithDeadline<T, D>(promise: Promise<T>, ms: number, onDeadline: D, options: { unref?: boolean } = {}): Promise<T | D> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<D>((resolve) => {
    timer = setTimeout(() => resolve(onDeadline), ms)
    if (options.unref) timer.unref?.()
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
