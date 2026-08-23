import type { ContentScriptContext } from '#imports';
import ReactDOM from 'react-dom/client';
import type { Provider } from '../common';
import { sendRequest } from '../messaging/messages';
import { onTokensChanged } from '../logic/settings';
import { Panel } from './Panel';

/**
 * Mounting the panel into a host's page.
 *
 * Nothing here is specific to any one host: each provider's content script supplies its
 * own way of locating an anchor, and the rest — SPA navigation, keeping the panel pinned
 * when the page re-renders, tearing down cleanly — is the same everywhere.
 */

export interface AnchorAdapter {
  /** The single element the panel is inserted after, or null if it is not on the page. */
  findAnchor(): Element | null;
  waitForAnchor(signal: AbortSignal): Promise<Element | null>;
}

interface ActiveUi {
  remove: () => void;
  /** True while the panel sits immediately after a still-attached anchor. */
  isPinned: () => boolean;
  attach: () => void;
}

let active: ActiveUi | null = null;
let pendingMount: AbortController | null = null;
let sidebarObserver: MutationObserver | null = null;
let stopTokenWatch: (() => void) | null = null;

/**
 * Mounts the panel, and keeps it mounted.
 *
 * Hosts like GitHub are Turbo/SPA apps: navigating between repositories never reloads the
 * content script, so the caller re-invokes this on every location change and the previous
 * panel is torn down first.
 *
 * `url` is the page being navigated *to*, which the caller has to supply: a location
 * change is announced before the navigation commits, so `location.href` still names the
 * page being left and neither the URL nor the DOM can be trusted to describe the target
 * yet. The anchor is waited for, so arriving before the new page renders is fine.
 *
 * Nothing is mounted while the user is signed out: every request the engine makes is
 * authenticated, so a panel there could only ever say so.
 */
export async function mountPanel(
  ctx: ContentScriptContext,
  provider: Provider,
  anchor: AnchorAdapter,
  url: URL,
): Promise<void> {
  pendingMount?.abort();
  pendingMount = new AbortController();
  const { signal } = pendingMount;

  unmountPanel();

  if (!ctx.isValid) return;

  const repo = provider.parseRepoUrl(url);
  // The sidebar only exists on the landing page; other sub-pages have nowhere to put it.
  if (!repo || !provider.isRepoHomePage(url)) return;

  // Signing in from the options page has to bring the panel up without a page reload, and
  // a token the host rejects mid-run has to take it away again.
  stopTokenWatch = onTokensChanged(() => {
    void mountPanel(ctx, provider, anchor, new URL(location.href));
  });

  if (!(await isSignedIn(provider))) return;
  if (signal.aborted || !ctx.isValid) return;

  const found = await anchor.waitForAnchor(signal);
  if (signal.aborted || !ctx.isValid) return;
  if (!found) {
    console.warn('[amplified-stats] no sidebar anchor found, skipping mount');
    return;
  }

  // Kept across attachments so re-pinning the panel reuses the same React root: a second
  // createRoot on the same container would orphan the first and lose the state of a run
  // in progress.
  let root: ReactDOM.Root | null = null;

  const ui = await createShadowRootUi(ctx, {
    name: 'amplified-stats-panel',
    position: 'inline',
    // Resolved as a function rather than a fixed element: the host's own framework
    // re-renders the sidebar while we are setting up, which detaches whatever element we
    // found earlier. A stale anchor has no parent, and insertion would silently do nothing.
    anchor: () => anchor.findAnchor(),
    append: 'after',
    onMount(container) {
      root ??= ReactDOM.createRoot(container);
      root.render(<Panel repo={repo} />);
      return root;
    },
    onRemove() {
      root?.unmount();
      root = null;
    },
  });

  if (signal.aborted || !ctx.isValid) {
    ui.remove();
    return;
  }

  // Whatever the panel ended up after, read back from the DOM. Comparing against it is an
  // O(1) check the mutation observer can afford to run on every sidebar change.
  let anchoredTo: Element | null = null;

  const state: ActiveUi = {
    remove: () => ui.remove(),
    isPinned: () =>
      anchoredTo !== null &&
      anchoredTo.isConnected &&
      anchoredTo.nextElementSibling === ui.shadowHost,
    attach: () => {
      if (!anchor.findAnchor()) return;
      try {
        ui.mount();
        anchoredTo = ui.shadowHost.previousElementSibling;
      } catch (error) {
        // WXT throws when the anchor it resolves has gone in the meantime. GitHub
        // re-renders the sidebar often enough for that to be routine, and the observer
        // below retries, so a failed attempt must not abort the whole mount.
        console.warn('[amplified-stats] anchor vanished while mounting', error);
        anchoredTo = null;
      }
    },
  };

  active = state;
  state.attach();

  // The sidebar renders progressively and re-renders as the user interacts, which detaches
  // the panel or leaves it sitting after something other than the block it belongs under.
  sidebarObserver = new MutationObserver(() => {
    if (!active) return;

    // The host swaps the DOM for a client-side navigation before it updates the location,
    // so without this the re-attachment below would land the panel on whatever page is
    // now rendered.
    if (!provider.isRepoHomePage(new URL(location.href))) {
      unmountPanel();
      return;
    }

    if (!active.isPinned()) active.attach();
  });
  sidebarObserver.observe(document.body, { childList: true, subtree: true });
}

export function unmountPanel() {
  stopTokenWatch?.();
  stopTokenWatch = null;
  sidebarObserver?.disconnect();
  sidebarObserver = null;
  active?.remove();
  active = null;
}

async function isSignedIn(provider: Provider): Promise<boolean> {
  const response = await sendRequest<boolean>({ kind: 'signed-in', provider: provider.id });
  return response.ok && response.data;
}
