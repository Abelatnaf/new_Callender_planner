import Link from "next/link";

/**
 * The empty state carries real weight here: a cadet arriving with nothing
 * should be told exactly what to do next, in order, rather than shown a
 * decorative illustration and left to work it out.
 */
export function Empty({
  title, lines, cta,
}: {
  title: string;
  lines: string[];
  cta?: { href: string; label: string };
}) {
  return (
    <div className="avoid-break" style={{ borderTop: "var(--rule-heavy) solid var(--ink)", paddingTop: "var(--u-4)" }}>
      <h2 className="display" style={{ fontSize: "var(--t-2xl)", maxWidth: "18ch" }}>{title}</h2>
      <ol style={{ listStyle: "none", marginTop: "var(--u-3)", maxWidth: "var(--measure)" }}>
        {lines.map((l, i) => (
          <li key={l} style={{ display: "flex", gap: "var(--u-2)", padding: "var(--u) 0", borderBottom: "var(--rule-hair) solid var(--rule-faint)" }}>
            <span className="num" style={{ fontSize: "1.25rem", width: "2ch", color: "var(--ink-4)" }}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <span style={{ fontSize: "var(--t-small)", lineHeight: 1.5 }}>{l}</span>
          </li>
        ))}
      </ol>
      {cta && (
        <Link href={cta.href} className="btn btn--solid" style={{ marginTop: "var(--u-3)" }}>
          {cta.label}
        </Link>
      )}
    </div>
  );
}
