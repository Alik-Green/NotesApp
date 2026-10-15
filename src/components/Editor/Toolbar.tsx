/**
 * Top toolbar: tools, colour, thickness, undo/redo, zoom, page menu and view options.
 * Collapsible, and dockable to any edge for tablet use. Every control has an ARIA label and a
 * 44px touch target.
 */

import { useState, type ReactNode } from 'react';
import { IconButton, Popover } from '@/components/ui/primitives';
import { TEMPLATE_LABELS } from '@/core/templates';
import type { TemplateKind, ToolKind } from '@/core/model';
import { useEditor } from '@/state/editorStore';
import { useSettings } from '@/state/settings';
import type { ViewportApi } from './PageViewport';

export interface ToolbarProps {
  title: string;
  onTitleChange(title: string): void;
  onClose(): void;
  onExportPdf(): void;
  onExportPng(): void;
  onExportInkpad(): void;
  onImportPdf(): void;
  onImportImage(): void;
  onShowShortcuts(): void;
  onShowSearch(): void;
  onShowOutline(): void;
  viewportApi: ViewportApi | null;
  toggleSidebar(): void;
  sidebarOpen: boolean;
}

interface ToolDef {
  tool: ToolKind;
  label: string;
  shortcut: string;
  icon: ReactNode;
}

const ICON = (path: ReactNode) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

const TOOLS: ToolDef[] = [
  {
    tool: 'pen',
    label: 'Pen',
    shortcut: 'P',
    icon: ICON(<path d="M4 19c3-1 5-4 6.5-7.5S14 5 16 5s2 2.5 0 5-6 5-9 6z" />),
  },
  {
    tool: 'highlighter',
    label: 'Highlighter',
    shortcut: 'H',
    icon: ICON(
      <>
        <path d="M5 20h6" />
        <path d="M9 16l-3-3 8-8 4 4-8 8z" />
      </>,
    ),
  },
  {
    tool: 'pencil',
    label: 'Pencil',
    shortcut: 'N',
    icon: ICON(
      <>
        <path d="M4 20l4-1 10-10-3-3L5 16z" />
        <path d="M15 5l4 4" />
      </>,
    ),
  },
  {
    tool: 'eraser',
    label: 'Stroke eraser',
    shortcut: 'E',
    icon: ICON(
      <>
        <path d="M4 16l6-6 8 8-3 3H7z" />
        <path d="M14 6l4 4" />
      </>,
    ),
  },
  {
    tool: 'eraser-pixel',
    label: 'Pixel eraser',
    shortcut: 'Shift+E',
    icon: ICON(
      <>
        <path d="M6 18l6-6" />
        <path d="M13 4l7 7-7 7-7-7z" />
      </>,
    ),
  },
  {
    tool: 'lasso',
    label: 'Lasso select',
    shortcut: 'L',
    icon: ICON(
      <path d="M12 4c4.4 0 8 2.2 8 5s-3.6 5-8 5-8-2.2-8-5 3.6-5 8-5zm0 10c0 3 .8 4 2.5 4.6" />,
    ),
  },
  {
    tool: 'text',
    label: 'Text box',
    shortcut: 'T',
    icon: ICON(
      <>
        <path d="M5 6h14" />
        <path d="M12 6v12" />
      </>,
    ),
  },
  {
    tool: 'shape',
    label: 'Shape',
    shortcut: 'S',
    icon: ICON(<rect x="4" y="6" width="16" height="12" rx="2" />),
  },
  {
    tool: 'image',
    label: 'Image',
    shortcut: 'I',
    icon: ICON(
      <>
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <path d="M8 13l3 3 5-5 3 3" />
      </>,
    ),
  },
  {
    tool: 'laser',
    label: 'Laser pointer',
    shortcut: 'R',
    icon: ICON(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3m0 12v3M3 12h3m12 0h3" />
      </>,
    ),
  },
  {
    tool: 'pan',
    label: 'Pan',
    shortcut: 'Space',
    icon: ICON(
      <path d="M9 11V6a2 2 0 114 0v5m0 0V5a2 2 0 114 0v6m0 0V8a2 2 0 114 0v8a6 6 0 01-6 6h-1a6 6 0 01-6-6v-3a2 2 0 114 0" />,
    ),
  },
];

const COLORS = [
  '#111827',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#0ea5e9',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#f8fafc',
];

const SHAPES = ['rect', 'ellipse', 'line', 'arrow', 'triangle'] as const;

export function Toolbar(props: ToolbarProps) {
  const {
    title,
    onTitleChange,
    onClose,
    onExportPdf,
    onExportPng,
    onExportInkpad,
    onImportPdf,
    onImportImage,
    onShowShortcuts,
    onShowSearch,
    onShowOutline,
    viewportApi,
    toggleSidebar,
    sidebarOpen,
  } = props;

  const tool = useEditor((state) => state.tool);
  const setTool = useEditor((state) => state.setTool);
  const canUndo = useEditor((state) => state.canUndo);
  const canRedo = useEditor((state) => state.canRedo);
  const undo = useEditor((state) => state.undo);
  const redo = useEditor((state) => state.redo);
  const zoom = useEditor((state) => state.zoom);
  const viewMode = useEditor((state) => state.viewMode);
  const setViewMode = useEditor((state) => state.setViewMode);
  const pageIndex = useEditor((state) => state.currentPageIndex);
  const pageCount = useEditor((state) => state.doc?.pages.length ?? 0);
  const shapeKind = useEditor((state) => state.shapeKind);
  const setShapeKind = useEditor((state) => state.setShapeKind);
  const undoLabel = useEditor((state) => state.undoLabel);
  const redoLabel = useEditor((state) => state.redoLabel);
  const lastSavedAt = useEditor((state) => state.lastSavedAt);
  const saving = useEditor((state) => state.saving);

  const settings = useSettings();
  const [menuOpen, setMenuOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);

  const inkTool = tool === 'pen' || tool === 'highlighter' || tool === 'pencil' ? tool : 'pen';
  const style = settings.toolStyles[inkTool];

  const edgeClass =
    settings.toolbarEdge === 'bottom'
      ? 'order-last border-t'
      : settings.toolbarEdge === 'left'
        ? 'flex-col border-r'
        : settings.toolbarEdge === 'right'
          ? 'order-last flex-col border-l'
          : 'border-b';

  return (
    <header
      className={`z-30 flex flex-wrap items-center gap-1 bg-white/95 px-2 py-1.5 backdrop-blur dark:bg-ink-900/95 ${edgeClass} border-ink-200 dark:border-ink-800`}
      role="toolbar"
      aria-label="Notebook tools"
      data-testid="toolbar"
    >
      <IconButton label="Back to library" onClick={onClose} data-testid="toolbar-back">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </IconButton>

      {editingTitle ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const next = draftTitle.trim();
            if (next) onTitleChange(next);
            setEditingTitle(false);
          }}
        >
          <input
            autoFocus
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={() => setEditingTitle(false)}
            aria-label="Notebook title"
            className="h-11 w-48 rounded-lg border border-accent bg-white px-2 text-sm dark:bg-ink-800"
          />
        </form>
      ) : (
        <button
          type="button"
          className="max-w-56 truncate rounded-lg px-2 py-2 text-sm font-semibold hover:bg-ink-100 dark:hover:bg-ink-800"
          onClick={() => {
            setDraftTitle(title);
            setEditingTitle(true);
          }}
          aria-label={`Rename notebook, currently ${title}`}
          data-testid="toolbar-title"
        >
          {title}
        </button>
      )}

      <div className="mx-1 hidden h-8 w-px bg-ink-200 sm:block dark:bg-ink-700" />

      {TOOLS.map((definition) => (
        <IconButton
          key={definition.tool}
          label={`${definition.label} (${definition.shortcut})`}
          active={tool === definition.tool}
          onClick={() => setTool(definition.tool)}
          data-testid={`tool-${definition.tool}`}
        >
          {definition.icon}
        </IconButton>
      ))}

      <div className="relative">
        <IconButton
          label="Colour and thickness"
          onClick={() => setColorOpen((open) => !open)}
          aria-expanded={colorOpen}
          data-testid="tool-style"
        >
          <span
            className="h-5 w-5 rounded-full ring-1 ring-ink-300 dark:ring-ink-600"
            style={{ background: style.color }}
            aria-hidden="true"
          />
        </IconButton>
        <Popover
          open={colorOpen}
          onClose={() => setColorOpen(false)}
          align="left"
          label="Colour and thickness"
        >
          <div className="grid grid-cols-6 gap-1 p-1">
            {COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Colour ${color}`}
                className={`h-8 w-8 rounded-full ring-2 ${style.color === color ? 'ring-accent' : 'ring-transparent'}`}
                style={{ background: color }}
                onClick={() => settings.setToolStyle(inkTool, { color })}
              />
            ))}
          </div>
          <label className="mt-2 block px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Thickness {style.size.toFixed(1)}
            <input
              type="range"
              min={0.5}
              max={40}
              step={0.5}
              value={style.size}
              aria-label="Thickness"
              onChange={(event) =>
                settings.setToolStyle(inkTool, {
                  size: Number(event.target.value),
                })
              }
              className="mt-1 w-full"
            />
          </label>
          <label className="mt-1 block px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Opacity {Math.round(style.opacity * 100)}%
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={style.opacity}
              aria-label="Opacity"
              onChange={(event) =>
                settings.setToolStyle(inkTool, {
                  opacity: Number(event.target.value),
                })
              }
              className="mt-1 w-full"
            />
          </label>
          <label className="mt-1 block px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Custom colour
            <input
              type="color"
              value={style.color.startsWith('#') ? style.color : '#111827'}
              aria-label="Custom colour"
              onChange={(event) => settings.setToolStyle(inkTool, { color: event.target.value })}
              className="mt-1 h-9 w-full cursor-pointer rounded"
            />
          </label>
          {tool === 'shape' ? (
            <div className="mt-2 flex gap-1 px-1">
              {SHAPES.map((shape) => (
                <button
                  key={shape}
                  type="button"
                  aria-label={`Shape ${shape}`}
                  aria-pressed={shapeKind === shape}
                  className={`rounded px-2 py-1 text-xs ${shapeKind === shape ? 'bg-accent/15 text-accent' : 'hover:bg-ink-100 dark:hover:bg-ink-800'}`}
                  onClick={() => setShapeKind(shape)}
                >
                  {shape}
                </button>
              ))}
            </div>
          ) : null}
          <label className="mt-2 block px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Eraser size {settings.eraserSize}
            <input
              type="range"
              min={2}
              max={64}
              value={settings.eraserSize}
              aria-label="Eraser size"
              onChange={(event) => settings.set('eraserSize', Number(event.target.value))}
              className="mt-1 w-full"
            />
          </label>
        </Popover>
      </div>

      <IconButton
        label={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
        disabled={!canUndo}
        onClick={undo}
        data-testid="undo"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M9 7L5 11l4 4" />
          <path d="M5 11h9a5 5 0 010 10h-2" />
        </svg>
      </IconButton>
      <IconButton
        label={redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}
        disabled={!canRedo}
        onClick={redo}
        data-testid="redo"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M15 7l4 4-4 4" />
          <path d="M19 11h-9a5 5 0 000 10h2" />
        </svg>
      </IconButton>

      <div className="mx-1 hidden h-8 w-px bg-ink-200 sm:block dark:bg-ink-700" />

      <IconButton
        label="Zoom out"
        onClick={() => useEditor.getState().zoomBy(1 / 1.25)}
        data-testid="zoom-out"
      >
        <span aria-hidden="true">−</span>
      </IconButton>
      <span className="w-12 text-center text-xs tabular-nums" data-testid="zoom-label">
        {Math.round(zoom * 100)}%
      </span>
      <IconButton
        label="Zoom in"
        onClick={() => useEditor.getState().zoomBy(1.25)}
        data-testid="zoom-in"
      >
        <span aria-hidden="true">＋</span>
      </IconButton>

      <div className="relative">
        <IconButton
          label="View options"
          onClick={() => setViewOpen((open) => !open)}
          aria-expanded={viewOpen}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </IconButton>
        <Popover open={viewOpen} onClose={() => setViewOpen(false)} label="View options">
          <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Layout
          </div>
          <div className="flex gap-1 px-2">
            {(['vertical', 'single'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={viewMode === mode}
                onClick={() => setViewMode(mode)}
                className={`h-11 flex-1 rounded-lg text-sm ${viewMode === mode ? 'bg-accent/15 text-accent' : 'hover:bg-ink-100 dark:hover:bg-ink-800'}`}
              >
                {mode === 'vertical' ? 'Continuous' : 'Single page'}
              </button>
            ))}
          </div>
          <div className="mt-3 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Fit
          </div>
          <div className="flex gap-1 px-2">
            <button
              type="button"
              className="h-11 flex-1 rounded-lg text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
              onClick={() => viewportApi?.fitWidth()}
            >
              Fit width
            </button>
            <button
              type="button"
              className="h-11 flex-1 rounded-lg text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
              onClick={() => viewportApi?.zoomToFit()}
            >
              Fit page
            </button>
          </div>
          <div className="mt-3 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Page template
          </div>
          <div className="grid grid-cols-2 gap-1 px-2 pb-1">
            {(Object.keys(TEMPLATE_LABELS) as TemplateKind[]).map((template) => (
              <button
                key={template}
                type="button"
                className="h-11 rounded-lg text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
                onClick={() => {
                  const pageId = useEditor.getState().doc?.pages[pageIndex]?.id;
                  if (pageId) useEditor.getState().setPageTemplate(pageId, template);
                }}
              >
                {TEMPLATE_LABELS[template]}
              </button>
            ))}
          </div>
          <div className="mt-3 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Theme &amp; paper
          </div>
          <div className="flex gap-1 px-2">
            {(['light', 'dark', 'system'] as const).map((theme) => (
              <button
                key={theme}
                type="button"
                aria-pressed={settings.theme === theme}
                className={`h-11 flex-1 rounded-lg text-sm ${settings.theme === theme ? 'bg-accent/15 text-accent' : 'hover:bg-ink-100 dark:hover:bg-ink-800'}`}
                onClick={() => settings.set('theme', theme)}
              >
                {theme}
              </button>
            ))}
          </div>
          <label className="mt-2 block px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Paper colour
            <input
              type="color"
              value={settings.paperColor}
              aria-label="Paper colour"
              onChange={(event) => {
                settings.set('paperColor', event.target.value);
                useEditor.getState().setPaperColor(event.target.value);
              }}
              className="mt-1 h-9 w-full cursor-pointer rounded"
            />
          </label>
          <div className="mt-2 px-3 pb-2 text-xs text-ink-500">
            <label className="flex h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={settings.toolbarCollapsed}
                onChange={(event) => settings.set('toolbarCollapsed', event.target.checked)}
              />
              Collapse toolbar
            </label>
            <label className="flex h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={settings.penOnly === 'always'}
                onChange={(event) =>
                  settings.set('penOnly', event.target.checked ? 'always' : 'auto')
                }
              />
              Palm rejection: stylus only
            </label>
            <label className="flex h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={settings.twoFingerUndo}
                onChange={(event) => settings.set('twoFingerUndo', event.target.checked)}
              />
              Two-finger tap undo
            </label>
            <label className="flex h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={settings.shapeRecognition}
                onChange={(event) => settings.set('shapeRecognition', event.target.checked)}
              />
              Snap shapes when holding
            </label>
            <label className="flex h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={settings.pressureEnabled}
                onChange={(event) => settings.set('pressureEnabled', event.target.checked)}
              />
              Pressure sensitivity
            </label>
          </div>
        </Popover>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <span
          className="hidden text-xs text-ink-500 sm:inline"
          data-testid="save-state"
          aria-live="polite"
        >
          {saving
            ? 'Saving…'
            : lastSavedAt
              ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}`
              : 'All changes saved'}
        </span>
        <IconButton label="Search notebook (Ctrl+F)" onClick={onShowSearch}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="6" />
            <path d="M16 16l4 4" />
          </svg>
        </IconButton>
        <IconButton
          label={sidebarOpen ? 'Hide sidebar (Ctrl+P)' : 'Show pages sidebar (Ctrl+P)'}
          active={sidebarOpen}
          onClick={toggleSidebar}
          data-testid="toggle-sidebar"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="7" height="16" rx="1.5" />
            <rect x="12" y="4" width="9" height="16" rx="1.5" />
          </svg>
        </IconButton>
        <IconButton label="Bookmarks and outline" onClick={onShowOutline}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M7 4h10v16l-5-4-5 4z" />
          </svg>
        </IconButton>
        <IconButton label="Keyboard shortcuts" onClick={onShowShortcuts}>
          <span aria-hidden="true">?</span>
        </IconButton>

        <div className="relative">
          <IconButton
            label="Notebook menu"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            data-testid="notebook-menu"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="5" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="12" cy="19" r="1.6" />
            </svg>
          </IconButton>
          <Popover open={menuOpen} onClose={() => setMenuOpen(false)} label="Notebook menu">
            <MenuButton
              onClick={() => {
                setMenuOpen(false);
                onImportPdf();
              }}
            >
              Import PDF pages…
            </MenuButton>
            <MenuButton
              onClick={() => {
                setMenuOpen(false);
                onImportImage();
              }}
            >
              Insert image…
            </MenuButton>
            <MenuButton
              onClick={() => {
                setMenuOpen(false);
                onExportPdf();
              }}
              data-testid="export-pdf"
            >
              Export as PDF
            </MenuButton>
            <MenuButton
              onClick={() => {
                setMenuOpen(false);
                onExportPng();
              }}
            >
              Export page as PNG
            </MenuButton>
            <MenuButton
              onClick={() => {
                setMenuOpen(false);
                onExportInkpad();
              }}
            >
              Export .inkpad
            </MenuButton>
            <MenuButton
              onClick={() => {
                setMenuOpen(false);
                onShowShortcuts();
              }}
            >
              Keyboard shortcuts
            </MenuButton>
          </Popover>
        </div>
      </div>

      {settings.toolbarCollapsed ? null : (
        <span className="sr-only">
          {pageIndex + 1} of {pageCount}
        </span>
      )}
    </header>
  );
}

function MenuButton({
  children,
  onClick,
  ...rest
}: { children: ReactNode; onClick(): void } & Record<string, unknown>) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex h-11 w-full items-center rounded-md px-3 text-left text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  );
}
