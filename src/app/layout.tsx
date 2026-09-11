import type { Metadata } from "next";
import {
  Geist,
  Geist_Mono,
  Inter,
  IBM_Plex_Sans,
  IBM_Plex_Mono,
  JetBrains_Mono,
  Roboto_Mono,
  Roboto,
  Space_Mono,
  Source_Code_Pro,
  Fira_Code,
  Fira_Sans,
  Cascadia_Code,
  Manrope,
  DM_Sans,
  Nunito,
  Plus_Jakarta_Sans,
  Montserrat,
  Poppins,
  Lora,
  Merriweather,
} from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { AppearanceProvider } from "@/components/appearance-provider";
import { THEME_REGISTRY } from "@/lib/appearance/themes";
import { siteOrigin } from "@/lib/site-url";
import "./globals.css";

/*
 * Only Geist and Geist Mono preload. Everything below them carries
 * `preload: false`.
 *
 * next/font preloads every family a layout instantiates, and this layout
 * instantiates all 21 so Settings → Appearance → Typography can offer them —
 * which meant every route shipped 31 <link rel=preload> font files, 792KB, to
 * render two families. That was invisible while `/` was the only route and
 * the app was behind a hydration gate; it stopped being invisible when the
 * statically-served public landing page started paying it on first paint.
 *
 * `preload: false` keeps the @font-face rule and the CSS variable, so a font
 * a user picks in Settings still resolves and still self-hosts — the browser
 * just fetches it when a rule actually applies it instead of on every load.
 * The two below stay eager because they are the defaults (see
 * --tabdump-font-ui/-mono in globals.css) and the marketing page pins them.
 */
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], preload: false });
const ibmPlexSans = IBM_Plex_Sans({ variable: "--font-ibm-plex-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"], preload: false });
const ibmPlexMono = IBM_Plex_Mono({ variable: "--font-ibm-plex-mono", subsets: ["latin"], weight: ["400", "500", "600", "700"], preload: false });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], preload: false });
const robotoMono = Roboto_Mono({ variable: "--font-roboto-mono", subsets: ["latin"], preload: false });
const roboto = Roboto({ variable: "--font-roboto", subsets: ["latin"], weight: ["400", "500", "700"], preload: false });
const spaceMono = Space_Mono({ variable: "--font-space-mono", subsets: ["latin"], weight: ["400", "700"], preload: false });
const sourceCodePro = Source_Code_Pro({ variable: "--font-source-code-pro", subsets: ["latin"], preload: false });
const firaCode = Fira_Code({ variable: "--font-fira-code", subsets: ["latin"], preload: false });
const firaSans = Fira_Sans({ variable: "--font-fira-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"], preload: false });
const cascadiaCode = Cascadia_Code({ variable: "--font-cascadia-code", subsets: ["latin"], preload: false });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"], preload: false });
const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"], preload: false });
const nunito = Nunito({ variable: "--font-nunito", subsets: ["latin"], preload: false });
const plusJakartaSans = Plus_Jakarta_Sans({ variable: "--font-plus-jakarta-sans", subsets: ["latin"], preload: false });
const montserrat = Montserrat({ variable: "--font-montserrat", subsets: ["latin"], preload: false });
const poppins = Poppins({ variable: "--font-poppins", subsets: ["latin"], weight: ["400", "500", "600", "700"], preload: false });
const lora = Lora({ variable: "--font-lora", subsets: ["latin"], preload: false });
const merriweather = Merriweather({ variable: "--font-merriweather", subsets: ["latin"], weight: ["400", "700"], preload: false });

const FONT_VARIABLES = [
  geistSans.variable,
  geistMono.variable,
  inter.variable,
  ibmPlexSans.variable,
  ibmPlexMono.variable,
  jetbrainsMono.variable,
  robotoMono.variable,
  roboto.variable,
  spaceMono.variable,
  sourceCodePro.variable,
  firaCode.variable,
  firaSans.variable,
  cascadiaCode.variable,
  manrope.variable,
  dmSans.variable,
  nunito.variable,
  plusJakartaSans.variable,
  montserrat.variable,
  poppins.variable,
  lora.variable,
  merriweather.variable,
].join(" ");

export const metadata: Metadata = {
  // Absolute URLs for every page's canonical/Open Graph entries are resolved
  // against this, so a route only has to declare its path. See lib/site-url.ts
  // for how the origin is chosen (and why it matches the extension build's).
  metadataBase: new URL(siteOrigin()),
  title: "TabDump",
  description: "Paste your browser tabs. Turn the chaos into an organized workspace.",
};

// A minimal, best-effort core-palette lookup so the pre-hydration inline
// script below can avoid a flash of the wrong theme without hand-duplicating
// the full theme registry — see resolveThemeColors/appearanceToCssVars in
// src/lib/appearance/resolve.ts for the complete (JS-applied) version.
const THEME_CORE_LOOKUP = Object.fromEntries(
  THEME_REGISTRY.map((t) => [
    t.id,
    { background: t.colors.background, foreground: t.colors.text, card: t.colors.surface, primary: t.colors.accent, ring: t.colors.focus },
  ])
);

const NO_FLASH_SCRIPT = `(function(){try{var raw=localStorage.getItem("tabdump:settings:v1");if(!raw)return;var s=JSON.parse(raw);var lookup=${JSON.stringify(THEME_CORE_LOOKUP)};var t=lookup[s.themeId];var c=s.customTheme;var bg=c?c.background:(t&&t.background);var fg=c?c.text:(t&&t.foreground);var card=c?c.surface:(t&&t.card);var accent=(s.accentOverride)||(c?c.accent:(t&&t.primary));var ring=(s.accentOverride)||(c?c.focus:(t&&t.ring));var root=document.documentElement.style;if(bg)root.setProperty("--background",bg);if(fg){root.setProperty("--foreground",fg);root.setProperty("--card-foreground",fg);root.setProperty("--popover-foreground",fg);}if(card){root.setProperty("--card",card);root.setProperty("--popover",card);root.setProperty("--surface",card);}if(accent){root.setProperty("--primary",accent);root.setProperty("--sidebar-primary",accent);}if(ring){root.setProperty("--ring",ring);root.setProperty("--focus",ring);}if(s.motion&&s.motion.level)document.documentElement.dataset.motion=s.motion.level;if(s.themeId)document.documentElement.dataset.theme=s.themeId;}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${FONT_VARIABLES} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <AppearanceProvider>{children}</AppearanceProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
