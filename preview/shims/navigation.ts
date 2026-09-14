/** `next/navigation` stand-in: the current route from the URL hash. */
import { useEffect, useState } from 'react'

export function usePathname(): string {
  const [path, setPath] = useState<string>(() => readHash())

  useEffect(() => {
    const update = (): void => setPath(readHash())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  return path
}

function readHash(): string {
  if (typeof window === 'undefined') return '/'
  const hash = window.location.hash.replace(/^#/, '')
  return hash === '' ? '/' : hash
}

export function useRouter(): { push: (href: string) => void } {
  return {
    push: (href: string) => {
      window.location.hash = href
    },
  }
}
