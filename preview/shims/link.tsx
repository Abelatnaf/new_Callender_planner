/**
 * `next/link` stand-in for the single-file preview.
 *
 * The preview bundles the REAL pages and components, so nothing is
 * re-implemented and the preview cannot drift from the app. The only Next.js
 * surfaces those pages touch are Link and usePathname, so they are shimmed
 * rather than the pages being rewritten.
 *
 * Routes become hash fragments, because a single HTML file has no server to
 * resolve a path against.
 */
import type { AnchorHTMLAttributes, ReactNode } from 'react'

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string
  children?: ReactNode
}

export default function Link({ href, children, ...rest }: LinkProps): ReactNode {
  return (
    <a href={`#${href}`} {...rest}>
      {children}
    </a>
  )
}
