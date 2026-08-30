export function SkipButton({ onSkip }: { onSkip: () => void }) {
  return (
    <button
      type="button"
      onClick={onSkip}
      className="absolute right-4 bottom-4 rounded-md px-2 py-1 text-body-sm text-tertiary transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:text-foreground hover:underline focus-visible:text-foreground sm:right-6 sm:bottom-6"
    >
      Skip intro →
    </button>
  )
}
