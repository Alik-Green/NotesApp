/** A notebook tile in the library grid, with an accessible context menu. */

import { useState } from 'react';
import { formatRelative } from './format';
import type { Folder, Notebook } from '@/core/model';
import { MenuItem, Popover } from '@/components/ui/primitives';
import { NotebookCover } from './NotebookCover';

export interface NotebookCardProps {
  notebook: Notebook;
  folders: Folder[];
  selected: boolean;
  selectMode: boolean;
  onOpen(id: string): void;
  onToggleSelect(id: string): void;
  onRename(id: string, title: string): void;
  onDuplicate(id: string): void;
  onDelete(id: string): void;
  onMove(id: string, folderId: string | null): void;
  onExport(id: string): void;
}

export function NotebookCard({
  notebook,
  folders,
  selected,
  selectMode,
  onOpen,
  onToggleSelect,
  onRename,
  onDuplicate,
  onDelete,
  onMove,
  onExport,
}: NotebookCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(notebook.title);

  return (
    <article
      className={`group relative flex flex-col gap-2 rounded-2xl border p-3 transition-colors ${
        selected
          ? 'border-accent bg-accent/5'
          : 'border-ink-200 bg-white hover:border-ink-300 dark:border-ink-800 dark:bg-ink-900 dark:hover:border-ink-700'
      }`}
      data-testid="notebook-card"
      data-notebook-id={notebook.id}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          className="flex-1 text-left"
          onClick={() => (selectMode ? onToggleSelect(notebook.id) : onOpen(notebook.id))}
          aria-label={`Open ${notebook.title}`}
          data-testid="notebook-open"
        >
          <NotebookCover notebook={notebook} width={168} height={210} />
        </button>
        <div className="relative">
          <button
            type="button"
            aria-label={`Actions for ${notebook.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flex h-11 w-11 touch-target items-center justify-center rounded-lg text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800"
            onClick={() => setMenuOpen((open) => !open)}
            data-testid="notebook-menu"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" fill="currentColor">
              <circle cx="10" cy="4" r="1.7" />
              <circle cx="10" cy="10" r="1.7" />
              <circle cx="10" cy="16" r="1.7" />
            </svg>
          </button>
          <Popover
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            label={`Actions for ${notebook.title}`}
          >
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                onOpen(notebook.id);
              }}
            >
              Open
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                setRenaming(true);
              }}
            >
              Rename…
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                onDuplicate(notebook.id);
              }}
            >
              Duplicate
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                setMoveOpen(true);
              }}
            >
              Move to folder…
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                onExport(notebook.id);
              }}
            >
              Export .inkpad
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                onToggleSelect(notebook.id);
              }}
            >
              {selected ? 'Deselect' : 'Select'}
            </MenuItem>
            <MenuItem
              className="text-red-600 dark:text-red-400"
              onClick={() => {
                setMenuOpen(false);
                onDelete(notebook.id);
              }}
            >
              Delete…
            </MenuItem>
          </Popover>
        </div>
      </div>

      <div className="flex flex-col">
        {renaming ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const next = draftTitle.trim();
              if (next) onRename(notebook.id, next);
              setRenaming(false);
            }}
          >
            <input
              autoFocus
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={() => setRenaming(false)}
              aria-label={`Rename ${notebook.title}`}
              className="w-full rounded-md border border-accent bg-white px-2 py-1 text-sm dark:bg-ink-800"
            />
          </form>
        ) : (
          <h3 className="truncate text-sm font-semibold" title={notebook.title}>
            {notebook.title}
          </h3>
        )}
        <p className="text-xs text-ink-500 dark:text-ink-400">
          {notebook.pageCount} {notebook.pageCount === 1 ? 'page' : 'pages'} ·{' '}
          {formatRelative(notebook.updatedAt)}
        </p>
      </div>

      {selectMode ? (
        <label className="flex items-center gap-2 text-xs text-ink-600 dark:text-ink-300">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(notebook.id)}
            aria-label={`Select ${notebook.title}`}
          />
          Select
        </label>
      ) : null}

      <Popover
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        align="left"
        label="Move to folder"
      >
        <MenuItem
          onClick={() => {
            setMoveOpen(false);
            onMove(notebook.id, null);
          }}
        >
          No folder
        </MenuItem>
        {folders.map((folder) => (
          <MenuItem
            key={folder.id}
            onClick={() => {
              setMoveOpen(false);
              onMove(notebook.id, folder.id);
            }}
          >
            {folder.name}
          </MenuItem>
        ))}
      </Popover>
    </article>
  );
}
