import { useState, type Dispatch, type SetStateAction } from 'react'

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
}

/**
 * Runs `apply` during render, once, whenever any of `deps` changes (compared with Object.is) after the first render.
 * This is the React-documented replacement for a `useEffect(() => { setX(prop) }, [prop])` prop-sync: the state
 * updates are applied in the same render pass, so there is no extra committed frame showing stale state.
 * `apply` may only set state of the calling component.
 */
export function useRenderSync(deps: readonly unknown[], apply: () => void): void {
  const [seen, setSeen] = useState<readonly unknown[]>(deps)
  if (!sameDeps(seen, deps)) {
    setSeen(deps)
    apply()
  }
}

/** State that starts from `source` and is replaced by it whenever `source` changes (e.g. fresh server props after router.refresh()). */
export function useResyncedState<T>(source: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(source)
  useRenderSync([source], () => setValue(source))
  return [value, setValue]
}
