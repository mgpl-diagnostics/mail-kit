import type { Brand, Theme } from "./types";

/**
 * The MGPL mail theme: "Saffron & Neel", the website's palette (navy headings and header,
 * saffron actions). Contrast of text on its background is at least 4.5:1 for every pair used.
 */
export const DEFAULT_THEME: Theme = {
  colors: {
    brand: "#14264A",
    brandText: "#FFFFFF",
    accent: "#C2410C",
    accentText: "#FFFFFF",
    ink: "#1D1B18",
    muted: "#5F584E",
    line: "#E6DED0",
    canvas: "#FAF6EF",
    surface: "#FFFFFF",
    subtle: "#F6F2EA",
    info: "#22396B",
    infoBg: "#ECEFF6",
    success: "#1E7A4F",
    successBg: "#E8F4EC",
    warning: "#8A4B06",
    warningBg: "#FDF3E1",
    danger: "#B42318",
    dangerBg: "#FDECEA",
  },
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  monoFont: "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 15,
  radius: 8,
  width: 600,
};

/** Default sender identity. The api passes the lab's own details (report-kit's MGPL_LAB). */
export const DEFAULT_BRAND: Brand = {
  name: "Maa Gayatri Path Lab",
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** A theme with some tokens replaced: `createTheme({ colors: { accent: "#0B7285" } })`. */
export function createTheme(overrides: DeepPartial<Theme> = {}, base: Theme = DEFAULT_THEME): Theme {
  return { ...base, ...overrides, colors: { ...base.colors, ...overrides.colors } } as Theme;
}
