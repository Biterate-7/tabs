"use client"

import { useCallback, useEffect, useRef } from "react"
import { getFile, putContent, putFile, deleteContent } from "@/lib/resources/content-store"
import { bytesHash, checkFile, cleanFileName, FILE_FORMAT_MIME, FILE_LIMITS } from "@/lib/files/formats"
import { composeFileNote, failFileRead, FILE_NOTE_ERRORS, MAX_FILE_READS, readFileNote, restartFileRead, startFileRead } from "@/lib/files/note"
import { addProjectNote, findFileByHash, NOTE_LIMITS, updateProjectNote } from "@/lib/notes/notes"
import { recordProjectEvent } from "@/lib/projects/activity"
import { recordLoopMilestone } from "@/lib/product/loop-log"
import { saveFile } from "@/lib/platform"
import { createId } from "@/lib/id"
import type { FileReadDeps } from "@/lib/files/note"
import type { NoteFile, ProjectNote } from "@/lib/notes/notes"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * Uploaded files, from the device to readable project knowledge.
 *
 *   upload    check each file, keep its original on this device, add it to
 *             the project ("Reading…"), then read it here — one file at a
 *             time, so a batch of large PDFs never holds them all in memory
 *   reload    a file still "Reading…" is read again from its kept original,
 *             a bounded number of times (MAX_FILE_READS), then says so
 *   retry     "Read again" on a file whose failure might pass
 *   download  the kept original, saved back out (a download on the web, a
 *             Save dialog in Hubble Desktop)
 *
 * Every write goes through the app's one commit seam against the store as it
 * is *then*: a file removed while it was being read stays removed, and its
 * text and original are forgotten. Nothing leaves the device.
 */

export type UploadOutcome =
  | { status: "added"; name: string; noteId: string }
  | { status: "duplicate"; name: string; noteId: string }
  | { status: "rejected"; name: string; message: string }
  | { status: "failed"; name: string; message: string }

export type FileActions = {
  /** `onOutcome` hears each file's outcome as soon as it has one — before the files after it are read. */
  upload: (workspaceId: string, files: readonly File[], onOutcome?: (index: number, outcome: UploadOutcome) => void) => Promise<UploadOutcome[]>
  retry: (workspaceId: string, noteId: string) => void
  /** "missing": this device no longer has the original. "not-saved": the save failed, or the person cancelled the Save dialog. */
  download: (workspaceId: string, noteId: string) => Promise<"saved" | "not-saved" | "missing">
}

export type FileUploadDeps = FileReadDeps & {
  putFile: typeof putFile
  getFile: typeof getFile
  newId: () => string
}

function updateFile(store: WorkspaceStore, workspaceId: string, noteId: string, update: (note: ProjectNote) => { file: NoteFile; chars?: number } | null, now: number): WorkspaceStore | null {
  const note = store.workspaces.find((workspace) => workspace.id === workspaceId)?.notes?.find((entry) => entry.id === noteId)
  if (!note || note.kind !== "file" || !note.file) return null
  const patch = update(note)
  if (!patch) return null
  return updateProjectNote(store, workspaceId, noteId, { file: patch.file, ...(patch.chars !== undefined ? { chars: patch.chars } : {}) }, now)
}

function findFileNote(store: WorkspaceStore | null, workspaceId: string, noteId: string): ProjectNote | undefined {
  const note = store?.workspaces.find((workspace) => workspace.id === workspaceId)?.notes?.find((entry) => entry.id === noteId)
  return note?.kind === "file" && note.file ? note : undefined
}

export function useFileUploads(options: {
  store: WorkspaceStore | null
  /** The latest committed store, read at the moment of each write. */
  getStore: () => WorkspaceStore | null
  commit: (next: WorkspaceStore) => void
  enabled: boolean
  /** Injected in tests. */
  deps?: Partial<FileUploadDeps>
}): FileActions {
  const { store, enabled } = options
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })
  // Readings in progress or queued, by `<workspace>:<note>`; and the one queue they run on.
  const running = useRef(new Set<string>())
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const deps = useCallback(
    (): FileUploadDeps => ({ putContent, putFile, getFile, now: () => Date.now(), newId: createId, ...optionsRef.current.deps }),
    []
  )
  const getStore = useCallback(() => optionsRef.current.getStore(), [])
  const apply = useCallback((next: WorkspaceStore | null) => {
    if (next) optionsRef.current.commit(next)
  }, [])

  /** Reads one file (from `bytes`, or its kept original) and settles its note — unless it was removed or restarted meanwhile. */
  const read = useCallback(
    (workspaceId: string, noteId: string, bytes?: Uint8Array) => {
      const key = `${workspaceId}:${noteId}`
      running.current.add(key)
      const work = async () => {
        const d = deps()
        const note = findFileNote(getStore(), workspaceId, noteId)
        if (!note) return
        let data = bytes
        if (!data) {
          const stored = await d.getFile(workspaceId, noteId).catch(() => undefined)
          if (!stored) {
            const latest = getStore()
            if (latest) apply(updateFile(latest, workspaceId, noteId, (current) => (current.file?.status === "processing" ? { file: failFileRead(current.file, FILE_NOTE_ERRORS.missing) } : null), d.now()))
            return
          }
          data = new Uint8Array(stored.bytes)
        }
        const result = await readFileNote(workspaceId, note, data, d)
        const latest = getStore()
        const current = findFileNote(latest, workspaceId, noteId)
        if (!latest || !current) {
          // Removed while it was being read: nothing may claim this text.
          await deleteContent(workspaceId, [noteId]).catch(() => undefined)
          return
        }
        if (current.file?.status !== "processing") return
        apply(updateFile(latest, workspaceId, noteId, () => result, d.now()))
        if (result.file.status === "ready") {
          recordProjectEvent({ workspaceId, kind: "source_ready", tabId: noteId })
          recordLoopMilestone("resource_ready")
        } else if (result.file.status === "failed") {
          recordProjectEvent({ workspaceId, kind: "source_failed", tabId: noteId })
          recordLoopMilestone("resource_failed")
        }
      }
      const run = queue.current.then(work).catch(() => {
        const latest = getStore()
        if (latest) apply(updateFile(latest, workspaceId, noteId, (current) => (current.file?.status === "processing" ? { file: failFileRead(current.file, FILE_NOTE_ERRORS.interrupted) } : null), Date.now()))
      })
      queue.current = run.finally(() => running.current.delete(key))
      return run
    },
    [apply, deps, getStore]
  )

  // A file still "Reading…" with nobody reading it — a reload cut it short — is read again from its original, or says it stopped.
  useEffect(() => {
    if (!enabled || !store) return
    for (const workspace of store.workspaces) {
      for (const note of workspace.notes ?? []) {
        if (note.kind !== "file" || note.file?.status !== "processing") continue
        const key = `${workspace.id}:${note.id}`
        if (running.current.has(key)) continue
        const latest = getStore()
        if (!latest) return
        if ((note.file.attempts ?? 0) >= MAX_FILE_READS) {
          apply(updateFile(latest, workspace.id, note.id, (current) => ({ file: failFileRead(current.file!, FILE_NOTE_ERRORS.interrupted) }), Date.now()))
          continue
        }
        apply(updateFile(latest, workspace.id, note.id, (current) => ({ file: startFileRead(current.file!) }), Date.now()))
        void read(workspace.id, note.id)
      }
    }
  }, [store, enabled, apply, getStore, read])

  const upload = useCallback<FileActions["upload"]>(
    async (workspaceId, files, onOutcome) => {
      const outcomes: UploadOutcome[] = []
      const d = deps()
      const say = (index: number, outcome: UploadOutcome) => {
        outcomes[index] = outcome
        onOutcome?.(index, outcome)
      }
      const reads: Promise<unknown>[] = []
      let added = 0
      for (let index = 0; index < files.length; index++) {
        const file = files[index]!
        const name = cleanFileName(file.name)
        if (index >= FILE_LIMITS.perUpload) {
          say(index, { status: "rejected", name, message: `Add up to ${FILE_LIMITS.perUpload} files at a time.` })
          continue
        }
        const check = checkFile(file)
        if (!check.ok) {
          say(index, { status: "rejected", name, message: check.message })
          continue
        }
        const workspace = getStore()?.workspaces.find((entry) => entry.id === workspaceId)
        if (!workspace) {
          say(index, { status: "failed", name, message: "That project is gone." })
          continue
        }
        if ((workspace.notes?.length ?? 0) >= NOTE_LIMITS.notesPerProject) {
          say(index, { status: "failed", name, message: "This project is full. Remove some items first." })
          continue
        }
        let bytes: Uint8Array
        try {
          bytes = new Uint8Array(await file.arrayBuffer())
        } catch {
          say(index, { status: "failed", name, message: "This file couldn't be opened. It may have been moved or deleted." })
          continue
        }
        const hash = bytesHash(bytes)
        const existing = findFileByHash(workspace, hash)
        if (existing) {
          say(index, { status: "duplicate", name, noteId: existing.id })
          continue
        }
        const noteId = d.newId()
        try {
          // The original first: no item ever lists a file this device doesn't have.
          await d.putFile(workspaceId, noteId, bytes.buffer as ArrayBuffer, { name, type: FILE_FORMAT_MIME[check.format], now: d.now() })
        } catch {
          say(index, { status: "failed", name, message: "There isn't room to keep this file on this device. Free up some space and try again." })
          continue
        }
        const latest = getStore()
        if (!latest?.workspaces.some((entry) => entry.id === workspaceId)) {
          await deleteContent(workspaceId, [noteId]).catch(() => undefined)
          say(index, { status: "failed", name, message: "That project is gone." })
          continue
        }
        const note = composeFileNote({ id: noteId, name, format: check.format, size: file.size, hash, now: d.now() })
        apply(addProjectNote(latest, workspaceId, note, d.now()))
        added += 1
        say(index, { status: "added", name, noteId })
        reads.push(read(workspaceId, noteId, bytes))
      }
      if (added > 0) {
        recordProjectEvent({ workspaceId, kind: "sources_added", count: added })
        recordLoopMilestone("resource_added")
      }
      // Reading carries on in the background; callers watch each file's status on the project.
      void Promise.all(reads)
      return outcomes
    },
    [apply, deps, getStore, read]
  )

  const retry = useCallback(
    (workspaceId: string, noteId: string) => {
      const latest = getStore()
      if (!latest || running.current.has(`${workspaceId}:${noteId}`)) return
      const next = updateFile(latest, workspaceId, noteId, (current) => (current.file && current.file.status !== "processing" ? { file: restartFileRead(current.file) } : null), Date.now())
      if (!next) return
      apply(next)
      void read(workspaceId, noteId)
    },
    [apply, getStore, read]
  )

  const download = useCallback(
    async (workspaceId: string, noteId: string) => {
      const note = findFileNote(getStore(), workspaceId, noteId)
      if (!note?.file) return "missing" as const
      const stored = await deps()
        .getFile(workspaceId, noteId)
        .catch(() => undefined)
      if (!stored) return "missing" as const
      return (await saveFile(note.file.name, new Uint8Array(stored.bytes), stored.type || FILE_FORMAT_MIME[note.file.format])) ? ("saved" as const) : ("not-saved" as const)
    },
    [deps, getStore]
  )

  return { upload, retry, download }
}
