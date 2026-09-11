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
    <div className="avoid-break" style={{ borderTop: "var(--separator-strong) solid var(--label)", paddingTop: "var(--s-8)" }}>
      <h2 className="display" style={{ fontSize: "var(--t-title2)", maxWidth: "18ch" }}>{title}</h2>
      <ol style={{ listStyle: "none", marginTop: "var(--s-6)", maxWidth: "var(--measure)" }}>
        {lines.map((l, i) => (
          <li key={l} style={{ display: "flex", gap: "var(--s-4)", padding: "var(--s-2) 0", borderBottom: "1px solid var(--separator)" }}>
            <span className="num" style={{ fontSize: "1.25rem", width: "2ch", color: "var(--accent)" }}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <span style={{ fontSize: "var(--t-sub)", lineHeight: 1.5 }}>{l}</span>
          </li>
        ))}
      </ol>
      {cta && (
        <Link href={cta.href} className="btn btn--solid" style={{ marginTop: "var(--s-6)" }}>
          {cta.label}
        </Link>
      )}
    </div>
  );
}
