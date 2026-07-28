/**
 * Finding where to inject the panel on a GitHub repository page.
 *
 * GitHub's markup is not a public API. It now ships Primer CSS modules whose class names
 * carry a build hash — `SidebarSection-module__sidebarSection__e8jFN` — so we match on the
 * stable prefix and never on the whole name. The older `.BorderGrid-row` markup is still
 * matched too, since GitHub Enterprise lags the public site by months.
 *
 * Every strategy is allowed to fail: if none matches we mount nothing rather than risk
 * breaking the page.
 */

export interface AnchorMatch {
  /** The element our panel is inserted after. */
  element: Element;
  /** Which strategy matched — logged so breakage after a redesign is diagnosable. */
  strategy: string;
}

/** Matches a Primer CSS-module class by its hash-free prefix. */
const MODULE_CLASS = {
  sidebarSection: '[class*="SidebarSection-module__sidebarSection"]',
  sidebarGrid: '[class*="CodeViewSidebar-module__borderGrid"]',
  pane: '[class*="PageLayout-Pane"]',
} as const;

/** The section wrapper a given element sits in, in either markup generation. */
function enclosingSection(element: Element): Element | null {
  return element.closest(`${MODULE_CLASS.sidebarSection}, .BorderGrid-row`);
}

/**
 * Strategy 1: the "Languages" heading. Semantically the right anchor — our panel belongs
 * directly below that block. Only works on English-language pages.
 */
function byLanguagesHeading(): Element | null {
  for (const heading of document.querySelectorAll('h2, h3')) {
    if (heading.textContent?.trim().toLowerCase() !== 'languages') continue;
    const section = enclosingSection(heading);
    if (section) return section;
  }
  return null;
}

/**
 * Strategy 2: the per-language links inside the languages bar, which point at
 * `/{owner}/{repo}/search?l={language}`. Language-independent, unlike the heading.
 */
function byLanguageSearchLink(): Element | null {
  const link = document.querySelector('a[href*="/search?l="]');
  return link ? enclosingSection(link) : null;
}

/** Strategy 3: give up on locating Languages and append after the last sidebar section. */
function byLastSidebarSection(): Element | null {
  const sections = document.querySelectorAll(
    `${MODULE_CLASS.sidebarGrid} ${MODULE_CLASS.sidebarSection}, .Layout-sidebar .BorderGrid-row`,
  );
  return sections.length > 0 ? (sections[sections.length - 1] ?? null) : null;
}

/** Strategy 4: last resort — the sidebar pane itself, so the panel at least appears. */
function byPane(): Element | null {
  const pane = document.querySelector(`${MODULE_CLASS.pane}, .Layout-sidebar`);
  return pane?.lastElementChild ?? null;
}

/** Ordered best to worst; the first two land the panel directly under Languages. */
const STRATEGIES: Array<[string, () => Element | null]> = [
  ['languages-heading', byLanguagesHeading],
  ['language-search-link', byLanguageSearchLink],
  ['last-sidebar-section', byLastSidebarSection],
  ['sidebar-pane', byPane],
];

export function findAnchor(): AnchorMatch | null {
  for (const [strategy, find] of STRATEGIES) {
    const element = find();
    if (element) return { element, strategy };
  }
  return null;
}

/**
 * How good a strategy is, lower being better. The sidebar renders progressively, so a
 * mount can land on a fallback anchor while the Languages block is still on its way —
 * comparing ranks lets the caller move the panel once the better anchor shows up.
 */
export function strategyRank(strategy: string): number {
  const index = STRATEGIES.findIndex(([name]) => name === strategy);
  return index === -1 ? STRATEGIES.length : index;
}

/**
 * Waits for the anchor to appear. GitHub renders the sidebar asynchronously after Turbo
 * navigations, so it is usually absent when the content script first runs.
 */
export function waitForAnchor(
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<AnchorMatch | null> {
  return new Promise((resolve) => {
    const immediate = findAnchor();
    if (immediate) {
      resolve(immediate);
      return;
    }

    const finish = (result: AnchorMatch | null) => {
      observer.disconnect();
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const observer = new MutationObserver(() => {
      const match = findAnchor();
      if (match) finish(match);
    });

    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);

    signal.addEventListener('abort', onAbort);
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
