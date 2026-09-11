"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "The Week" },
  { href: "/intake", label: "Intake" },
  { href: "/backlog", label: "Backlog" },
  { href: "/setup", label: "Semester" },
  { href: "/document", label: "Document" },
];

export function Masthead() {
  const pathname = usePathname();
  return (
    <header className="masthead no-print">
      <div className="wrap masthead__bar">
        <Link href="/" className="wordmark">
          Order<sup>VMI</sup>
        </Link>
        <nav className="nav" aria-label="Primary">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={pathname === l.href ? "page" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
