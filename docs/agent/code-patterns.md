# Code patterns and examples (reference)

> Moved from CLAUDE.md. The rules themselves live in CLAUDE.md; this file holds the worked examples.

### File & Code Naming Conventions

**File Names** (on disk):
- Components: `kebab-case` → `user-profile.tsx`, `product-list.tsx`, `add-to-stock-dialog.tsx`
- Server actions: `kebab-case` → `products.ts`, `sales-orders.ts`
- API routes: `kebab-case` → `create-order.ts`, `webhook-woocommerce.ts`
- Utilities: `kebab-case` → `pdf-helpers.ts`, `format-currency.ts`
- Hooks: `use` + camelCase (in file name) → `useAuth.ts`, `usePermissions.ts`
- UI components: `lowercase` → `button.tsx`, `dialog.tsx`, `dropdown-menu.tsx`
- Config files: `kebab-case` → `next.config.ts`, `.env.example`

**Code Naming** (identifiers inside files):
- **Components/Classes:** PascalCase → `export function UserProfile()`, `export class ApiClient`
- **Functions:** camelCase with verb prefix → `function handleSubmit()`, `const fetchUsers = async ()`
- **Variables:** camelCase → `const userData`, `let totalStock`
- **State hooks:** camelCase, semantic prefix → `const [loading, setLoading] = useState(false)`, `const [error, setError] = useState('')`
- **Custom hooks:** `use` + PascalCase → `useAuth()`, `usePermissions()`, `useInventory()`
- **Constants:** SCREAMING_SNAKE_CASE → `const MAX_RETRIES = 3`, `const XERO_BASE_URL = '...'`
- **Type/Interface exports:** PascalCase → `export type ProductRow = {...}`, `export interface UserSession {...}`
- **Boolean variables:** `is`/`has`/`should` prefix → `const isLoading`, `const hasPermission`, `const shouldRefetch`

### Import Order

Follow this order in all files:

```typescript
// 1. React and Next.js
import type { Metadata } from 'next'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

// 2. External packages
import { z } from 'zod'
import { signIn } from 'next-auth/react'

// 3. Internal absolute imports (@/)
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth } from '@/lib/auth/server'

// 4. Component imports
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

// 5. Type imports (if separate)
import type { ProductRow } from '@/app/actions/products'
```

### Code Style & Patterns

**TypeScript Strict Mode:**
- All files are TypeScript. No ambiguous `any` types.
- Use `type` for type-only imports to enable tree-shaking
- Define explicit return types on public functions

```typescript
// ✓ Good
export async function getProduct(id: string): Promise<ProductRow | null> {
  return db.product.findUnique({ where: { id } })
}

// ✗ Bad - no return type
export async function getProduct(id: string) {
  return db.product.findUnique({ where: { id } })
}
```

**Server Actions:**
- Always start with `'use server'` directive
- Include `await requireAuth()` at the top
- Use Zod for input validation with explicit schema
- Call `logActivity()` for all state mutations
- Use `revalidatePath()` or `revalidateTag()` to update UI cache

```typescript
// app/actions/products.ts
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth } from '@/lib/auth/server'

const CreateProductSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
})

export async function createProduct(input: unknown) {
  const session = await requireAuth()

  const data = CreateProductSchema.parse(input)

  const product = await db.product.create({
    data: { ...data, createdBy: session.user.id }
  })

  await logActivity({
    tag: 'inventory',
    action: 'create',
    description: `Created product: ${product.name}`,
    entityId: product.id,
  })

  revalidatePath('/inventory')
  return product
}
```

**Client Components:**
- Use `'use client'` only where interactivity is needed
- Separate server (async) and client (interactive) components
- Page components stay on server, extract interactive parts to clients

```typescript
// app/(dashboard)/products/[id]/page.tsx (Server Component)
export default async function Page({ params }: { params: { id: string } }) {
  const product = await getProduct(params.id)
  return <ProductClient product={product} />
}

// components/product-client.tsx (Client Component)
'use client'
export function ProductClient({ product }: { product: Product }) {
  const [editing, setEditing] = useState(false)
  return (...)
}
```

**Permissions & RBAC:**
- Enforce permissions server-side in actions via `requirePermission('permission')` (throws on failure) or check with `hasPermission(session.user.role, 'permission')`
- `requireAuth`/`requirePermission` are in `@/lib/auth/server`; `hasPermission`/`getPermissions` are in `@/lib/permissions`
- Prevent privilege escalation by validating user role on server

```typescript
import { requirePermission } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'

export async function updateProduct(id: string, input: unknown) {
  // Throws (403) if the current role lacks the permission:
  const session = await requirePermission('products.edit')

  // ...or branch without throwing:
  if (!hasPermission(session.user.role, 'products.edit')) {
    throw new Error('Unauthorized')
  }

  // proceed...
}
```

**Activity Logging:**
- Every mutation (create, update, delete) must call `logActivity()`
- Include descriptive messages, tags (inventory/sales/sync/etc.), and entity IDs
- Located in `@/lib/activity-log.ts`

**Form Patterns:**
- All forms use modal/dialog style (floating, not separate pages)
- Use Zod validation in server actions
- Leverage React's form submission with server actions
- Include loading states and error handling

### Error Handling

**API Routes:**
- Return JSON with HTTP status code and error message
- Log errors to activity log for audit
- Never expose internal stack traces to client
- Return 401 for auth, 403 for permission, 400 for validation, 500 for server errors

**Server Actions:**
- Throw errors; Next.js serializes them to client
- User-facing errors: throw `new Error('User message')`
- Always catch database errors and log to activity log
- Include context in error messages

**Client Side:**
- Wrap server action calls in try-catch
- Display user-friendly error messages
- Log technical errors for debugging
- Show loading skeletons during async operations

