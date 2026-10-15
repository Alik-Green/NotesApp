/**
 * Serialization: document model ⇄ plain JSON-safe data, plus the `.inkpad` container
 * (a zip holding manifest + JSON + binary assets) used for notebook export/import and full
 * backups. Pure TypeScript apart from `Blob`/`Uint8Array`, which exist in browsers, workers
 * and Node ≥18.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { base64ToInt16, base64ToUint8, int16ToBase64, uint8ToBase64 } from './base64';
import type {
  AssetMeta,
  Bookmark,
  Folder,
  ID,
  Notebook,
  OutlineItem,
  Page,
  SceneObject,
  StrokeTool,
} from './model';
import { objectBounds } from './model';
import type { DocumentSnapshot } from './document';

export const INKPAD_FORMAT = 'inkpad';
export const INKPAD_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Object codec                                                        */
/* ------------------------------------------------------------------ */

export interface SerializedStroke {
  type: 'stroke';
  id: ID;
  tool: StrokeTool;
  color: string;
  size: number;
  opacity: number;
  seed: number;
  bbox: { x: number; y: number; w: number; h: number };
  /** Quantized channels, base64-encoded typed arrays. */
  xs: string;
  ys: string;
  ps: string;
}

export type SerializedObject =
  | SerializedStroke
  | Exclude<SceneObject, { type: 'stroke' }>;

export function serializeObject(o: SceneObject): SerializedObject {
  if (o.type === 'stroke') {
    return {
      type: 'stroke',
      id: o.id,
      tool: o.tool,
      color: o.color,
      size: o.size,
      opacity: o.opacity,
      seed: o.seed,
      bbox: { ...o.bbox },
      xs: int16ToBase64(o.xs),
      ys: int16ToBase64(o.ys),
      ps: uint8ToBase64(o.ps),
    };
  }
  return { ...o } as SerializedObject;
}

export function deserializeObject(data: SerializedObject): SceneObject {
  if (data.type === 'stroke') {
    const stroke: SceneObject = {
      type: 'stroke',
      id: data.id,
      tool: data.tool,
      color: data.color,
      size: data.size,
      opacity: data.opacity,
      seed: data.seed,
      xs: base64ToInt16(data.xs),
      ys: base64ToInt16(data.ys),
      ps: base64ToUint8(data.ps),
      bbox: { ...data.bbox },
    };
    stroke.bbox = objectBounds(stroke);
    return stroke;
  }
  if (data.type === 'image') {
    return { ...data, crop: { ...data.crop } };
  }
  if (data.type === 'text') {
    return {
      ...data,
      link: data.link ? { ...data.link } : undefined,
      sticky: data.sticky ? { ...data.sticky } : undefined,
    };
  }
  return { ...data };
}

/* ------------------------------------------------------------------ */
/* Page / snapshot codec                                               */
/* ------------------------------------------------------------------ */

export interface SerializedPage {
  id: ID;
  notebookId: ID;
  index: number;
  width: number;
  height: number;
  rotation: Page['rotation'];
  background: Page['background'];
  paperColor: string;
  updatedAt: number;
  objects: SerializedObject[];
}

export function serializePage(page: Page): SerializedPage {
  return {
    id: page.id,
    notebookId: page.notebookId,
    index: page.index,
    width: page.width,
    height: page.height,
    rotation: page.rotation,
    background: { ...page.background },
    paperColor: page.paperColor,
    updatedAt: page.updatedAt,
    objects: page.objects.map(serializeObject),
  };
}

export function deserializePage(data: SerializedPage): Page {
  return {
    id: data.id,
    notebookId: data.notebookId,
    index: data.index,
    width: data.width,
    height: data.height,
    rotation: data.rotation,
    background: { ...data.background },
    paperColor: data.paperColor,
    updatedAt: data.updatedAt,
    objects: data.objects.map(deserializeObject),
  };
}

export interface SerializedNotebookJson {
  format: typeof INKPAD_FORMAT;
  version: number;
  notebook: Notebook;
  pages: SerializedPage[];
  assets: AssetMeta[];
  bookmarks: Bookmark[];
  outline: OutlineItem[];
}

export function serializeSnapshot(
  snapshot: DocumentSnapshot,
  assets?: readonly AssetMeta[],
): SerializedNotebookJson {
  const { cover, ...notebookRest } = snapshot.notebook;
  return {
    format: INKPAD_FORMAT,
    version: INKPAD_VERSION,
    // Cover thumbnails are regenerated from the pages, so they never go stale in the file.
    notebook: { ...notebookRest, cover: cover ? { pageId: cover.pageId } : undefined },
    pages: snapshot.pages.map(serializePage),
    assets: (assets ?? snapshot.assets).map((a) => ({ ...a })),
    bookmarks: snapshot.bookmarks.map((b) => ({ ...b })),
    outline: snapshot.outline.map((o) => ({ ...o })),
  };
}

export function deserializeSnapshot(json: SerializedNotebookJson): DocumentSnapshot {
  return {
    notebook: {
      ...json.notebook,
      cover: json.notebook.cover ? { ...json.notebook.cover } : undefined,
    },
    pages: json.pages.map(deserializePage),
    assets: json.assets.map((a) => ({ ...a })),
    bookmarks: (json.bookmarks ?? []).map((b) => ({ ...b })),
    outline: (json.outline ?? []).map((o) => ({ ...o })),
  };
}

/* ------------------------------------------------------------------ */
/* .inkpad container                                                   */
/* ------------------------------------------------------------------ */

export interface AssetFile {
  id: ID;
  data: Uint8Array;
}

export interface NotebookBundle {
  json: SerializedNotebookJson;
  assetFiles: AssetFile[];
}

export interface InkpadManifest {
  format: typeof INKPAD_FORMAT;
  version: number;
  kind: 'notebook' | 'backup';
  app: string;
  createdAt: number;
  title: string;
  notebookId?: ID;
  pageCount?: number;
  notebookCount?: number;
}

function extensionFor(mime: string, kind: AssetMeta['kind']): string {
  if (kind === 'pdf') return 'pdf';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'bin';
}

export function assetPath(meta: Pick<AssetMeta, 'id' | 'mime' | 'kind'>): string {
  return `assets/${meta.id}.${extensionFor(meta.mime, meta.kind)}`;
}

/** Encode one notebook as `.inkpad` bytes. */
export function encodeNotebookBundle(bundle: NotebookBundle): Uint8Array {
  const manifest: InkpadManifest = {
    format: INKPAD_FORMAT,
    version: INKPAD_VERSION,
    kind: 'notebook',
    app: 'InkPad',
    createdAt: Date.now(),
    title: bundle.json.notebook.title,
    notebookId: bundle.json.notebook.id,
    pageCount: bundle.json.pages.length,
  };
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'notebook.json': strToU8(JSON.stringify(bundle.json)),
  };
  for (const asset of bundle.assetFiles) {
    const meta = bundle.json.assets.find((a) => a.id === asset.id);
    files[meta ? assetPath(meta) : `assets/${asset.id}.bin`] = asset.data;
  }
  return zipSync(files, { level: 6 });
}

export function decodeNotebookBundle(bytes: Uint8Array): NotebookBundle {
  const files = unzipSync(bytes);
  const notebookRaw = files['notebook.json'];
  if (!notebookRaw) throw new Error('Not a valid .inkpad file: missing notebook.json');
  const manifestRaw = files['manifest.json'];
  if (manifestRaw) {
    const manifest = JSON.parse(strFromU8(manifestRaw)) as InkpadManifest;
    if (manifest.format !== INKPAD_FORMAT) throw new Error('Not an InkPad file');
    if (manifest.version > INKPAD_VERSION) {
      throw new Error(`This .inkpad file was created with a newer version (v${manifest.version})`);
    }
  }
  const json = JSON.parse(strFromU8(notebookRaw)) as SerializedNotebookJson;
  const assetFiles: AssetFile[] = [];
  for (const [path, data] of Object.entries(files)) {
    if (!path.startsWith('assets/')) continue;
    assetFiles.push({ id: assetIdFromPath(path), data });
  }
  return { json, assetFiles };
}

function assetIdFromPath(path: string): ID {
  const base = path.slice('assets/'.length);
  return base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
}

/* ------------------------------------------------------------------ */
/* Full backup                                                         */
/* ------------------------------------------------------------------ */

export interface BackupBundle {
  folders: Folder[];
  notebooks: NotebookBundle[];
}

export function encodeBackup(bundle: BackupBundle): Uint8Array {
  const manifest: InkpadManifest = {
    format: INKPAD_FORMAT,
    version: INKPAD_VERSION,
    kind: 'backup',
    app: 'InkPad',
    createdAt: Date.now(),
    title: 'InkPad backup',
    notebookCount: bundle.notebooks.length,
  };
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'backup.json': strToU8(JSON.stringify({ folders: bundle.folders })),
  };
  bundle.notebooks.forEach((nb, i) => {
    files[`notebooks/${String(i).padStart(4, '0')}.json`] = strToU8(JSON.stringify(nb.json));
    for (const asset of nb.assetFiles) {
      const meta = nb.json.assets.find((a) => a.id === asset.id);
      const path = meta ? assetPath(meta) : `assets/${asset.id}.bin`;
      // Assets can be shared between notebooks, so identical paths are written once.
      if (!files[path]) files[path] = asset.data;
    }
  });
  return zipSync(files, { level: 6 });
}

export function decodeBackup(bytes: Uint8Array): BackupBundle {
  const files = unzipSync(bytes);
  const manifestRaw = files['manifest.json'];
  if (!manifestRaw) throw new Error('Not a valid InkPad backup');
  const manifest = JSON.parse(strFromU8(manifestRaw)) as InkpadManifest;
  if (manifest.format !== INKPAD_FORMAT || manifest.kind !== 'backup') {
    throw new Error('Not an InkPad backup file');
  }
  const backupRaw = files['backup.json'];
  const meta = backupRaw
    ? (JSON.parse(strFromU8(backupRaw)) as { folders: Folder[] })
    : { folders: [] as Folder[] };
  const assetFiles: AssetFile[] = [];
  for (const [path, data] of Object.entries(files)) {
    if (!path.startsWith('assets/')) continue;
    assetFiles.push({ id: assetIdFromPath(path), data });
  }
  const notebooks: NotebookBundle[] = [];
  for (const path of Object.keys(files)
    .filter((p) => p.startsWith('notebooks/'))
    .sort()) {
    const json = JSON.parse(strFromU8(files[path]!)) as SerializedNotebookJson;
    const used = new Set(json.assets.map((a) => a.id));
    notebooks.push({ json, assetFiles: assetFiles.filter((a) => used.has(a.id)) });
  }
  return { folders: meta.folders ?? [], notebooks };
}

/* ------------------------------------------------------------------ */
/* Blob helpers                                                        */
/* ------------------------------------------------------------------ */

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export function bytesToBlob(bytes: Uint8Array, mime: string): Blob {
  // The Uint8Array view is transferred to the Blob as-is; `BlobPart` typing does not accept
  // a typed-array view directly, so the buffer slice is passed through.
  const copy = bytes.slice();
  return new Blob([copy.buffer as ArrayBuffer], { type: mime });
}
