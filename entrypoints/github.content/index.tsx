import '../../src/ui/style.css';
import * as anchor from '../../src/providers/github/anchor';
import { mountPanel, unmountPanel } from '../../src/ui/mount';
import { github } from '../../src/providers/github';

/**
 * Thin per-host shell. `matches` has to be static in the manifest, so every provider needs
 * its own content script — but all of them are this short.
 */
export default defineContentScript({
  matches: ['https://github.com/*'],
  cssInjectionMode: 'ui',
  runAt: 'document_idle',

  main(ctx) {
    const safeMount = (url: URL) => {
      mountPanel(ctx, github, anchor, url).catch((error: unknown) => {
        // Never let a mounting failure surface as an unhandled rejection on the host's page.
        // Reloading or updating the extension orphans this script against a dead runtime,
        // which nothing here can recover from — the page has to be reloaded.
        if (isContextInvalidated(error)) return;
        console.warn('[amplified-stats] mount failed', error);
      });
    };

    safeMount(new URL(location.href));
    ctx.addEventListener(window, 'wxt:locationchange', (event) => safeMount(event.newUrl));
    ctx.onInvalidated(unmountPanel);
  },
});

function isContextInvalidated(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Extension context invalidated');
}
