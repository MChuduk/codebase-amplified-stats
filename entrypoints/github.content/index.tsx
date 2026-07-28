import ReactDOM from 'react-dom/client';
import '../../src/ui/style.css';
import { Panel } from '../../src/ui/Panel';
import { findAnchor, strategyRank, waitForAnchor } from '../../src/ui/anchor';
import { isRepoHomePage, parseRepoUrl } from '../../src/core/repo-url';
import type { ContentScriptContext } from '#imports';

export default defineContentScript({
  matches: ['*://github.com/*'],
  cssInjectionMode: 'ui',
  runAt: 'document_idle',

  main(ctx) {
    const safeMount = () => {
      mount(ctx).catch((error: unknown) => {
        // Never let a mounting failure surface as an unhandled rejection on GitHub's page.
        console.warn('[amplified-stats] mount failed', error);
      });
    };

    safeMount();

    // GitHub is a Turbo SPA: navigating between repos never reloads the content script,
    // so the panel has to be torn down and rebuilt on every location change.
    ctx.addEventListener(window, 'wxt:locationchange', safeMount);
  },
});

interface ActiveUi {
  remove: () => void;
  isConnected: () => boolean;
  remount: () => void;
  /** Which anchor strategy the panel is currently sitting on. */
  strategy: string;
}

/** The UI currently on the page, so a re-mount can remove it first. */
let active: ActiveUi | null = null;
/** Aborts an in-flight wait when navigation happens mid-wait. */
let pending: AbortController | null = null;
/** Watches for GitHub re-rendering the sidebar out from under us. */
let guard: MutationObserver | null = null;

async function mount(ctx: ContentScriptContext) {
  const url = location.href;

  pending?.abort();
  pending = new AbortController();
  const { signal } = pending;

  teardown();

  const repo = parseRepoUrl(url);
  // The sidebar only exists on the repo landing page; other repo sub-pages have nowhere
  // to put the panel.
  if (!repo || !isRepoHomePage(url)) return;

  const found = await waitForAnchor(signal);
  if (signal.aborted) return;
  if (!found) {
    console.warn('[amplified-stats] no sidebar anchor found, skipping mount');
    return;
  }

  const ui = await createShadowRootUi(ctx, {
    name: 'amplified-stats-panel',
    position: 'inline',
    // Resolved as a function rather than a fixed element: GitHub's React re-renders the
    // sidebar while we are setting up, which detaches whatever element we found earlier.
    // A stale anchor has no parent, and insertion would silently do nothing.
    anchor: () => findAnchor()?.element ?? null,
    append: 'after',
    onMount(container) {
      const root = ReactDOM.createRoot(container);
      root.render(<Panel repo={repo} />);
      return root;
    },
    onRemove(root) {
      root?.unmount();
    },
  });

  if (signal.aborted) {
    ui.remove();
    return;
  }

  ui.mount();

  active = {
    remove: () => ui.remove(),
    isConnected: () => ui.shadowHost.isConnected,
    remount: () => ui.mount(),
    strategy: findAnchor()?.strategy ?? found.strategy,
  };

  // GitHub renders the sidebar progressively and re-renders parts of it as you interact,
  // which can either drop the panel or leave it anchored above the Languages block it
  // belongs under. Re-mount when either happens.
  guard = new MutationObserver(() => {
    if (!active) return;

    const best = findAnchor();
    if (!best) return;

    const misplaced = strategyRank(best.strategy) < strategyRank(active.strategy);
    if (!active.isConnected() || misplaced) {
      active.strategy = best.strategy;
      active.remount();
    }
  });
  guard.observe(document.body, { childList: true, subtree: true });
}

function teardown() {
  guard?.disconnect();
  guard = null;
  active?.remove();
  active = null;
}
