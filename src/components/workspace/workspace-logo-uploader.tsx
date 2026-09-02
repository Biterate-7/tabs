"use client"

import { useRef, useState, type ChangeEvent } from "react"
import { Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { processLogoFile } from "@/lib/workspace/logo"

/**
 * The "Workspace Logo" field inside the workspace edit dialog (see
 * rename-workspace-dialog.tsx): a preview, an upload/change action behind a
 * visually hidden file input, and a remove action shown only once a logo
 * exists. Upload and remove both take effect immediately via `onChange`
 * (there's no separate Save step for the logo, unlike the name field above
 * it) — the caller persists on every call, same as every other in-place
 * workspace edit in this app.
 */
export function WorkspaceLogoUploader({
  workspaceName,
  logo,
  onChange,
}: {
  workspaceName: string
  logo?: string
  onChange: (logo: string | undefined) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setError(null)
    setProcessing(true)
    const result = await processLogoFile(file)
    setProcessing(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onChange(result.dataUrl)
  }

  function handleRemove() {
    setError(null)
    onChange(undefined)
  }

  return (
    <div className="mt-4">
      <p className="text-label text-tertiary">Workspace logo</p>
      <div className="mt-2 flex items-center gap-3">
        <WorkspaceAvatar workspace={{ name: workspaceName, logo }} size={48} />
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={processing}
              onClick={() => inputRef.current?.click()}
            >
              <Upload /> {processing ? "Processing…" : logo ? "Change image" : "Upload image"}
            </Button>
            {logo && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                aria-label="Remove workspace logo"
                onClick={handleRemove}
              >
                <X /> Remove
              </Button>
            )}
          </div>
          <p className="text-meta text-tertiary">PNG, JPG, WEBP, or SVG. Max 10MB.</p>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="hidden"
        onChange={handleFileChange}
        aria-label="Upload workspace logo"
      />

      {error && (
        <p role="alert" className="mt-2 text-meta text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
