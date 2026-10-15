/** App shell: theme wiring, settings hydration and hash routing. */

import { useEffect } from 'react';
import { LibraryScreen } from '@/components/Library/LibraryScreen';
import { EditorScreen } from '@/components/Editor/EditorScreen';
import { navigate, useRoute } from '@/state/router';
import { resolveDark, useSettings } from '@/state/settings';

export default function App() {
  const route = useRoute();
  const theme = useSettings((state) => state.theme);
  const hydrate = useSettings((state) => state.hydrate);
  const hydrated = useSettings((state) => state.hydrated);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const apply = () => document.documentElement.classList.toggle('dark', resolveDark(theme));
    apply();
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
        <span className="text-sm text-ink-500">Starting InkPad…</span>
      </div>
    );
  }

  if (route.name === 'notebook') {
    return (
      <EditorScreen
        notebookId={route.id}
        onClose={() => navigate({ name: 'library' })}
      />
    );
  }

  return <LibraryScreen onOpenNotebook={(id) => navigate({ name: 'notebook', id })} />;
}
