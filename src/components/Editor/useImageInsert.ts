/** Inserts images from the file picker, a drop, or the clipboard onto the current page. */

import { useCallback } from 'react';
import { InsertObjectsCommand } from '@/core/commands';
import { imageObject } from '@/core/objects';
import { newAssetId } from '@/core/commands';
import { decodeImageFile, registerAssetImage } from '@/render/assetImages';
import { putAsset } from '@/data/repository';
import { useEditor } from '@/state/editorStore';

export interface UseImageInsertOptions {
  onMessage?(message: string): void;
}

export function useImageInsert({ onMessage }: UseImageInsertOptions = {}) {
  const insertImage = useCallback(
    async (file: File | Blob, name = 'image') => {
      const store = useEditor.getState();
      const page = store.doc?.pages[store.currentPageIndex];
      if (!page) {
        onMessage?.('Open a page first');
        return;
      }
      const decoded = await decodeImageFile(file);
      if (!decoded) {
        onMessage?.('That image format is not supported');
        return;
      }
      const assetId = newAssetId();
      const mime = file.type || 'image/png';
      await putAsset(
        {
          id: assetId,
          kind: 'image',
          name,
          mime,
          width: decoded.width,
          height: decoded.height,
          createdAt: Date.now(),
        },
        file instanceof File ? file : new Blob([file], { type: mime }),
      );
      registerAssetImage(assetId, decoded.bitmap);
      const object = imageObject(assetId, { width: decoded.width, height: decoded.height }, {
        x: page.data.width / 2,
        y: page.data.height / 2,
      });
      store.commit(
        new InsertObjectsCommand(page.id, [{ object, index: page.objects.length }], 'Insert image'),
        { structural: true },
      );
      store.setTool('lasso');
      store.setSelection([object.id]);
      onMessage?.('Image inserted');
    },
    [onMessage],
  );

  const insertImageFromFile = insertImage;
  const pasteImageFromClipboard = insertImage;

  return { insertImage, insertImageFromFile, pasteImageFromClipboard };
}
