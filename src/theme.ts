import { z } from "zod";

/** The page's color schemes; each instance shows one, so several open tabs are easy to tell apart. */
export const THEMES = ["indigo", "violet", "teal", "mono"] as const;
export const ThemeSchema = z.enum(THEMES);
export type ThemeName = z.infer<typeof ThemeSchema>;

/** FNV-1a, 32-bit: a stable number per instance name, the same on every Mac and every run. */
export function nameHash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The theme a new instance starts with: one the other instances on this Mac use least, so up to
 * four start with four different themes; among equals, the name's hash decides. The daemon saves
 * the result, so it never shifts when another instance is added later.
 */
export function pickTheme(name: string, taken: readonly ThemeName[]): ThemeName {
  const uses = (t: ThemeName) => taken.filter((x) => x === t).length;
  const least = Math.min(...THEMES.map(uses));
  const candidates = THEMES.filter((t) => uses(t) === least);
  return candidates[nameHash(name) % candidates.length] as ThemeName;
}
