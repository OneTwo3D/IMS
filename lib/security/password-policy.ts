const PASSWORD_MIN_LENGTH = 12
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  'password123!',
  'adminadmin123!',
  'onetwoinventory1!',
])

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; error: string }

export function validateUserPassword(password: string | null | undefined): PasswordPolicyResult {
  if (!password) return { ok: false, error: 'Password is required' }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` }
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, error: 'Password is too common' }
  }
  if (!/[A-Z]/.test(password)) {
    return { ok: false, error: 'Password must include an uppercase letter' }
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, error: 'Password must include a number' }
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return { ok: false, error: 'Password must include a symbol' }
  }
  return { ok: true }
}
