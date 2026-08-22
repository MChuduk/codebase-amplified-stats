import '../../src/ui/style.css';
import * as anchor from '../../src/providers/github/anchor';
import { mountPanel } from '../../src/ui/mount';
import { github } from '../../src/providers/github';

/**
 * Thin per-host shell. `matches` has to be static in the manifest, so every provider needs
 * its own content script — but all of them are this short.
 */
export default defineContentScript({
  matches: ['*://github.com/*'],
  cssInjectionMode: 'ui',
  runAt: 'document_idle',

  main(ctx) {
    const safeMount = () => {
      mountPanel(ctx, github, anchor).catch((error: unknown) => {
        // Never let a mounting failure surface as an unhandled rejection on the host's page.
        console.warn('[amplified-stats] mount failed', error);
      });
    };

    safeMount();
    ctx.addEventListener(window, 'wxt:locationchange', safeMount);
  },
});
