/**
 * Image bitmap registry for image objects. Decoded bitmaps live here (keyed by asset id) so the
 * painters can draw synchronously; loading happens on demand and never blocks drawing.
 */

import type { ID } from '@/core/model';
import { getAssetBytes } from '@/data/repository';

const bitmaps = new Map<ID, ImageBitmap | HTMLImageElement>();
const pending = new Map<ID, Promise<ImageBitmap | HTMLImageElement | null>>();

export function getAssetImage(assetId: ID): ImageBitmap | HTMLImageElement | undefined {
  return bitmaps.get(assetId);
}

export function assetImageMap(ids: readonly ID[]): Map<ID, ImageBitmap | HTMLImageElement> {
  const map = new Map<ID, ImageBitmap | HTMLImageElement>();
  for (const id of ids) {
    const bitmap = bitmaps.get(id);
    if (bitmap) map.set(id, bitmap);
  }
  return map;
}

export async function ensureAssetImage(assetId: ID): Promise<ImageBitmap | HTMLImageElement | null> {
  const existing = bitmaps.get(assetId);
  if (existing) return existing;
  const inFlight = pending.get(assetId);
  if (inFlight) return inFlight;
  const load = (async () => {
    const blob = await getAssetBytes(assetId);
    if (!blob) return null;
    try {
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob);
        bitmaps.set(assetId, bitmap);
        return bitmap;
      }
      if (typeof Image !== 'undefined') {
        const url = URL.createObjectURL(blob);
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = reject;
          element.src = url;
        });
        bitmaps.set(assetId, image);
        return image;
      }
    } catch (error) {
      console.warn('InkPad: could not decode image asset', assetId, error);
    }
    return null;
  })();
  pending.set(assetId, load);
  try {
    return await load;
  } finally {
    pending.delete(assetId);
  }
}

/** Decode a file selected by the user (before it is stored). */
export async function decodeImageFile(
  file: File | Blob,
): Promise<{ bitmap: ImageBitmap | HTMLImageElement; width: number; height: number } | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file);
      return { bitmap, width: bitmap.width, height: bitmap.height };
    }
    const url = URL.createObjectURL(file);
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = reject;
      element.src = url;
    });
    return { bitmap: image, width: image.naturalWidth, height: image.naturalHeight };
  } catch (error) {
    console.warn('InkPad: unsupported image file', error);
    return null;
  }
}

export function registerAssetImage(assetId: ID, bitmap: ImageBitmap | HTMLImageElement): void {
  bitmaps.set(assetId, bitmap);
}

export function clearAssetImages(): void {
  for (const bitmap of bitmaps.values()) {
    if (typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap) bitmap.close();
  }
  bitmaps.clear();
}
