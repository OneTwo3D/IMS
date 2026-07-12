import type { Metadata } from 'next'
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Blocking theme script — runs before first paint to prevent FOUC.
            Reads the stored theme from localStorage and applies the `dark`
            class + colorScheme immediately so the browser renders the
            correct palette before React hydrates. Must stay synchronous
            and inline; an external script or useEffect would flash. */}
        <script
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
