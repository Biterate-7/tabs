import { SYSTEM_UI_FONT_ID } from "./fonts";
import { DEFAULT_THEME_ID } from "./themes";
import type { AppearanceSettings, BackgroundSettings, LayoutSettings, MotionSettings, ShapeSettings, TypographySettings } from "./types";

export const DEFAULT_TYPOGRAPHY: TypographySettings = {
  uiFont: "geist",
  contentFont: "geist",
  monoFont: "geist-mono",
  fontSize: 15,
  fontWeight: 400,
  lineHeight: 1.5,
  letterSpacing: 0,
};

export const DEFAULT_BACKGROUND: BackgroundSettings = {
  type: "solid",
  color: "",
  gradientFrom: "",
  gradientTo: "",
  gradientAngle: 135,
  imageUrl: "",
  size: "cover",
  position: "center",
  opacity: 100,
  blur: 0,
  brightness: 100,
  contrast: 100,
  saturation: 100,
  overlayColor: "",
  overlayOpacity: 55,
};

export const DEFAULT_LAYOUT: LayoutSettings = {
  contentWidth: "default",
  density: "comfortable",
  sidebarDensity: "default",
  cardDensity: "default",
};

export const DEFAULT_SHAPE: ShapeSettings = {
  radius: "medium",
  borderIntensity: "normal",
  shadowIntensity: "normal",
};

export const DEFAULT_MOTION: MotionSettings = {
  level: "normal",
  transitionSpeed: "normal",
};

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  themeId: DEFAULT_THEME_ID,
  customTheme: null,
  favoriteThemeIds: [],
  randomThemeEnabled: false,
  typography: DEFAULT_TYPOGRAPHY,
  background: DEFAULT_BACKGROUND,
  layout: DEFAULT_LAYOUT,
  shape: DEFAULT_SHAPE,
  motion: DEFAULT_MOTION,
  accentOverride: null,
};

export { SYSTEM_UI_FONT_ID };
