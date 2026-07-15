import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { Inter } from 'next/font/google'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthSessionProvider } from '@/components/providers/session-provider'
import { ThemeProvider } from '@/components/providers/theme-provider'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' })

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: { default: 'One Two Inventory', template: '%s | One Two Inventory' },
    description: 'Inventory Management System',
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // CSP nonce set per-request by proxy.ts; applied to the inline theme script
  // below so it is allowed under the strict-dynamic script-src policy.
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Blocking theme script — runs before first paint to prevent FOUC.
            Reads the stored theme from localStorage and applies the `dark`
            class + colorScheme immediately so the browser renders the
            correct palette before React hydrates. Must stay synchronous
            and inline; an external script or useEffect would flash. */}
        {/* suppressHydrationWarning: once a CSP is active the browser blanks the
            `nonce` content attribute (stashing the value in an internal slot),
            so hydration reads back "" and mismatches the real nonce. The
            <html> tag's own suppressHydrationWarning only covers one level. */}
        <script
          suppressHydrationWarning
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light'}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <ThemeProvider>
          <AuthSessionProvider>
            <TooltipProvider delay={300}>{children}</TooltipProvider>
          </AuthSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
