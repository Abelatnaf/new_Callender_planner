/**
 * Bundles the app into one self-contained HTML file.
 *
 * Used to publish a shareable preview. It bundles the REAL components, pages
 * and engine — `next/link` and `next/navigation` are aliased to small shims —
 * so the preview cannot drift from the deployed app. React is bundled rather
 * than pulled from a CDN, because the page must work with no external script
 * loads at all.
 *
 *   node scripts/build-preview.mjs [outfile]
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outFile = process.argv[2] ?? join(root, 'preview', 'order-preview.html')

const result = await build({
  entryPoints: [join(root, 'preview', 'entry.tsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome111', 'safari16', 'firefox111'],
  jsx: 'automatic',
  write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: {
    'next/link': join(root, 'preview', 'shims', 'link.tsx'),
    'next/navigation': join(root, 'preview', 'shims', 'navigation.ts'),
    '@': root,
  },
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
  logLevel: 'warning',
})

const js = result.outputFiles?.[0]?.text ?? ''
if (js === '') throw new Error('esbuild produced no output')

const css = [
  readFileSync(join(root, 'app', 'globals.css'), 'utf8'),
  readFileSync(join(root, 'app', 'print.css'), 'utf8'),
].join('\n')

/**
 * The app names its faces through CSS variables with a real fallback stack, so
 * a preview with no webfont still sets correctly in a serif/sans pairing. The
 * Google Fonts link is the one external resource, and the fallbacks mean a
 * blocked or slow load costs nothing.
 */
const html = `<title>ORDER — week planner</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,500;0,600;1,400&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap">
<style>
:root {
  --font-newsreader: 'Newsreader';
  --font-jakarta: 'Plus Jakarta Sans';
}
${css}
</style>
<div id="root"></div>
<script>${js}</script>
`

writeFileSync(outFile, html)
const kb = (Buffer.byteLength(html) / 1024).toFixed(0)
console.log(`wrote ${outFile} (${kb} KB)`)
