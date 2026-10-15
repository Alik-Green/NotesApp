/**
 * Home screen: folder sidebar, search, notebook grid and library-level import/export.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadBlob } from '@/render/export/png';
import {
  Badge,
  Button,
  Dialog,
  MenuItem,
  Popover,
  Spinner,
  TextField,
} from '@/components/ui/primitives';
import { selectVisibleNotebooks, useLibrary } from '@/state/libraryStore';
import { useSettings } from '@/state/settings';
import { navigate } from '@/state/router';
import type { TemplateKind } from '@/core/model';
import { TEMPLATE_LABELS } from '@/core/templates';
import { exportNotebookBytes } from '@/data/repository';
import { NotebookCard } from './NotebookCard';

export interface LibraryScreenProps {
  onOpenNotebook(id: string): void;
}

const TEMPLATE_OPTIONS = Object.keys(TEMPLATE_LABELS) as TemplateKind[];

export function LibraryScreen({ onOpenNotebook }: LibraryScreenProps) {
  const library = useLibrary();
  const notebooks = useLibrary(selectVisibleNotebooks);
  const settings = useSettings();

  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('Untitled notebook');
  const [newTemplate, setNewTemplate] = useState<TemplateKind>('blank');
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void library.refresh();
    // Refresh only on mount; the store owns further updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const activeFolderName = useMemo(
    () =>
      library.folders.find((folder) => folder.id === library.activeFolderId)?.name ??
      'All notebooks',
    [library.folders, library.activeFolderId],
  );

  const handleCreate = async () => {
    const title = newTitle.trim() || 'Untitled notebook';
    const notebook = await library.createNotebook(title, newTemplate);
    setNewOpen(false);
    setNewTitle('Untitled notebook');
    onOpenNotebook(notebook.id);
  };

  const handleExport = async (id: string) => {
    const bytes = await exportNotebookBytes(id);
    if (!bytes) return;
    const notebook = library.notebooks.find((nb) => nb.id === id);
    const copy = bytes.slice();
    downloadBlob(
      new Blob([copy.buffer as ArrayBuffer], { type: 'application/zip' }),
      `${notebook?.title ?? 'notebook'}.inkpad`,
    );
    setToast('Exported .inkpad file');
  };

  const handleImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    await library.importInkpad(files);
    setToast(`Imported ${files.length} notebook${files.length === 1 ? '' : 's'}`);
  };

  const handleBackup = async () => {
    const blob = await library.backupAll();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `inkpad-backup-${stamp}.inkpad-backup`);
    setToast('Backup downloaded');
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-100 dark:bg-ink-950">
      <header className="flex flex-wrap items-center gap-3 border-b border-ink-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-ink-800 dark:bg-ink-900/90">
        <button
          type="button"
          onClick={() => navigate({ name: 'library' })}
          className="flex items-center gap-2 text-lg font-semibold"
          aria-label="InkPad home"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink-900 text-white dark:bg-ink-100 dark:text-ink-900">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 19c3-1 5-4 6.5-7.5S14 5 16 5s2 2.5 0 5-6 5-9 6z" />
            </svg>
          </span>
          InkPad
        </button>

        <div className="order-3 flex w-full items-center gap-2 sm:order-none sm:w-auto sm:flex-1">
          <label className="sr-only" htmlFor="library-search">
            Search notebooks
          </label>
          <input
            id="library-search"
            type="search"
            value={library.query}
            onChange={(event) => library.setQuery(event.target.value)}
            placeholder="Search notebooks and page text…"
            className="h-11 min-w-0 flex-1 rounded-lg border border-ink-200 bg-white px-3 text-sm dark:border-ink-700 dark:bg-ink-800"
            data-testid="library-search"
          />
          <label className="sr-only" htmlFor="library-sort">
            Sort notebooks
          </label>
          <select
            id="library-sort"
            value={library.sort}
            onChange={(event) =>
              library.setSort(event.target.value as 'updated' | 'created' | 'title')
            }
            className="h-11 rounded-lg border border-ink-200 bg-white px-2 text-sm dark:border-ink-700 dark:bg-ink-800"
          >
            <option value="updated">Last modified</option>
            <option value="created">Created</option>
            <option value="title">Title</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => setNewOpen(true)} data-testid="new-notebook">
            <span aria-hidden="true">＋</span> New notebook
          </Button>
          <div className="relative">
            <Button
              aria-haspopup="menu"
              onClick={() => setSettingsOpen((open) => !open)}
              data-testid="library-more"
            >
              More
            </Button>
            <Popover
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              label="Library actions"
            >
              <MenuItem
                onClick={() => {
                  setSettingsOpen(false);
                  fileInputRef.current?.click();
                }}
              >
                Import .inkpad…
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setSettingsOpen(false);
                  void handleBackup();
                }}
              >
                Back up all data
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setSettingsOpen(false);
                  backupInputRef.current?.click();
                }}
              >
                Restore from backup…
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setSettingsOpen(false);
                  void library.refresh();
                }}
              >
                Refresh
              </MenuItem>
            </Popover>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-ink-200 bg-white p-3 md:flex dark:border-ink-800 dark:bg-ink-900">
          <button
            type="button"
            onClick={() => library.setActiveFolder(null)}
            className={`flex h-11 touch-target items-center gap-2 rounded-lg px-3 text-sm ${
              library.activeFolderId === null
                ? 'bg-accent/15 font-semibold text-accent'
                : 'hover:bg-ink-100 dark:hover:bg-ink-800'
            }`}
          >
            <span aria-hidden="true">📚</span> All notebooks
            <Badge>{library.notebooks.length}</Badge>
          </button>
          <div className="mt-2 flex items-center justify-between px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Folders</h2>
            <button
              type="button"
              className="rounded p-1 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800"
              aria-label="New folder"
              onClick={() => {
                setFolderName('');
                setFolderDialogOpen(true);
              }}
            >
              ＋
            </button>
          </div>
          {library.folders.map((folder) => (
            <div key={folder.id} className="group flex items-center gap-1">
              {renamingFolder === folder.id ? (
                <form
                  className="flex-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void library.renameFolder(folder.id, folderName.trim() || folder.name);
                    setRenamingFolder(null);
                  }}
                >
                  <input
                    autoFocus
                    value={folderName}
                    onChange={(event) => setFolderName(event.target.value)}
                    onBlur={() => setRenamingFolder(null)}
                    aria-label={`Rename folder ${folder.name}`}
                    className="w-full rounded-md border border-accent px-2 py-1 text-sm dark:bg-ink-800"
                  />
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => library.setActiveFolder(folder.id)}
                  className={`flex h-11 flex-1 touch-target items-center gap-2 rounded-lg px-3 text-sm ${
                    library.activeFolderId === folder.id
                      ? 'bg-accent/15 font-semibold text-accent'
                      : 'hover:bg-ink-100 dark:hover:bg-ink-800'
                  }`}
                >
                  <span aria-hidden="true">📁</span>
                  <span className="truncate">{folder.name}</span>
                </button>
              )}
              <button
                type="button"
                aria-label={`Rename folder ${folder.name}`}
                className="rounded p-1 text-ink-400 opacity-0 hover:bg-ink-100 group-hover:opacity-100 dark:hover:bg-ink-800"
                onClick={() => {
                  setFolderName(folder.name);
                  setRenamingFolder(folder.id);
                }}
              >
                ✎
              </button>
              <button
                type="button"
                aria-label={`Delete folder ${folder.name}`}
                className="rounded p-1 text-ink-400 opacity-0 hover:bg-ink-100 group-hover:opacity-100 dark:hover:bg-ink-800"
                onClick={() => void library.deleteFolder(folder.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </aside>

        <main className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{activeFolderName}</h1>
            <span className="text-sm text-ink-500">
              {notebooks.length} {notebooks.length === 1 ? 'notebook' : 'notebooks'}
            </span>
            {library.selection.length > 0 ? (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Badge tone="accent">{library.selection.length} selected</Badge>
                <Button
                  size="sm"
                  onClick={() =>
                    void library.moveNotebooks(library.selection, library.activeFolderId)
                  }
                >
                  Move here
                </Button>
                <Button
                  size="sm"
                  onClick={() => void library.moveNotebooks(library.selection, null)}
                >
                  Remove from folder
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setConfirmDelete(library.selection[0]!)}
                >
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => library.clearSelection()}>
                  Clear
                </Button>
              </div>
            ) : null}
          </div>

          {library.loading ? (
            <Spinner label="Loading library" />
          ) : notebooks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-ink-300 p-8 text-center dark:border-ink-700">
              <p className="text-sm text-ink-500">
                {library.query
                  ? 'No notebooks match your search.'
                  : 'No notebooks yet — create one to start writing.'}
              </p>
              <Button className="mt-4" variant="primary" onClick={() => setNewOpen(true)}>
                New notebook
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
              {notebooks.map((notebook) => (
                <NotebookCard
                  key={notebook.id}
                  notebook={notebook}
                  folders={library.folders}
                  selected={library.selection.includes(notebook.id)}
                  selectMode={library.selectMode}
                  onOpen={onOpenNotebook}
                  onToggleSelect={library.toggleSelection}
                  onRename={(id, title) => void library.renameNotebook(id, title)}
                  onDuplicate={(id) => void library.duplicateNotebook(id)}
                  onDelete={(id) => setConfirmDelete(id)}
                  onMove={(id, folderId) => void library.moveNotebooks([id], folderId)}
                  onExport={(id) => void handleExport(id)}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".inkpad,application/zip"
        multiple
        className="hidden"
        data-testid="import-inkpad-input"
        onChange={(event) => void handleImportFiles(event.target.files)}
      />
      <input
        ref={backupInputRef}
        type="file"
        accept=".inkpad-backup,.zip,application/zip"
        className="hidden"
        data-testid="restore-backup-input"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const result = await library.importBackupFile(file);
          setToast(`Restored ${result.notebooks} notebooks`);
        }}
      />

      <Dialog
        open={newOpen}
        title="New notebook"
        onClose={() => setNewOpen(false)}
        footer={
          <>
            <Button onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void handleCreate()}
              data-testid="create-notebook"
            >
              Create
            </Button>
          </>
        }
      >
        <TextField
          label="Title"
          value={newTitle}
          autoFocus
          onChange={(event) => setNewTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleCreate();
          }}
          data-testid="new-notebook-title"
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Page template
          </span>
          <div className="flex flex-wrap gap-2">
            {TEMPLATE_OPTIONS.map((template) => (
              <button
                key={template}
                type="button"
                onClick={() => setNewTemplate(template)}
                aria-pressed={newTemplate === template}
                className={`h-11 rounded-lg border px-3 text-sm ${
                  newTemplate === template
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-ink-200 hover:bg-ink-100 dark:border-ink-700 dark:hover:bg-ink-800'
                }`}
              >
                {TEMPLATE_LABELS[template]}
              </button>
            ))}
          </div>
        </div>
      </Dialog>

      <Dialog
        open={folderDialogOpen}
        title="New folder"
        onClose={() => setFolderDialogOpen(false)}
        footer={
          <>
            <Button onClick={() => setFolderDialogOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                void library.createFolder(folderName.trim() || 'Folder');
                setFolderDialogOpen(false);
              }}
            >
              Create folder
            </Button>
          </>
        }
      >
        <TextField
          label="Folder name"
          value={folderName}
          onChange={(event) => setFolderName(event.target.value)}
        />
      </Dialog>

      <Dialog
        open={confirmDelete !== null}
        title="Delete notebook?"
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const id = confirmDelete;
                setConfirmDelete(null);
                if (id) void library.deleteNotebook(id);
                setToast('Notebook deleted');
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-600 dark:text-ink-300">
          This permanently removes the notebook, its pages and any imported PDFs from this device.
        </p>
      </Dialog>

      {toast ? (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink-900 px-4 py-2 text-sm text-white shadow-panel dark:bg-ink-100 dark:text-ink-900"
        >
          {toast}
        </div>
      ) : null}

      {settings.hydrated ? null : <span className="sr-only">Loading settings</span>}
    </div>
  );
}
