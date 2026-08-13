export function HeroBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div
        className="absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--input) 1px, transparent 1px), linear-gradient(to bottom, var(--input) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />
    </div>
  )
}
