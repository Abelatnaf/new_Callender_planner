/**
 * Handing the user a file.
 *
 * One place that knows how to do this, because there are two environments to
 * satisfy and they disagree:
 *
 *   - A normal browser tab: an anchor with a blob URL, clicked.
 *   - The artifact viewer: frame code is never allowed to download directly.
 *     A page there must ask the host, which shows the viewer a confirmation
 *     they can decline. An anchor click is silently inert.
 *
 * Without this, the export button works locally and does nothing at all in the
 * hosted preview — a control that looks live and isn't, which is worse than one
 * that is plainly absent.
 */

/** The sliver of the artifact runtime this needs. Absent in a normal tab. */
interface ArtifactRuntime {
  use?: (name: string) => Promise<unknown>
}

interface DownloadsNamespace {
  save: (request: { filename: string; data: string | Blob }) => Promise<unknown>
}

function runtime(): ArtifactRuntime | undefined {
  return (globalThis as { claude?: ArtifactRuntime }).claude
}

function isDownloads(value: unknown): value is DownloadsNamespace {
  return typeof value === 'object' && value !== null && typeof (value as DownloadsNamespace).save === 'function'
}

export type SaveOutcome =
  | { ok: true; via: 'host' | 'anchor' }
  | { ok: false; reason: 'declined' | 'failed'; message: string }

/**
 * Offer `contents` to the user as `filename`.
 *
 * Call it from an explicit action — a click — never on load: the host shows a
 * confirmation, and an unprompted one reads as a page misbehaving.
 */
export async function saveFile(
  filename: string,
  contents: string,
  mimeType = 'application/json',
): Promise<SaveOutcome> {
  const claude = runtime()

  if (claude?.use) {
    try {
      const downloads = await claude.use('downloads')
      if (isDownloads(downloads)) {
        try {
          await downloads.save({ filename, data: contents })
          return { ok: true, via: 'host' }
        } catch (error) {
          // The viewer declining is an ordinary outcome, not a failure to
          // report as breakage, and must never be retried automatically.
          const code = (error as { code?: string } | null)?.code
          if (code === 'declined' || code === 'rate_limited') {
            return { ok: false, reason: 'declined', message: 'The save was cancelled.' }
          }
          // Anything else: fall through and try the ordinary path.
        }
      }
    } catch {
      // `use` itself failing is the same as the capability being absent.
    }
  }

  try {
    const blob = new Blob([contents], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    return { ok: true, via: 'anchor' }
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : 'The file could not be saved.',
    }
  }
}
