export type PanelAppearance = {
  theme: "navy";
  mode: "system" | "light" | "dark";
  accent: "sky" | "mint" | "violet" | "amber";
  textSize?: number;
};

const STORAGE_KEY = "tabai-panel-appearance";

export const DEFAULT_APPEARANCE: PanelAppearance = { theme: "navy", mode: "system", accent: "sky", textSize: 14 };

export function panelTextSize(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 12 && value <= 20 ? value : 14;
}

function isAppearance(value: unknown): value is PanelAppearance {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PanelAppearance>;
  return candidate.theme === "navy"
    && (candidate.mode === "system" || candidate.mode === "light" || candidate.mode === "dark")
    && (candidate.accent === "sky" || candidate.accent === "mint" || candidate.accent === "violet" || candidate.accent === "amber");
}

export function readAppearance(): PanelAppearance {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as unknown;
    return isAppearance(stored) ? { ...stored, textSize: panelTextSize(stored.textSize) } : { ...DEFAULT_APPEARANCE };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function applyAppearance(value: PanelAppearance) {
  const root = document.documentElement;
  root.dataset.theme = value.theme;
  root.dataset.mode = value.mode;
  root.dataset.accent = value.accent;
  root.style.colorScheme = value.mode === "system" ? "light dark" : value.mode;
  root.style.setProperty('--text-scale', String(panelTextSize(value.textSize) / 15));
}

export function saveAppearance(value: PanelAppearance) {
  applyAppearance(value);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* private browsing may disable storage */ }
}

export function initAppearance() {
  const appearance = readAppearance();
  applyAppearance(appearance);
  return appearance;
}
