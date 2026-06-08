const PASSWORD_MIN_LENGTH = 12
const PASSWORD_MAX_LENGTH = 256
const COMMON_PASSWORDS = new Set([
  '123456789012',
  'admin123456!',
  'password',
  'password1',
  'password12',
  'password123',
  'password123!',
  'password1234!',
  'p@ssword123',
  'p@ssword123!',
  'qwerty123!',
  'qwerty1234!',
  'welcome123!',
  'welcome2024!',
  'letmein123!',
  'letmein1234!',
  'changeme123!',
  'company123!',
  'summer2024!',
  'winter2024!',
  'spring2024!',
  'autumn2024!',
  'football123!',
  'baseball123!',
  'monkey123!',
  'dragon123!',
  'iloveyou123!',
  'trustno1!',
  'trustno1123!',
  'adminadmin123!',
  'onetwoinventory1!',
])
const COMMON_PASSWORD_ROOTS = [
  'password',
  'p@ssword',
  'qwerty',
  'welcome',
  'letmein',
  'admin',
  'changeme',
  'company',
  'football',
  'baseball',
  'monkey',
  'dragon',
  'iloveyou',
  'trustno',
  'onetwoinventory',
] as const
const COMMON_KEYBOARD_SEQUENCES = [
  '123456',
  '234567',
  '345678',
  '456789',
  'abcdef',
  'qwerty',
  'asdfgh',
  'zxcvbn',
] as const

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; error: string }

function looksCommon(password: string): boolean {
  const lower = password.toLowerCase()
  const compact = lower.replace(/[^a-z0-9@]/g, '')
  return (
    COMMON_PASSWORDS.has(lower) ||
    COMMON_PASSWORD_ROOTS.some((root) => compact.includes(root)) ||
    COMMON_KEYBOARD_SEQUENCES.some((sequence) => compact.includes(sequence)) ||
    /(.)\1{4,}/.test(lower)
  )
}

export function validateUserPassword(password: string | null | undefined): PasswordPolicyResult {
  if (!password) return { ok: false, error: 'Password is required' }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` }
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters` }
  }
  if (looksCommon(password)) {
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
