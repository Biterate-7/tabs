"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { bytesToBase64, detectTransferSupport, sendTransfer } from "@/lib/ai-transfer/client"
import { newOpId } from "@/lib/ai-transfer/protocol"
import { getFile } from "@/lib/resources/content-store"
import type { TransferPackage, TransferMode } from "@/lib/ai-transfer/package"
import type { NotAttached, TransferError, TransferFile, TransferResult, TransferState } from "@/lib/ai-transfer/protocol"
import type { TransferSupport } from "@/lib/ai-transfer/client"
import type { AiProviderId } from "@/lib/providers/registry"

/**
 * Use in AI's run, for the dialog: whether Hubble for Chrome can transfer
 * here, and one transfer at a time from "preparing" to a result.
 *
 * Preparing loads each attached file's original from this device; one that
 * isn't there is re-planned as text (`replan`) before anything leaves
 * Hubble, so the message never names a file that won't arrive.
 *
 * Trying again after a failure reuses the operation id when nothing about
 * the transfer changed, so the extension continues in the same tab instead
 * of opening another; after a success it answers with the same result and
 * types nothing twice.
 */

export type TransferRun =
  | { status: "idle" }
  | { status: "running"; state: TransferState }
  | { status: "done"; result: Extract<TransferResult, { ok: true }> }
  | { status: "failed"; error: TransferError; notAttached?: NotAttached[] }

export type TransferInput = {
  workspaceId: string
  provider: AiProviderId
  mode: TransferMode
  plan: TransferPackage
  /** The person's own edit of the message, when they made one: typed as is, with no all-text alternative. */
  draft: string | null
  /** The plan again, with these files' originals treated as missing. */
  replan: (missing: ReadonlySet<string>) => TransferPackage
}

function fingerprint(input: TransferInput, plan: TransferPackage): string {
  return JSON.stringify([input.provider, input.mode, input.draft ?? plan.text, plan.fallbackText ?? "", plan.attachments.map((file) => `${file.key}:${file.size}`)])
}

export function useAiTransfer(open: boolean) {
  const [support, setSupport] = useState<TransferSupport | null>(null)
  const [run, setRun] = useState<TransferRun>({ status: "idle" })
  const last = useRef<{ opId: string; fingerprint: string } | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    if (!open) return
    let live = true
    void detectTransferSupport().then((answer) => {
      if (live) setSupport(answer)
    })
    return () => {
      live = false
    }
  }, [open])

  const start = useCallback(async (input: TransferInput): Promise<TransferRun> => {
    if (busy.current) return { status: "running", state: "preparing" }
    busy.current = true
    const finish = (next: TransferRun) => {
      setRun(next)
      busy.current = false
      return next
    }
    setRun({ status: "running", state: "preparing" })
    try {
      // The originals, from this device. A missing one goes as text instead (re-planned), never named as attached.
      let plan = input.plan
      const files: TransferFile[] = []
      const missing = new Set<string>()
      const loaded = new Map<string, ArrayBuffer>()
      for (const attachment of plan.attachments) {
        if (attachment.generated) continue
        const ref = attachment.ref
        const stored = ref?.kind === "note" ? await getFile(input.workspaceId, ref.noteId).catch(() => undefined) : undefined
        if (stored && stored.bytes.byteLength === attachment.size) loaded.set(attachment.key, stored.bytes)
        else missing.add(attachment.key)
      }
      if (missing.size > 0) plan = input.replan(missing)
      for (const attachment of plan.attachments) {
        if (attachment.generated) {
          const bytes = new TextEncoder().encode(attachment.generated.text)
          files.push({ name: attachment.name, type: attachment.type, size: bytes.byteLength, data: await bytesToBase64(bytes, attachment.type) })
          continue
        }
        const bytes = loaded.get(attachment.key)
        if (!bytes) return finish({ status: "failed", error: "failed" })
        files.push({ name: attachment.name, type: attachment.type, size: bytes.byteLength, data: await bytesToBase64(bytes, attachment.type) })
      }
      if (plan.overLimit && input.draft === null) return finish({ status: "failed", error: "invalid" })

      const print = fingerprint(input, plan)
      const opId = last.current?.fingerprint === print ? last.current.opId : newOpId()
      last.current = { opId, fingerprint: print }
      const result = await sendTransfer(
        {
          opId,
          provider: input.provider,
          mode: input.mode,
          text: input.draft ?? plan.text,
          ...(input.draft === null && plan.fallbackText ? { fallbackText: plan.fallbackText } : {}),
          files,
        },
        (state) => setRun({ status: "running", state })
      )
      if (result.ok) return finish({ status: "done", result })
      // "Already running" is the same transfer still going: keep the id, so a later try picks up its answer.
      return finish({ status: "failed", error: result.error, ...(result.notAttached ? { notAttached: result.notAttached } : {}) })
    } catch {
      return finish({ status: "failed", error: "failed" })
    }
  }, [])

  const reset = useCallback(() => {
    if (!busy.current) setRun({ status: "idle" })
  }, [])

  return { support, run, start, reset }
}
