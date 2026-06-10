const MIN_PASSWORD_LENGTH = 12
const MAX_PASSWORD_LENGTH = 256
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '12345678901',
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789012345',
  '1234567890123456',
  'adminadmin123!',
  'adminpassword1!',
  'changeme123!',
  'defaultpassword1!',
  'dragon123456!',
  'football123!',
  'hellohello123!',
  'iloveyou123!',
  'letmein123!',
  'monkey123456!',
  'onetwo3d123!',
  'onetwoinventory1!',
  'password!',
  'password',
  'password1234',
  'password12345',
  'password123456',
  'password1',
  'password12',
  'password123',
  'password123!',
  'p@ssword123',
  'qazwsx123!',
  'qwerty123!',
  'qwerty12345!',
  'qwertyuiop123!',
  'summer2024!',
  'summer2025!',
  'trustno1123!',
  'welcome123!',
  'welcome2024!',
  'welcome2025!',
  'winter2024!',
  'winter2025!',
])

const COMMON_PATTERN_RE = [
  /^(?:p@ssw[o0]rd|passw[o0]rd)[^a-z]*[0-9!@#$%^&*()_+\-=.]*$/i,
  /^(?:qwerty|asdf|zxcv|letmein|welcome|admin|changeme)[a-z0-9!@#$%^&*()_+\-=.]*$/i,
  /^(?:spring|summer|autumn|winter|password|welcome)[0-9]{4}[!@#$%^&*()_+\-=.]*$/i,
]

export function validateUserPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`
  }
  const normalized = password.trim().toLowerCase()
  if (COMMON_PASSWORDS.has(normalized) || COMMON_PATTERN_RE.some((pattern) => pattern.test(normalized))) {
    return 'Password is too common'
  }
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter'
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter'
  if (!/[0-9]/.test(password)) return 'Password must include a number'
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a symbol'
  return null
}
