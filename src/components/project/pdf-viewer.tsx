"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Minus, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { findMatchRanges, PDF_HIGHLIGHT_NAME, paintMatches } from "@/lib/files/pdf-highlight"
import { paintRatio } from "@/lib/files/pdf-view"
import type { PdfPageSize, PdfTask, PdfView } from "@/lib/files/pdf-view"

/** Space around the pages, in px. */
const GUTTER = 12
/** Zoom steps, as a fraction of "fit to width". */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const
/** Used until the viewer has been measured (and where nothing can be: tests). */
const FALLBACK_WIDTH = 720
/** Without IntersectionObserver, this many pages from the top are drawn. */
const FALLBACK_PAGES = 3

/**
 * A PDF, shown as the PDF it is: every page drawn from the original file in a
 * continuous, scrolling column — layout, equations, diagrams and scanned
 * pictures exactly as authored.
 *
 * Only the pages near the screen are painted. The other pages are empty boxes
 * of the right size, so a 900-page file opens at once, scrolls like any long
 * document and never holds more than a few pages' pixels. Over each painted
 * page is its invisible text, so words can be selected and a search hit is
 * marked where it is on the page.
 */
export function PdfViewer({ view, focusPage, terms, label }: { view: PdfView; focusPage?: number; terms?: readonly string[]; label: string }) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const pageEls = useRef(new Map<number, HTMLElement>())
  const observer = useRef<IntersectionObserver | null>(null)
  const textLayers = useRef(new Map<number, HTMLElement>())
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [sizes, setSizes] = useState<ReadonlyMap<number, PdfPageSize>>(new Map())
  const [observed, setObserved] = useState<ReadonlySet<number>>(new Set())
  const [current, setCurrent] = useState(Math.min(Math.max(focusPage ?? 1, 1), view.pageCount))
  const [firstFailed, setFirstFailed] = useState(false)
  const keepRatio = useRef<number | null>(null)
  const aligned = useRef<{ page: number; top: number } | null>(null)

  const defaultSize = sizes.get(1)
  const available = Math.max(160, (width || FALLBACK_WIDTH) - GUTTER * 2)
  const pageWidth = Math.round(available * zoom)
  const heightOf = useCallback(
    (page: number) => {
      const size = sizes.get(page) ?? defaultSize
      return size ? Math.round((pageWidth * size.height) / size.width) : 0
    },
    [sizes, defaultSize, pageWidth]
  )

  // The first page tells the size every other page is boxed at until it is loaded itself.
  useEffect(() => {
    let cancelled = false
    view
      .page(1)
      .then((page) => !cancelled && setSizes((known) => new Map(known).set(1, page.size)))
      .catch(() => !cancelled && setFirstFailed(true))
    return () => {
      cancelled = true
    }
  }, [view])

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const watcher = new ResizeObserver(measure)
    watcher.observe(element)
    return () => watcher.disconnect()
  }, [])

  // Which pages are near the screen.
  const ready = defaultSize !== undefined
  const canObserve = typeof IntersectionObserver !== "undefined"
  const active = useMemo<ReadonlySet<number>>(
    () => (canObserve ? observed : new Set(Array.from({ length: Math.min(view.pageCount, Math.max(FALLBACK_PAGES, focusPage ?? 0)) }, (_, index) => index + 1))),
    [canObserve, observed, view, focusPage]
  )
  useEffect(() => {
    if (!ready || !canObserve) return
    const near = new Set<number>()
    const watcher = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.filePage)
          if (entry.isIntersecting) near.add(page)
          else near.delete(page)
        }
        setObserved(new Set(near))
      },
      { root: scroller.current, rootMargin: "100% 0px" }
    )
    observer.current = watcher
    for (const element of pageEls.current.values()) watcher.observe(element)
    return () => {
      watcher.disconnect()
      observer.current = null
    }
  }, [ready, canObserve, view])

  const register = useCallback((page: number, element: HTMLElement | null) => {
    const previous = pageEls.current.get(page)
    if (previous && previous !== element) observer.current?.unobserve(previous)
    if (element) {
      pageEls.current.set(page, element)
      observer.current?.observe(element)
    } else {
      pageEls.current.delete(page)
    }
  }, [])

  const align = useCallback((page: number) => {
    const container = scroller.current
    const element = pageEls.current.get(page)
    if (!container || !element) return
    const top = Math.max(0, element.offsetTop - GUTTER)
    container.scrollTop = top
    aligned.current = { page, top }
  }, [])

  // Open at the page a search hit named.
  useLayoutEffect(() => {
    if (ready && focusPage) align(Math.min(Math.max(focusPage, 1), view.pageCount))
  }, [ready, focusPage, view, align])

  // Zoom keeps the same part of the document in view.
  useLayoutEffect(() => {
    const container = scroller.current
    if (container && keepRatio.current !== null) {
      container.scrollTop = keepRatio.current * container.scrollHeight
      keepRatio.current = null
    }
  }, [pageWidth])

  const changeZoom = (next: number) => {
    const container = scroller.current
    if (container && container.scrollHeight > 0) keepRatio.current = container.scrollTop / container.scrollHeight
    setZoom(next)
  }
  const zoomOut = () => changeZoom([...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ?? ZOOM_STEPS[0])
  const zoomIn = () => changeZoom(ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!)

  // The page being read: the first one that reaches past the top third of the screen.
  const frame = useRef(0)
  const onScroll = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const container = scroller.current
      if (!container) return
      const line = container.scrollTop + container.clientHeight / 3
      for (let page = 1; page <= view.pageCount; page++) {
        const element = pageEls.current.get(page)
        if (element && element.offsetTop + element.offsetHeight > line) {
          setCurrent(page)
          return
        }
      }
    })
  }
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current)
    },
    []
  )

  // The page's real size replaces the guess; the page a search hit opened at stays put.
  const onSize = useCallback(
    (page: number, size: PdfPageSize) => {
      let changed = false
      setSizes((known) => {
        const had = known.get(page)
        if (had && Math.abs(had.width - size.width) < 0.5 && Math.abs(had.height - size.height) < 0.5) return known
        changed = true
        return new Map(known).set(page, size)
      })
      const mark = aligned.current
      if (changed && mark && mark.page === page && scroller.current && Math.abs(scroller.current.scrollTop - mark.top) < 4) requestAnimationFrame(() => align(page))
    },
    [align]
  )

  // Search words, marked on every page that is drawn.
  const termKey = (terms ?? []).join(",")
  const termList = useMemo(() => (termKey ? termKey.split(",") : []), [termKey])
  const termsRef = useRef(termList)
  const repaintMarks = useCallback(() => {
    const ranges: Range[] = []
    for (const layer of textLayers.current.values()) ranges.push(...findMatchRanges(layer, termsRef.current))
    paintMatches(ranges)
  }, [])
  useEffect(() => {
    termsRef.current = termList
    repaintMarks()
  }, [termList, repaintMarks])
  useEffect(() => () => paintMatches([]), [])
  const onText = useCallback(
    (page: number, layer: HTMLElement | null) => {
      if (layer) textLayers.current.set(page, layer)
      else textLayers.current.delete(page)
      repaintMarks()
    },
    [repaintMarks]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-background-secondary" data-pdf-viewer>
      {/* The search marks' colour. Written here rather than in globals.css: the CSS optimizer doesn't know ::highlight() yet. */}
      <style>{`::highlight(${PDF_HIGHLIGHT_NAME}) { background-color: rgb(255 210 0 / 0.45); color: transparent; }`}</style>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1">
        <span className="text-meta text-muted-foreground" aria-live="polite">
          Page {current.toLocaleString()} of {view.pageCount.toLocaleString()}
        </span>
        <div className="flex items-center gap-0.5">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom out" disabled={zoom <= ZOOM_STEPS[0]} onClick={zoomOut}>
            <Minus />
          </Button>
          <Button type="button" variant="ghost" size="sm" className="min-w-14 tabular-nums" aria-label="Fit to width" title="Fit to width" onClick={() => changeZoom(1)}>
            {Math.round(zoom * 100)}%
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom in" disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!} onClick={zoomIn}>
            <Plus />
          </Button>
        </div>
      </div>
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto" role="document" aria-label={label} tabIndex={0} data-pdf-scroll>
        {firstFailed ? (
          <p role="alert" className="p-4 text-body-sm text-destructive">
            The first page couldn&apos;t be drawn. The file may be damaged.
          </p>
        ) : !ready ? (
          <p className="p-4 text-body-sm text-muted-foreground">Opening…</p>
        ) : (
          <div className="flex w-max min-w-full flex-col items-center gap-3" style={{ padding: GUTTER }}>
            {Array.from({ length: view.pageCount }, (_, index) => index + 1).map((page) => (
              <PdfPageSlot key={page} view={view} number={page} width={pageWidth} height={heightOf(page)} active={active.has(page)} register={register} onSize={onSize} onText={onText} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PdfPageSlot({
  view,
  number,
  width,
  height,
  active,
  register,
  onSize,
  onText,
}: {
  view: PdfView
  number: number
  width: number
  height: number
  active: boolean
  register: (page: number, element: HTMLElement | null) => void
  onSize: (page: number, size: PdfPageSize) => void
  onText: (page: number, layer: HTMLElement | null) => void
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const text = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState(false)
  const ref = useCallback((element: HTMLElement | null) => register(number, element), [register, number])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const tasks: PdfTask[] = []
    void (async () => {
      try {
        const page = await view.page(number)
        if (cancelled) return
        setFailed(false)
        onSize(number, page.size)
        const scale = width / page.size.width
        const ratio = paintRatio(width, (width * page.size.height) / page.size.width, window.devicePixelRatio)
        // Painted off screen and swapped in whole, so a page being redrawn (zoom) never shows half a picture or a blank.
        const drawing = document.createElement("canvas")
        const painting = page.paint(drawing, scale, ratio)
        tasks.push(painting)
        const layer = text.current
        layer?.replaceChildren()
        onText(number, null)
        const lettering = layer ? page.layText(layer, scale) : undefined
        if (lettering) tasks.push(lettering)
        await painting.done
        if (cancelled) return
        const target = canvas.current
        if (target) {
          target.width = drawing.width
          target.height = drawing.height
          target.getContext("2d")?.drawImage(drawing, 0, 0)
        }
        // A page whose text can't be laid over it is still a page.
        await lettering?.done.catch(() => undefined)
        if (!cancelled && layer) onText(number, layer)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      for (const task of tasks) task.cancel()
    }
  }, [active, view, number, width, onSize, onText])

  // Pages that scroll away give their pixels back.
  const wasActive = useRef(false)
  useEffect(() => {
    const left = wasActive.current && !active
    wasActive.current = active
    if (!left) return
    onText(number, null)
    text.current?.replaceChildren()
    void view.page(number).then((page) => page.release()).catch(() => undefined)
  }, [active, view, number, onText])

  return (
    <article
      ref={ref}
      aria-label={`Page ${number}`}
      className="relative shrink-0 bg-white shadow-md"
      style={{ width, height: height || undefined, minHeight: height ? undefined : 120 }}
      data-file-page={number}
    >
      {/* Only a page near the screen has a canvas: the others are empty boxes, holding no pixels. */}
      {active && <canvas ref={canvas} aria-hidden className="absolute inset-0 size-full" />}
      <div ref={text} className="pdf-text-layer" />
      {failed && (
        <p role="alert" className="absolute inset-0 grid place-items-center p-4 text-center text-body-sm text-neutral-600">
          This page couldn&apos;t be drawn.
        </p>
      )}
    </article>
  )
}
