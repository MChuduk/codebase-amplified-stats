import type { ContentScriptContext } from '#imports';
import ReactDOM from 'react-dom/client';
import type { Provider } from '../common';
import { Panel } from './Panel';

/**
 * Mounting the panel into a host's page.
 *
 * Nothing here is specific to any one host: each provider's content script supplies its
 * own way of locating an anchor, and the rest — SPA navigation, re-mounting when the page
 * re-renders, tearing down cleanly — is the same everywhere.
 */

export interface AnchorMatch {
  element: Element;
  /** Which strategy matched, so a better one appearing later can trigger a re-mount. */
  strategy: string;
}

export interface AnchorAdapter {
  findAnchor(): AnchorMatch | null;
  waitForAnchor(signal: AbortSignal): Promise<AnchorMatch | null>;
  /** Lower is better. */
  strategyRank(strategy: string): number;
}

interface ActiveUi {
  remove: () => void;
  isConnected: () => boolean;
  remount: () => void;
  anchorStrategy: string;
}

let active: ActiveUi | null = null;
let pendingMount: AbortController | null = null;
let sidebarObserver: MutationObserver | null = null;

/**
 * Mounts the panel, and keeps it mounted.
 *
 * Hosts like GitHub are Turbo/SPA apps: navigating between repositories never reloads the
 * content script, so the caller re-invokes this on every location change and the previous
 * panel is torn down first.
 */
export async function mountPanel(
  ctx: ContentScriptContext,
  provider: Provider,
  anchor: AnchorAdapter,
): Promise<void> {
  pendingMount?.abort();
  pendingMount = new AbortController();
  const { signal } = pendingMount;

  teardown();

  const url = new URL(location.href);
  const repo = provider.parseRepoUrl(url);
  // The sidebar only exists on the landing page; other sub-pages have nowhere to put it.
  if (!repo || !provider.isRepoHomePage(url)) return;

  const found = await anchor.waitForAnchor(signal);
  if (signal.aborted) return;
  if (!found) {
    console.warn('[amplified-stats] no sidebar anchor found, skipping mount');
    return;
  }

  const ui = await createShadowRootUi(ctx, {
    name: 'amplified-stats-panel',
    position: 'inline',
    // Resolved as a function rather than a fixed element: the host's own framework
    // re-renders the sidebar while we are setting up, which detaches whatever element we
    // found earlier. A stale anchor has no parent, and insertion would silently do nothing.
    anchor: () => anchor.findAnchor()?.element ?? null,
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
    anchorStrategy: anchor.findAnchor()?.strategy ?? found.strategy,
  };

  // The sidebar renders progressively and re-renders as the user interacts, which can
  // either drop the panel or leave it anchored above the block it belongs under.
  sidebarObserver = new MutationObserver(() => {
    if (!active) return;

    const best = anchor.findAnchor();
    if (!best) return;

    const misplaced =
      anchor.strategyRank(best.strategy) < anchor.strategyRank(active.anchorStrategy);
    if (!active.isConnected() || misplaced) {
      active.anchorStrategy = best.strategy;
      active.remount();
    }
  });
  sidebarObserver.observe(document.body, { childList: true, subtree: true });
}

function teardown() {
  sidebarObserver?.disconnect();
  sidebarObserver = null;
  active?.remove();
  active = null;
}
