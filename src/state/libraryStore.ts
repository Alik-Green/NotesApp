/**
 * Library (home screen) state: notebooks, folders, search, sort, selection and bulk actions.
 */

import { create } from 'zustand';
import type { Folder, ID, Notebook } from '@/core/model';
import { matchesQuery } from '@/core/search';
import * as repo from '@/data/repository';

export type SortKey = 'updated' | 'created' | 'title';

export interface LibraryState {
  notebooks: Notebook[];
  folders: Folder[];
  activeFolderId: ID | null;
  query: string;
  sort: SortKey;
  loading: boolean;
  error: string | null;
  selection: ID[];
  selectMode: boolean;
  busy: string | null;

  refresh(): Promise<void>;
  setQuery(query: string): void;
  setSort(sort: SortKey): void;
  setActiveFolder(folderId: ID | null): void;
  toggleSelection(id: ID): void;
  clearSelection(): void;
  setSelectMode(on: boolean): void;
  createNotebook(title: string, template?: Notebook['defaultTemplate']): Promise<Notebook>;
  renameNotebook(id: ID, title: string): Promise<void>;
  duplicateNotebook(id: ID): Promise<void>;
  deleteNotebook(id: ID): Promise<void>;
  moveNotebooks(ids: readonly ID[], folderId: ID | null): Promise<void>;
  createFolder(name: string): Promise<void>;
  renameFolder(id: ID, name: string): Promise<void>;
  deleteFolder(id: ID): Promise<void>;
  importInkpad(files: FileList | File[]): Promise<number>;
  importBackupFile(file: File): Promise<{ notebooks: number; folders: number }>;
  backupAll(): Promise<Blob>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  notebooks: [],
  folders: [],
  activeFolderId: null,
  query: '',
  sort: 'updated',
  loading: true,
  error: null,
  selection: [],
  selectMode: false,
  busy: null,

  async refresh() {
    set({ loading: true, error: null });
    try {
      const [notebooks, folders] = await Promise.all([repo.listNotebooks(), repo.listFolders()]);
      set({ notebooks, folders, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  setQuery(query) {
    set({ query });
  },

  setSort(sort) {
    set({ sort });
  },

  setActiveFolder(folderId) {
    set({ activeFolderId: folderId, selection: [] });
  },

  toggleSelection(id) {
    const selection = get().selection;
    set({
      selection: selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id],
    });
  },

  clearSelection() {
    set({ selection: [], selectMode: false });
  },

  setSelectMode(on) {
    set({ selectMode: on, selection: on ? get().selection : [] });
  },

  async createNotebook(title, template) {
    const { notebook } = await repo.createNotebookWithPage({
      title,
      folderId: get().activeFolderId,
      template: template ?? 'blank',
    });
    await get().refresh();
    return notebook;
  },

  async renameNotebook(id, title) {
    await repo.renameNotebook(id, title);
    await get().refresh();
  },

  async duplicateNotebook(id) {
    set({ busy: 'Duplicating…' });
    try {
      await repo.duplicateNotebook(id);
      await get().refresh();
    } finally {
      set({ busy: null });
    }
  },

  async deleteNotebook(id) {
    await repo.deleteNotebook(id);
    set({ selection: get().selection.filter((x) => x !== id) });
    await get().refresh();
  },

  async moveNotebooks(ids, folderId) {
    for (const id of ids) await repo.setNotebookFolder(id, folderId);
    await get().refresh();
  },

  async createFolder(name) {
    await repo.createFolder(name, get().activeFolderId);
    await get().refresh();
  },

  async renameFolder(id, name) {
    await repo.renameFolder(id, name);
    await get().refresh();
  },

  async deleteFolder(id) {
    await repo.deleteFolder(id);
    if (get().activeFolderId === id) set({ activeFolderId: null });
    await get().refresh();
  },

  async importInkpad(files) {
    const list = Array.from(files);
    let count = 0;
    for (const file of list) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await repo.importNotebookBytes(bytes, {
        folderId: get().activeFolderId,
        title: file.name.replace(/\.inkpad$/i, ''),
      });
      count++;
    }
    await get().refresh();
    return count;
  },

  async importBackupFile(file) {
    set({ busy: 'Restoring backup…' });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await repo.importBackupBytes(bytes);
      await get().refresh();
      return result;
    } finally {
      set({ busy: null });
    }
  },

  async backupAll() {
    set({ busy: 'Preparing backup…' });
    try {
      const bytes = await repo.exportBackupBytes();
      const copy = bytes.slice();
      return new Blob([copy.buffer as ArrayBuffer], { type: 'application/zip' });
    } finally {
      set({ busy: null });
    }
  },
}));

export interface LibraryView {
  rootNotebooks: Notebook[];
  folderNotebooks: Notebook[];
  visible: Notebook[];
}

/** Derive the notebooks visible for the current folder + query + sort. */
export function selectVisibleNotebooks(state: LibraryState): Notebook[] {
  const inFolder = state.notebooks.filter((nb) =>
    state.activeFolderId === null ? true : nb.folderId === state.activeFolderId,
  );
  const searched = inFolder.filter((nb) =>
    matchesQuery(`${nb.searchText}\n${nb.title.toLowerCase()}`, state.query),
  );
  const sort = state.sort;
  return searched.sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'created') return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  });
}
