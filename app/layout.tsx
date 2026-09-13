import type { Metadata, Viewport } from 'next'
import { Newsreader, Plus_Jakarta_Sans } from 'next/font/google'
import { PlannerProvider } from '@/components/PlannerProvider'
import { Dock } from '@/components/Dock'
import './globals.css'
import './print.css'

/**
 * Fonts are self-hosted by `next/font`, which downloads them at build time and
 * serves them from this origin. That is what the build plan wanted when it
 * said to embed the faces rather than fetching Google Fonts at render time: a
 * network blip must never be able to produce a broken printed page.
 */
const newsreader = Newsreader({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-newsreader',
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
})

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jakarta',
  weight: ['400', '500', '600', '700'],
})

export const metadata: Metadata = {
  title: 'ORDER — week planner',
  description:
    'Ink is obligation. White space is freedom. A week-planning instrument that tells you which hours are actually yours.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <html lang="en" className={`${newsreader.variable} ${jakarta.variable}`}>
      <body>
        <PlannerProvider>
          <div className="shell">
            <Dock />
            <main className="main">{children}</main>
          </div>
        </PlannerProvider>
      </body>
    </html>
  )
}
