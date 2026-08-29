import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ---------------------------------------------------------------------------
// Mount a "use client" component and actually USE it — no DOM, no new dependency.
//
// WHY THIS EXISTS. react-dom/server can render a client component to markup, and that is how the
// Integrations page tests observe what an operator would read. What it cannot do is press
// anything: Fizz's useTransition returns a startTransition that throws ("cannot be called during
// server rendering"), so a handler captured from a server render is unusable, and a test that
// merely counts <button> elements proves only that some buttons were rendered — it stays green
// when the onClick is deleted, when the wrong argument is passed, or when a per-connector control
// is wired to the UNSCOPED action that cancels rows across every inactive connector.
//
// So the component is invoked directly with a minimal hook dispatcher installed. React 19 reads
// the current dispatcher from ReactSharedInternals.H; swapping it for the duration of one
// synchronous call is enough for the hooks a small client component uses. State cells persist
// across renders, so `render()` after a `click()` shows what the operator would see next.
//
// This is deliberately NOT a general-purpose renderer: there is no scheduler, no effects, and
// `pending` from useTransition is always false. It exercises event handlers and re-reads state.
// ---------------------------------------------------------------------------

type Dispatcher = Record<string, (...args: never[]) => unknown>

const internals = (React as unknown as {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: Dispatcher | null }
}).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

type ReactNodeish = unknown

type ElementLike = {
  type?: unknown
  key?: string | null
  props?: Record<string, unknown>
}

function asElement(node: ReactNodeish): ElementLike | null {
  if (!node || typeof node !== 'object') return null
  const element = node as ElementLike
  return 'props' in element || 'type' in element ? element : null
}

/** Every string/number rendered inside a node, concatenated. */
export function textOf(node: ReactNodeish): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const element = asElement(node)
  if (!element?.props) return ''
  return textOf(element.props.children)
}

export type Control = {
  /** The control's own visible text, e.g. "Cancel these". */
  label: string
  /**
   * The visible text of the nearest KEYED ancestor — for a list rendered per connector that is the
   * row the control belongs to. Two controls with identical labels are told apart by this.
   */
  scope: string
  onClick?: () => void
  /**
   * o3d-8u4h round 2: SOME CONTROLS ARE NOT BUTTONS.
   *
   * The analytics stat pages load a saved view from a `<select onChange>`, and that is the only
   * path by which a saved view — including one that outlived a column it names — reaches the table.
   * A harness that collects `onClick` alone can never model it, so a test of that path could only
   * call an internal helper and assert about a list, rather than about the table an operator reads.
   */
  onChange?: (event: { target: { value: string } }) => void
}

function collectControls(node: ReactNodeish, scope: string, found: Control[]): Control[] {
  if (Array.isArray(node)) {
    for (const child of node) collectControls(child, scope, found)
    return found
  }
  const element = asElement(node)
  if (!element?.props) return found
  const nextScope = element.key !== null && element.key !== undefined ? textOf(element) : scope
  const onClick = element.props.onClick
  const onChange = element.props.onChange
  if (typeof onClick === 'function' || typeof onChange === 'function') {
    found.push({
      label: textOf(element.props.children),
      scope: nextScope,
      onClick: typeof onClick === 'function' ? (onClick as () => void) : undefined,
      onChange: typeof onChange === 'function' ? (onChange as (event: { target: { value: string } }) => void) : undefined,
    })
  }
  if ('children' in element.props) collectControls(element.props.children, nextScope, found)
  return found
}

export type MountedRender = {
  tree: ReactNodeish
  html: string
  controls: Control[]
}

export type Mounted<P = unknown> = {
  /** Render (or re-render) with the state accumulated so far. */
  render: () => MountedRender
  /**
   * Press a control and wait for the transition it started. Rejects rather than silently doing
   * nothing when the control is absent — a missing control is the failure mode under test.
   */
  click: (control: Control | undefined) => Promise<void>
  /**
   * Choose a value in a `<select>` (or type into an input), and wait for any transition it started.
   * The event target is a real mutable object because handlers in this tree write back to it —
   * `e.target.value = ''` is how the saved-view pickers reset themselves.
   */
  select: (control: Control | undefined, value: string) => Promise<void>
  /**
   * Deliver NEW props, as a fresh server payload would (o3d-osl8 round 7, finding 3).
   *
   * Without this, a mounted component was pinned to the props it was constructed with, so every
   * `router.refresh()` double in this repo could only count calls — and a component that CLAIMED
   * the refresh had reloaded its data passed, while the rows it displayed were provably the ones
   * rendered before the action ran. State cells survive, exactly as they do in React when a parent
   * re-renders with new props.
   */
  setProps: (next: P) => void
}

export function mountClientComponent<P>(Component: (props: P) => ReactNodeish, initialProps: P): Mounted<P> {
  const cells: unknown[] = []
  const transitions: Array<Promise<unknown>> = []
  let props = initialProps

  function render(): MountedRender {
    let cursor = 0
    const dispatcher: Dispatcher = {
      useState: ((initial: unknown) => {
        const index = cursor++
        if (!(index in cells)) cells[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
        const setState = (next: unknown) => {
          cells[index] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(cells[index]) : next
        }
        return [cells[index], setState]
      }) as never,
      // `pending` is always false: this harness has no scheduler, and the tests assert what the
      // handler DID, not the spinner it showed while doing it.
      useTransition: (() => [false, (callback: () => unknown) => { transitions.push(Promise.resolve(callback())) }]) as never,
      useEffect: (() => {}) as never,
      useMemo: ((factory: () => unknown) => factory()) as never,
      useCallback: ((callback: unknown) => callback) as never,
      useRef: ((initial: unknown) => {
        const index = cursor++
        if (!(index in cells)) cells[index] = { current: initial }
        return cells[index]
      }) as never,
    }
    const guarded = new Proxy(dispatcher, {
      get(target, property: string) {
        if (property in target) return target[property]
        throw new Error(`mountClientComponent: hook ${property} is not supported by this harness`)
      },
    })

    const previous = internals.H
    internals.H = guarded
    let tree: ReactNodeish
    try {
      tree = Component(props)
    } finally {
      internals.H = previous
    }
    return { tree, html: renderToStaticMarkup(tree as React.ReactElement), controls: collectControls(tree, '', []) }
  }

  async function click(control: Control | undefined): Promise<void> {
    if (!control) throw new Error('mountClientComponent: no such control was rendered')
    if (!control.onClick) throw new Error('mountClientComponent: that control has no onClick')
    control.onClick()
    while (transitions.length > 0) await transitions.shift()
  }

  async function select(control: Control | undefined, value: string): Promise<void> {
    if (!control) throw new Error('mountClientComponent: no such control was rendered')
    if (!control.onChange) throw new Error('mountClientComponent: that control has no onChange')
    control.onChange({ target: { value } })
    while (transitions.length > 0) await transitions.shift()
  }

  function setProps(next: P): void {
    props = next
  }

  return { render, click, select, setProps }
}
