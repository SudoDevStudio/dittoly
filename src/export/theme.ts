import { z } from 'zod';

/**
 * Brand themes for exported apps: what an admin enters (name, logo, colours, font), and the
 * light and dark design tokens derived from it. Derived colours are adjusted until text meets
 * WCAG 2.x contrast (4.5:1 for text, 3:1 for borders and focus rings), whatever colour was
 * picked, so a theme cannot make an app unreadable.
 */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #1f6feb');
/** Font stacks only: nothing is loaded from a third party, so visitors are not tracked by a font host. */
export const FONTS = {
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  humanist: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
  geometric: 'Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif',
  serif: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif',
  rounded: 'ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT", Calibri, sans-serif',
  mono: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace',
} as const;

const LOGO = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;
export const brandInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    tagline: z.string().trim().max(140).optional(),
    /** A small image as a data URL (PNG, JPEG, WebP or SVG), at most 200 KB. */
    logo: z.string().max(280_000).regex(LOGO, 'must be a PNG, JPEG, WebP or SVG image').optional(),
    primary: hex,
    accent: hex.optional(),
    font: z.enum(Object.keys(FONTS) as [keyof typeof FONTS, ...(keyof typeof FONTS)[]]).default('system'),
    radius: z.enum(['none', 'small', 'medium', 'large']).default('medium'),
  })
  .strict();
export type BrandInput = z.infer<typeof brandInput>;

export interface Tokens {
  bg: string; surface: string; surface2: string; text: string; muted: string; border: string;
  primary: string; onPrimary: string; link: string; accent: string; onAccent: string;
  danger: string; success: string; focus: string;
}
export interface Theme {
  brand: BrandInput;
  light: Tokens;
  dark: Tokens;
  font: string;
  radius: string;
}

type Rgb = [number, number, number];
const toRgb = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const toHex = ([r, g, b]: Rgb) => '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

function luminance(h: string): number {
  const [r, g, b] = toRgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

function toHsl(h: string): [number, number, number] {
  const [r, g, b] = toRgb(h).map((v) => v / 255) as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue * 60, s, l];
}
function hsl(hue: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/** Move a colour's lightness towards dark or light until it has the contrast needed against `against`. */
function fit(color: string, against: string, ratio: number, direction: 'darker' | 'lighter'): string {
  const [h, s, l0] = toHsl(color);
  let l = l0;
  let c = color;
  for (let i = 0; i < 100 && contrast(c, against) < ratio; i++) {
    l = direction === 'darker' ? Math.max(0, l - 0.01) : Math.min(1, l + 0.01);
    c = hsl(h, s, l);
  }
  return c;
}
/** White or near-black text, whichever reads better on the colour (the colour is darkened or lightened if neither reaches 4.5). */
function onColor(bg: string): { bg: string; fg: string } {
  const white = '#ffffff';
  const ink = '#111418';
  if (contrast(bg, white) >= 4.5) return { bg, fg: white };
  if (contrast(bg, ink) >= 4.5) return { bg, fg: ink };
  return { bg: fit(bg, white, 4.5, 'darker'), fg: white };
}

export function deriveTheme(brand: BrandInput): Theme {
  const [h] = toHsl(brand.primary);
  const accentIn = brand.accent ?? hsl((h + 150) % 360, 0.65, 0.45);
  const light = (() => {
    const bg = hsl(h, 0.2, 0.985);
    const surface = '#ffffff';
    const text = hsl(h, 0.15, 0.12);
    const primary = onColor(brand.primary);
    const accent = onColor(accentIn);
    return {
      bg, surface, surface2: hsl(h, 0.18, 0.955), text,
      muted: fit(hsl(h, 0.1, 0.42), surface, 4.5, 'darker'),
      border: fit(hsl(h, 0.12, 0.86), surface, 1.5, 'darker'),
      primary: primary.bg, onPrimary: primary.fg,
      link: fit(brand.primary, surface, 4.5, 'darker'),
      accent: accent.bg, onAccent: accent.fg,
      danger: fit('#d1242f', surface, 4.5, 'darker'), success: fit('#1a7f37', surface, 4.5, 'darker'),
      focus: fit(brand.primary, surface, 3, 'darker'),
    };
  })();
  const dark = (() => {
    const bg = hsl(h, 0.16, 0.08);
    const surface = hsl(h, 0.14, 0.12);
    const text = hsl(h, 0.15, 0.93);
    const primary = onColor(fit(brand.primary, bg, 3, 'lighter'));
    const accent = onColor(fit(accentIn, bg, 3, 'lighter'));
    return {
      bg, surface, surface2: hsl(h, 0.13, 0.16), text,
      muted: fit(hsl(h, 0.08, 0.62), surface, 4.5, 'lighter'),
      border: fit(hsl(h, 0.1, 0.24), surface, 1.5, 'lighter'),
      primary: primary.bg, onPrimary: primary.fg,
      link: fit(brand.primary, surface, 4.5, 'lighter'),
      accent: accent.bg, onAccent: accent.fg,
      danger: fit('#ff7b72', surface, 4.5, 'lighter'), success: fit('#3fb950', surface, 4.5, 'lighter'),
      focus: fit(brand.primary, surface, 3, 'lighter'),
    };
  })();
  const radius = { none: '0', small: '4px', medium: '8px', large: '14px' }[brand.radius];
  return { brand, light, dark, font: FONTS[brand.font], radius };
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** The theme as CSS custom properties: light by default, dark when the visitor's system asks for it. */
export function themeCss(t: Theme): string {
  const vars = (tokens: Tokens) => Object.entries(tokens).map(([k, v]) => `  --${kebab(k)}: ${v};`).join('\n');
  return [
    `:root {\n${vars(t.light)}\n  --font: ${t.font};\n  --radius: ${t.radius};\n  color-scheme: light dark;\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${vars(t.dark).replace(/^/gm, '  ')}\n  }\n}`,
    `:root[data-theme="dark"] {\n${vars(t.dark)}\n}`,
  ].join('\n');
}

/** The default theme when an export has none. */
export const DEFAULT_BRAND: BrandInput = { name: 'My app', primary: '#2f6fdf', font: 'system', radius: 'medium' };
