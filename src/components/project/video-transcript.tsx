"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ExternalLink, Loader2, Play, RotateCw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { markMatches, searchPhrase, searchTerms, transcriptMoments } from "@/lib/resources/search"
import { formatTimestamp, transcriptSpan } from "@/lib/resources/transcript"
import { parseYouTubeUrl, YOUTUBE_PLAYER_ORIGINS, youtubeEmbedUrl, youtubeMomentUrl, youtubeThumbnailUrl } from "@/lib/resources/youtube"
import { cn } from "@/lib/utils"
import type { ResourceContent, TabResource, TranscriptSegment } from "@/lib/resources/types"
import type { Tab } from "@/lib/tabs/types"

/** A moment to open the reader at — from a search result. `nonce` makes the same moment, asked twice, seek twice. */
export type TranscriptSeek = { seconds?: number; line?: number; nonce: number }

/**
 * A YouTube resource, watched and read in Hubble:
 *
 *     ┌──────────────────────────────┐
 *     │          ▶  player           │   (privacy-enhanced embed, loaded on Play)
 *     └──────────────────────────────┘
 *     Physics Online · English captions          [Open on YouTube at 8:42]
 *
 *     [Search the transcript…]               3 moments
 *     0:00   Welcome back to physics revision.
 *     8:42 ▸ Gravitational potential energy is…   ← playing now
 *
 * Clicking a time (or a line) seeks the player through YouTube's iframe
 * messaging; where there is no player — the desktop app, whose CSP allows no
 * frames — it opens YouTube at that time instead. Transcript text is the
 * source's own words, shown as plain text and selectable.
 *
 * The player is not loaded until the person asks for it: until then the
 * page makes no request to YouTube beyond the still.
 */
export function VideoTranscript({
  tab,
  resource,
  content,
  seek,
  embeddable,
  onOpenAt,
  onRetry,
}: {
  tab: Tab
  resource: TabResource
  /** `undefined` while loading from the device; `null` when the device holds none. */
  content: ResourceContent | null | undefined
  seek?: TranscriptSeek
  /** False on desktop: no frames and no remote images. */
  embeddable: boolean
  onOpenAt: (url: string) => void
  onRetry: () => void
}) {
  const video = parseYouTubeUrl(tab.url)
  const lines = content?.transcript
  const span = useMemo(() => (lines ? transcriptSpan(lines) : 0), [lines])
  const [query, setQuery] = useState("")
  const [player, setPlayer] = useState<{ start?: number } | null>(null)
  const [now, setNow] = useState<number | undefined>(undefined)
  const [picked, setPicked] = useState<number | undefined>(seek?.line)
  const frame = useRef<HTMLIFrameElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const pendingSeek = useRef<number | undefined>(undefined)
  // When the person last scrolled the transcript themselves: following playback waits for them.
  const userScrolledAt = useRef(0)

  /** Brings a line to the middle of the transcript — scrolling the list only, never the dialog around it. */
  const scrollToLine = useCallback((row: number) => {
    const box = list.current
    const item = box?.querySelector<HTMLElement>(`[data-line="${row}"]`)
    if (!box || !item) return
    box.scrollTop = Math.max(0, item.offsetTop - box.clientHeight / 2 + item.offsetHeight / 2)
  }, [])

  const post = useCallback((message: object) => {
    const target = frame.current?.contentWindow
    if (target) target.postMessage(JSON.stringify(message), YOUTUBE_PLAYER_ORIGINS[0]!)
  }, [])

  const seekTo = useCallback(
    (seconds: number | undefined, line?: number) => {
      if (line !== undefined) setPicked(line)
      if (!video) return
      if (!embeddable) {
        onOpenAt(youtubeMomentUrl(video.videoId, seconds))
        return
      }
      if (seconds === undefined) return
      if (!player) {
        // First play starts where asked; the player reads `start` itself.
        setPlayer({ start: seconds })
        return
      }
      if (frame.current?.dataset.ready === "true") {
        post({ event: "command", func: "seekTo", args: [seconds, true] })
        post({ event: "command", func: "playVideo", args: [] })
      } else pendingSeek.current = seconds
      setNow(seconds)
    },
    [video, embeddable, player, post, onOpenAt]
  )

  // A new moment from search marks its line — adjusting state during render, not in an effect.
  const [trackedSeek, setTrackedSeek] = useState(seek?.nonce)
  if (seek?.nonce !== trackedSeek) {
    setTrackedSeek(seek?.nonce)
    if (seek?.line !== undefined) setPicked(seek.line)
  }

  // …and scrolls to it once the transcript is here. Playback waits for the person.
  const scrolledFor = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!seek || !lines || scrolledFor.current === seek.nonce) return
    scrolledFor.current = seek.nonce
    const row = seek.line ?? (seek.seconds !== undefined ? lineAt(lines, seek.seconds) : undefined)
    if (row !== undefined) scrollToLine(row)
  }, [seek, lines, scrollToLine])

  // Where the player is, so the line being said can be marked.
  useEffect(() => {
    if (!player) return
    function onMessage(event: MessageEvent) {
      if (!YOUTUBE_PLAYER_ORIGINS.includes(event.origin) || event.source !== frame.current?.contentWindow) return
      let data: unknown
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data
      } catch {
        return
      }
      const info = (data as { event?: unknown; info?: { currentTime?: unknown } } | null)?.info
      if (typeof info?.currentTime === "number" && Number.isFinite(info.currentTime)) setNow(info.currentTime)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [player])

  const playing = lines && now !== undefined ? lineAt(lines, now) : undefined
  const current = playing ?? picked
  const terms = useMemo(() => searchTerms(query), [query])
  const moments = useMemo(() => (lines && terms.length > 0 ? transcriptMoments(lines, terms, searchPhrase(query), 200).sort((a, b) => a.line - b.line) : null), [lines, terms, query])

  // The transcript follows the video — unless the person is reading elsewhere in it, or searching.
  useEffect(() => {
    if (playing === undefined || moments || Date.now() - userScrolledAt.current < 4000) return
    scrollToLine(playing)
  }, [playing, moments, scrollToLine])
  const resumeAt = now ?? (current !== undefined ? lines?.[current]?.start : undefined)
  const languageName = content?.transcriptInfo?.language ? displayLanguage(content.transcriptInfo.language) : undefined
  const origin = content?.transcriptInfo?.source === "supplied" ? "Transcript you added" : languageName ? `${languageName} captions` : content?.transcriptInfo?.source === "captions" ? "Captions" : undefined

  return (
    <div className="flex flex-col gap-3" data-video-transcript>
      {video && embeddable && (
        <div className="relative aspect-video w-full overflow-hidden rounded-md border border-subtle bg-background">
          {player ? (
            <iframe
              ref={frame}
              title={`YouTube player: ${tab.title?.trim() || "video"}`}
              src={`${youtubeEmbedUrl(video.videoId, { ...(player.start !== undefined ? { start: player.start } : video.startSeconds ? { start: video.startSeconds } : {}), origin: window.location.origin })}&autoplay=1`}
              className="absolute inset-0 size-full"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              onLoad={(event) => {
                event.currentTarget.dataset.ready = "true"
                post({ event: "listening", id: tab.id, channel: "widget" })
                if (pendingSeek.current !== undefined) {
                  post({ event: "command", func: "seekTo", args: [pendingSeek.current, true] })
                  pendingSeek.current = undefined
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="group absolute inset-0 flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={() => setPlayer(video.startSeconds ? { start: video.startSeconds } : {})}
              aria-label="Play video"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a remote still, sized by its box; next/image would proxy it */}
              <img src={youtubeThumbnailUrl(video.videoId)} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 size-full object-cover" />
              <span className="relative flex size-12 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm transition-transform group-hover:scale-105">
                <Play aria-hidden className="ml-0.5 size-5" />
              </span>
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-meta text-tertiary">{origin}</p>
        {video && (
          <Button type="button" size="xs" variant="ghost" onClick={() => onOpenAt(youtubeMomentUrl(video.videoId, resumeAt))}>
            <ExternalLink /> {resumeAt && resumeAt >= 1 ? `Open on YouTube at ${formatTimestamp(resumeAt, span)}` : "Open on YouTube"}
          </Button>
        )}
      </div>

      <TranscriptState resource={resource} content={content} onRetry={onRetry} />

      {lines && lines.length > 0 && (
        <section aria-label="Transcript" className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search the transcript</span>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-tertiary" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the transcript…" className="pl-7" />
            </label>
            {moments && (
              <span role="status" className="shrink-0 text-meta text-tertiary">
                {moments.length === 0 ? "Not said" : `${moments.length} ${moments.length === 1 ? "moment" : "moments"}`}
              </span>
            )}
          </div>
          <ol
            ref={list}
            className="relative max-h-72 overflow-y-auto rounded-md border border-subtle"
            aria-label={moments ? "Matching moments" : "Transcript lines"}
            onWheel={() => (userScrolledAt.current = Date.now())}
            onTouchMove={() => (userScrolledAt.current = Date.now())}
          >
            {moments
              ? moments.map((moment) => (
                  <TranscriptRow
                    key={moment.line}
                    line={lines[moment.line]!}
                    index={moment.line}
                    span={span}
                    text={moment.snippet}
                    terms={terms}
                    current={current === moment.line}
                    canSeek={Boolean(video)}
                    onSeek={seekTo}
                  />
                ))
              : lines.map((line, index) => <TranscriptRow key={index} line={line} index={index} span={span} text={line.text} current={current === index} canSeek={Boolean(video)} onSeek={seekTo} />)}
          </ol>
          {content?.truncated && <p className="text-meta text-tertiary">Only the first part of a very long transcript is kept.</p>}
        </section>
      )}
    </div>
  )
}

function TranscriptState({ resource, content, onRetry }: { resource: TabResource; content: ResourceContent | null | undefined; onRetry: () => void }) {
  if (resource.status === "pending" || resource.status === "processing") {
    return (
      <p role="status" className="flex items-center gap-1.5 text-body-sm text-muted-foreground" data-transcript-state="extracting">
        <Loader2 aria-hidden className="size-3.5 animate-spin" /> Getting the transcript…
      </p>
    )
  }
  if (resource.status === "ready") {
    if (content === undefined)
      return (
        <p role="status" className="text-body-sm text-muted-foreground" data-transcript-state="loading">
          Loading the transcript…
        </p>
      )
    if (!content?.transcript?.length)
      return (
        <p className="flex flex-wrap items-center gap-2 text-body-sm text-muted-foreground" data-transcript-state="missing">
          The transcript isn&apos;t on this device any more.
          <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
            <RotateCw /> Get it again
          </Button>
        </p>
      )
    return null
  }
  const error = resource.error
  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-body-sm", resource.status === "failed" ? "text-destructive" : "text-muted-foreground")} data-transcript-state={resource.status === "failed" ? "failed" : "unavailable"}>
      <span className="min-w-0">{error?.message ?? "Hubble has no transcript of this video."}</span>
      {error?.retryable && (
        <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
          <RotateCw /> Try again
        </Button>
      )}
    </div>
  )
}

function TranscriptRow({
  line,
  index,
  span,
  text,
  terms,
  current,
  canSeek,
  onSeek,
}: {
  line: TranscriptSegment
  index: number
  span: number
  text: string
  terms?: readonly string[]
  current: boolean
  canSeek: boolean
  onSeek: (seconds: number | undefined, line?: number) => void
}) {
  const stamp = line.start !== undefined ? formatTimestamp(line.start, span) : undefined
  const parts = terms ? markMatches(text, terms) : [{ text, match: false }]
  return (
    <li
      data-line={index}
      aria-current={current ? "true" : undefined}
      className={cn("flex items-baseline gap-3 px-2 py-1 [contain-intrinsic-size:auto_28px] [content-visibility:auto]", current && "bg-surface-active", canSeek && line.start !== undefined && "cursor-pointer hover:bg-surface-hover")}
      onClick={() => {
        // Selecting text to copy is reading, not seeking.
        if (!canSeek || line.start === undefined || (typeof window !== "undefined" && window.getSelection()?.toString())) return
        onSeek(line.start, index)
      }}
    >
      {stamp && canSeek ? (
        <button
          type="button"
          className="w-14 shrink-0 text-left font-mono text-meta text-muted-foreground tabular-nums outline-none hover:text-link hover:underline focus-visible:text-link focus-visible:underline"
          aria-label={`Play from ${stamp}`}
          onClick={(event) => {
            event.stopPropagation()
            onSeek(line.start, index)
          }}
        >
          {stamp}
        </button>
      ) : (
        <span className="w-14 shrink-0 font-mono text-meta text-tertiary tabular-nums">{stamp ?? ""}</span>
      )}
      <span className="min-w-0 flex-1 text-body-sm text-foreground select-text">
        {parts.map((part, key) =>
          part.match ? (
            <mark key={key} className="rounded-xs bg-surface-active px-0.5 text-foreground">
              {part.text}
            </mark>
          ) : (
            <span key={key}>{part.text}</span>
          )
        )}
      </span>
    </li>
  )
}

/** The line being said at `seconds`: the last one that has started. */
export function lineAt(lines: readonly TranscriptSegment[], seconds: number): number | undefined {
  let found: number | undefined
  let low = 0
  let high = lines.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const start = lines[mid]!.start
    if (start === undefined) return undefined
    if (start <= seconds + 0.25) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  return found
}

function displayLanguage(tag: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(tag) ?? tag
  } catch {
    return tag
  }
}
