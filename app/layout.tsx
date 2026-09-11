import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { Masthead } from "@/components/Masthead";

export const metadata: Metadata = {
  title: "ORDER — the week you actually have",
  description:
    "A week-planning instrument for a VMI cadet. See which hours are actually yours, and what to do in them.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2efe7" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0c" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Masthead />
          <main>{children}</main>
          <footer className="colophon no-print">
            <div className="wrap" style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", width: "100%" }}>
              <span>Order — the week you actually have</span>
              <span>Your data stays in this browser</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
