// Declared in a DIFFERENT module on purpose: a syntax-only guard cannot
// resolve this, and that was the gap the TypeChecker rewrite closed.
export type TransitionOptions = { skipPermissionCheck?: boolean; note?: string }
export type Capability = { internalBypassToken?: symbol }
