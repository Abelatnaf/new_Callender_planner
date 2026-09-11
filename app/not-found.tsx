import Link from "next/link";

/**
 * The app's own 404.
 *
 * This exists as much for diagnosis as for navigation. Vercel's platform 404 -
 * the plain white page reading `Code: NOT_FOUND` - means the deployment is not
 * serving the app at all. This page means the app is live and only the route is
 * wrong. Without a styled 404 the two are indistinguishable, which is exactly
 * the confusion that cost us an evening.
 */
export default function NotFound() {
  return (
    <div className="wrap">
      <section className="section">
        <div className="label">Error 404</div>
        <h1 className="display" style={{ fontSize: "var(--t-3xl)", maxWidth: "16ch" }}>
          No such page
        </h1>
        <p className="prose" style={{ marginTop: "var(--u-3)" }}>
          The route you asked for does not exist. The application itself is running — if you
          were expecting a page here, the link is wrong rather than the deployment.
        </p>

        <div
          style={{
            display: "flex",
            gap: "var(--u)",
            flexWrap: "wrap",
            marginTop: "var(--u-4)",
          }}
        >
          <Link className="btn btn--solid" href="/">The week</Link>
          <Link className="btn" href="/intake">Intake</Link>
          <Link className="btn" href="/setup">Semester</Link>
        </div>
      </section>
    </div>
  );
}
