/**
 * Dexie/IndexedDB schema. Everything InkPad stores lives here — there is no backend.
 *
 * Tables:
 *  - notebooks  metadata (title, folder, cover, counts)
 *  - pages      serialized pages incl. ink as base64 typed arrays, indexed by notebook+order
 *  - assets     PDFs and images as Blobs (weight lives here, never in the page rows)
 *  - folders    library folders
 *  - bookmarks  user bookmarks (and imported PDF outline) per notebook
 *  - history    persisted command history per notebook (last 500 commands)
 *  - settings   small key/value store (theme, tool presets, palm rejection, …)
 *  - meta       schema bookkeeping (installed version, last backup)
 */

import Dexie, { type Table } from 'dexie';
import type { Bookmark, Folder, Notebook, OutlineItem } from '@/core/model';
import type { SerializedPage } from '@/core/serialization';
import type { CommandData } from '@/core/commands';

export const DB_NAME = 'inkpad';
export const DB_VERSION = 1;

export interface AssetRow {
  id: string;
  kind: 'pdf' | 'image';
  name: string;
  mime: string;
  bytes: Blob;
  pageCount?: number;
  width?: number;
  height?: number;
  createdAt: number;
}

export interface HistoryRow {
  notebookId: string;
  entries: CommandData[];
  redo: CommandData[];
  updatedAt: number;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

export interface MetaRow {
  key: string;
  value: string | number;
}

export class InkPadDatabase extends Dexie {
  notebooks!: Table<Notebook, string>;
  pages!: Table<SerializedPage, string>;
  assets!: Table<AssetRow, string>;
  folders!: Table<Folder, string>;
  history!: Table<HistoryRow, string>;
  settings!: Table<SettingRow, string>;
  bookmarks!: Table<Bookmark, string>;
  outline!: Table<OutlineItem, string>;
  meta!: Table<MetaRow, string>;

  constructor(name = DB_NAME) {
    super(name);
    this.version(DB_VERSION).stores({
      notebooks: 'id, title, folderId, updatedAt',
      pages: 'id, notebookId, [notebookId+index]',
      assets: 'id, kind, createdAt',
      folders: 'id, parentId, name',
      history: 'notebookId',
      settings: 'key',
      bookmarks: 'id, notebookId, pageId',
      outline: 'id, notebookId',
      meta: 'key',
    });
  }
}

export const db = new InkPadDatabase();

/** Close + delete everything (used by "erase all data" and tests). */
export async function destroyDatabase(): Promise<void> {
  await db.delete();
}

export async function resetDatabase(): Promise<void> {
  await Promise.all([
    db.notebooks.clear(),
    db.pages.clear(),
    db.assets.clear(),
    db.folders.clear(),
    db.history.clear(),
    db.bookmarks.clear(),
    db.outline.clear(),
  ]);
}
