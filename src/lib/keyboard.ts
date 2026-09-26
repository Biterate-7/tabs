/**
 * The label for the platform's command modifier: ⌘ on Apple platforms,
 * Ctrl everywhere else. The shortcuts themselves already accept either key
 * (they test `metaKey || ctrlKey`); this only decides what a hint says, so a
 * wrong guess costs a label, never a shortcut.
 *
 * Returns "Ctrl" on the server and before hydration, so markup rendered
 * there is stable.
 */
export function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl"
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    ""
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl"
}
