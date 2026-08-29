import { Button, buttonVariants } from "@/components/ui/button"
import { EXTENSION_DOWNLOAD_URL } from "@/lib/extension-config"

const STEPS = [
  "Download the TabDump extension.",
  <>
    Extract the downloaded <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">tabdump-extension.zip</code>{" "}
    file — do not select the .zip itself in Chrome.
  </>,
  <>
    Open <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">chrome://extensions</code> in
    Chrome.
  </>,
  <>
    Turn on <strong className="font-semibold text-foreground">Developer mode</strong>.
  </>,
  <>
    Click <strong className="font-semibold text-foreground">Load unpacked</strong>.
  </>,
  <>
    Select the extracted <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">tabdump-extension</code>{" "}
    folder — the one containing <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">manifest.json</code>.
  </>,
  "Pin TabDump to your Chrome toolbar.",
  "Return to TabDump and click the TabDump extension.",
]

export function ExtensionInstallGuide({
  onBack,
  onContinueWithoutExtension,
}: {
  onBack: () => void
  onContinueWithoutExtension: () => void
}) {
  return (
    <div className="w-full max-w-sm text-left">
      <h2 className="text-center text-h1 font-semibold text-foreground">Install TabDump for Chrome</h2>

      <ol className="mt-6 space-y-2.5">
        {STEPS.map((step, i) => (
          <li key={i} className="flex gap-3 text-body text-muted-foreground">
            <span className="shrink-0 font-mono text-body-sm text-tertiary">{i + 1}.</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>

      <a
        href={EXTENSION_DOWNLOAD_URL}
        download
        className={buttonVariants({ size: "lg", className: "mt-6 w-full" })}
      >
        Download Extension
      </a>

      <div className="mt-3 flex items-center justify-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button variant="link" size="sm" onClick={onContinueWithoutExtension}>
          Continue without extension
        </Button>
      </div>
    </div>
  )
}
