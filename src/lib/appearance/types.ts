/**
 * The full semantic color set a theme (preset or custom) provides. Every
 * field is a plain color string (#RGB / #RRGGBB / #RRGGBBAA) so it can be
 * fed straight into a native `<input type="color">`, hashed for export, and
 * contrast-checked without any color-space conversion.
 *
 * Components never read this type directly — `resolveThemeColors` +
 * `appearanceToCssVars` (see resolve.ts) turn it into CSS custom properties
 * that both TabDump's existing Tailwind tokens (--background, --primary, …)
 * and the new tokens this system introduces (--surface-selected,
 * --graph-edge, --editor-background, …) read from.
 */
export type ThemeColors = {
  background: string;
  backgroundSecondary: string;
  backgroundTertiary: string;

  surface: string;
  surfaceHover: string;
  surfaceActive: string;
  surfaceSelected: string;

  text: string;
  textSecondary: string;
  textMuted: string;
  textDisabled: string;

  accent: string;
  accentHover: string;
  accentActive: string;
  accentSubtle: string;

  border: string;
  borderSubtle: string;
  borderStrong: string;

  success: string;
  successSubtle: string;
  warning: string;
  warningSubtle: string;
  error: string;
  errorSubtle: string;
  info: string;
  infoSubtle: string;

  selection: string;
  focus: string;

  graphNode: string;
  graphNodeSelected: string;
  graphEdge: string;

  editorBackground: string;
  editorText: string;
  editorPlaceholder: string;
};

export type ThemeCategory = "dark" | "light" | "colorful" | "aesthetic" | "developer";

export type ThemeDefinition = {
  id: string;
  name: string;
  description?: string;
  category: ThemeCategory;
  isDark: boolean;
  colors: ThemeColors;
};

export type FontKind = "sans" | "mono" | "serif";

export type FontOption = {
  id: string;
  label: string;
  /** The next/font CSS variable this option resolves to, e.g. "--font-inter". */
  cssVar: string;
  kind: FontKind;
};

export type ContentWidth = "compact" | "default" | "wide" | "full";
export type Density = "compact" | "comfortable" | "spacious";
export type SidebarDensity = "compact" | "default" | "large";
export type CardDensity = "compact" | "default" | "spacious";
export type RadiusPreset = "sharp" | "small" | "medium" | "rounded" | "very-rounded";
export type Intensity = "none" | "subtle" | "normal" | "strong";
export type MotionLevel = "off" | "reduced" | "normal" | "expressive";
export type TransitionSpeed = "fast" | "normal" | "slow";
export type BackgroundType = "solid" | "gradient" | "image";
export type BackgroundSize = "cover" | "contain" | "tile";
export type BackgroundPosition = "center" | "top" | "bottom" | "left" | "right";

export type TypographySettings = {
  uiFont: string;
  contentFont: string;
  monoFont: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
};

export type BackgroundSettings = {
  type: BackgroundType;
  color: string;
  gradientFrom: string;
  gradientTo: string;
  gradientAngle: number;
  imageUrl: string;
  size: BackgroundSize;
  position: BackgroundPosition;
  opacity: number;
  blur: number;
  brightness: number;
  contrast: number;
  saturation: number;
  overlayColor: string;
  overlayOpacity: number;
};

export type LayoutSettings = {
  contentWidth: ContentWidth;
  density: Density;
  sidebarDensity: SidebarDensity;
  cardDensity: CardDensity;
};

export type ShapeSettings = {
  radius: RadiusPreset;
  borderIntensity: Intensity;
  shadowIntensity: Intensity;
};

export type MotionSettings = {
  level: MotionLevel;
  transitionSpeed: TransitionSpeed;
};

export type AppearanceSettings = {
  themeId: string;
  customTheme: ThemeColors | null;
  favoriteThemeIds: string[];
  randomThemeEnabled: boolean;
  typography: TypographySettings;
  background: BackgroundSettings;
  layout: LayoutSettings;
  shape: ShapeSettings;
  motion: MotionSettings;
  accentOverride: string | null;
};

export type AppearanceSection = "theme" | "typography" | "background" | "layout" | "shape" | "motion" | "accent";
