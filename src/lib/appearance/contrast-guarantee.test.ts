import { describe, expect, it } from "vitest";

import { contrastRatio } from "./contrast";
import { THEME_REGISTRY } from "./themes";

/**
 * Every theme a user can pick has to be readable, not just the default.
 *
 * This exists because the readable text tiers used to be a fixed `mix`
 * toward the background, and a fixed step cannot hold across palettes: the
 * amount that reads comfortably on a near-black ground measured about
 * 3.8:1 on a white one and about 4.2:1 on at least one dark one, both under
 * WCAG AA's 4.5:1 for text this size (`accessibility.md` › contrast). The
 * failures were invisible in review because nobody opens all forty themes.
 *
 * `buildThemeColors` now derives those tiers through `fadeButKeepLegible`,
 * which fades as far as asked and then steps back until the result actually
 * passes. This test is the thing that keeps that true: it covers every
 * theme in the registry against every surface readable text is drawn on, so
 * a new preset with an unlucky palette, or a change to the elevation steps,
 * fails here rather than shipping.
 *
 * `textDisabled` is deliberately absent — WCAG exempts inactive controls,
 * and holding it to the same floor would make disabled text indistinguishable
 * from enabled text.
 */

/** WCAG AA for text up to 17pt, which every tier checked here is under. */
const AA_BODY = 4.5;

describe("every shipped theme keeps its readable text tiers above WCAG AA", () => {
  for (const theme of THEME_REGISTRY) {
    it(`${theme.id} (${theme.category})`, () => {
      const c = theme.colors;
      const tiers = [
        ["text", c.text],
        ["textSecondary", c.textSecondary],
        ["textMuted", c.textMuted],
      ] as const;
      // Every ground readable text actually sits on. `surfaceElevated` is
      // the tightest of the three — it is a step further from the page than
      // `surface` — so leaving it out would let menus and dialogs fail.
      const grounds = [
        ["background", c.background],
        ["surface", c.surface],
        ["surfaceElevated", c.surfaceElevated],
      ] as const;

      for (const [tierName, tier] of tiers) {
        for (const [groundName, ground] of grounds) {
          const ratio = contrastRatio(tier, ground);
          expect(ratio, `${theme.id}: ${tierName} (${tier}) on ${groundName} (${ground}) was unreadable`).not.toBeNull();
          expect(
            ratio!,
            `${theme.id}: ${tierName} (${tier}) on ${groundName} (${ground})`
          ).toBeGreaterThanOrEqual(AA_BODY);
        }
      }
    });
  }
});
