import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { Masthead } from "@/components/Masthead";

export const metadata: Metadata = {
  title: "ORDER — the week you actually have",
  description:
    "A week-planning instrument for a VMI cadet. Ink is obligation; white space is freedom.",
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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=JetBrains+Mono:wght@400;500;700&display=swap"
        />
      </head>
      <body>
        <div className="shell">
          <Masthead />
          <main>{children}</main>
          <footer className="colophon no-print">
            <div className="wrap" style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", width: "100%" }}>
              <span>ORDER — ink is obligation, white space is freedom</span>
              <span>Your data stays in this browser</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
