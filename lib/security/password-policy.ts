const MIN_PASSWORD_LENGTH = 12
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  'password123!',
  'adminpassword1!',
  'onetwo3d123!',
])

export function validateUserPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  if (COMMON_PASSWORDS.has(password.trim().toLowerCase())) {
    return 'Password is too common'
  }
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter'
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter'
  if (!/[0-9]/.test(password)) return 'Password must include a number'
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a symbol'
  return null
}
