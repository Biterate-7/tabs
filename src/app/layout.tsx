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
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const ibmPlexSans = IBM_Plex_Sans({ variable: "--font-ibm-plex-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const ibmPlexMono = IBM_Plex_Mono({ variable: "--font-ibm-plex-mono", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"] });
const robotoMono = Roboto_Mono({ variable: "--font-roboto-mono", subsets: ["latin"] });
const roboto = Roboto({ variable: "--font-roboto", subsets: ["latin"], weight: ["400", "500", "700"] });
const spaceMono = Space_Mono({ variable: "--font-space-mono", subsets: ["latin"], weight: ["400", "700"] });
const sourceCodePro = Source_Code_Pro({ variable: "--font-source-code-pro", subsets: ["latin"] });
const firaCode = Fira_Code({ variable: "--font-fira-code", subsets: ["latin"] });
const firaSans = Fira_Sans({ variable: "--font-fira-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const cascadiaCode = Cascadia_Code({ variable: "--font-cascadia-code", subsets: ["latin"] });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });
const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"] });
const nunito = Nunito({ variable: "--font-nunito", subsets: ["latin"] });
const plusJakartaSans = Plus_Jakarta_Sans({ variable: "--font-plus-jakarta-sans", subsets: ["latin"] });
const montserrat = Montserrat({ variable: "--font-montserrat", subsets: ["latin"] });
const poppins = Poppins({ variable: "--font-poppins", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const lora = Lora({ variable: "--font-lora", subsets: ["latin"] });
const merriweather = Merriweather({ variable: "--font-merriweather", subsets: ["latin"], weight: ["400", "700"] });

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
