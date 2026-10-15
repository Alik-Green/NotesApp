/**
 * User settings: theme, page defaults, tool presets, palm rejection, gesture toggles.
 * Persisted to IndexedDB (settings table) and mirrored in a zustand store for the UI.
 */

import { create } from 'zustand';
import { allSettings, setSetting } from '@/data/repository';
import { TOOL_DEFAULTS, type StrokeStyle } from '@/core/stroke';
import type { StrokeTool } from '@/core/model';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ViewMode = 'vertical' | 'single';
export type PenOnlyMode = 'auto' | 'always' | 'off';

export interface SettingsState {
  theme: ThemeMode;
  paperColor: string;
  darkPaperColor: string;
  viewMode: ViewMode;
  defaultTemplate: 'blank' | 'lined' | 'grid' | 'dotted' | 'cornell';
  penOnly: PenOnlyMode;
  twoFingerUndo: boolean;
  shapeRecognition: boolean;
  snapDelayMs: number;
  showRuler: boolean;
  toolbarEdge: 'top' | 'bottom' | 'left' | 'right';
  toolbarCollapsed: boolean;
  autoSaveMs: number;
  zoomLevel: number;
  hydrated: boolean;
  /** Last used settings per ink tool, remembered across sessions. */
  toolStyles: Record<StrokeTool, StrokeStyle>;
  eraserSize: number;
  laserFadeMs: number;
  pressureEnabled: boolean;
  shortcutsSeen: boolean;
}

export interface SettingsActions {
  hydrate(): Promise<void>;
  set<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void;
  setToolStyle(tool: StrokeTool, patch: Partial<StrokeStyle>): void;
  resetToolStyles(): void;
}

export const DEFAULT_SETTINGS: Omit<SettingsState, 'hydrated' | 'hydrate' | 'set' | 'setToolStyle' | 'resetToolStyles'> = {
  theme: 'system',
  paperColor: '#ffffff',
  darkPaperColor: '#1b2030',
  viewMode: 'vertical',
  defaultTemplate: 'blank',
  penOnly: 'auto',
  twoFingerUndo: true,
  shapeRecognition: true,
  snapDelayMs: 450,
  showRuler: false,
  toolbarEdge: 'top',
  toolbarCollapsed: false,
  autoSaveMs: 2500,
  zoomLevel: 1,
  toolStyles: {
    pen: { ...TOOL_DEFAULTS.pen },
    highlighter: { ...TOOL_DEFAULTS.highlighter },
    pencil: { ...TOOL_DEFAULTS.pencil },
  },
  eraserSize: 14,
  laserFadeMs: 900,
  pressureEnabled: true,
  shortcutsSeen: false,
};

const PERSISTED_KEYS: Array<keyof SettingsState> = [
  'theme',
  'paperColor',
  'darkPaperColor',
  'viewMode',
  'defaultTemplate',
  'penOnly',
  'twoFingerUndo',
  'shapeRecognition',
  'snapDelayMs',
  'toolbarEdge',
  'toolbarCollapsed',
  'autoSaveMs',
  'toolStyles',
  'eraserSize',
  'laserFadeMs',
  'pressureEnabled',
  'shortcutsSeen',
];

export const useSettings = create<SettingsState & SettingsActions>((set, get) => ({
  ...DEFAULT_SETTINGS,
  hydrated: false,

  async hydrate() {
    const stored = await allSettings();
    const patch: Partial<SettingsState> = {};
    for (const key of PERSISTED_KEYS) {
      if (stored[key] !== undefined) {
        // Restored values were written by this same app version, so the shape is trusted.
        (patch as Record<string, unknown>)[key] = stored[key];
      }
    }
    if (stored.toolStyles === undefined) {
      const pen = stored['toolStyle.pen'] as StrokeStyle | undefined;
      if (pen) patch.toolStyles = { ...DEFAULT_SETTINGS.toolStyles, pen };
    }
    set({ ...patch, hydrated: true });
  },

  set(key, value) {
    set({ [key]: value } as unknown as Partial<SettingsState>);
    if (PERSISTED_KEYS.includes(key)) void setSetting(key, value);
  },

  setToolStyle(tool, patch) {
    const current = get().toolStyles;
    const next = { ...current, [tool]: { ...current[tool], ...patch, tool } };
    set({ toolStyles: next });
    void setSetting('toolStyles', next);
  },

  resetToolStyles() {
    const next = {
      pen: { ...TOOL_DEFAULTS.pen },
      highlighter: { ...TOOL_DEFAULTS.highlighter },
      pencil: { ...TOOL_DEFAULTS.pencil },
    };
    set({ toolStyles: next });
    void setSetting('toolStyles', next);
  },
}));

/** Resolve the effective theme, honouring `system`. */
export function resolveDark(theme: ThemeMode): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
