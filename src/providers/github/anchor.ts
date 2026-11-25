// GitHub serves several CSS-module naming formats, with the build hash on either side
// of `sidebarSection`. The classic sidebar uses a plain class name.
const SIDEBAR_SECTION = [
  '[class*="sidebarSection__"]',
  '[class*="SidebarSection-module_"][class*="_sidebarSection"]',
  '.BorderGrid-row',
].join(', ');

function enclosingSection(element: Element): Element | null {
  return element.closest(SIDEBAR_SECTION);
}

/** Only works on English-language pages, so it is not the only way we look. */
function byLanguagesHeading(): Element | null {
  for (const heading of document.querySelectorAll('h2, h3')) {
    if (heading.textContent?.trim().toLowerCase() !== 'languages') continue;
    const section = enclosingSection(heading);
    if (section) return section;
  }
  return null;
}

/**
 * The per-language links inside the languages bar, which point at
 * `/{owner}/{repo}/search?l={language}`. Language-independent, unlike the heading.
 */
function byLanguageSearchLink(): Element | null {
  const link = document.querySelector('a[href*="/search?l="]');
  return link ? enclosingSection(link) : null;
}

/** The Languages section, which the panel is inserted after. */
export function findAnchor(): Element | null {
  return byLanguagesHeading() ?? byLanguageSearchLink();
}

/**
 * Waits for the Languages section to appear. GitHub renders the sidebar asynchronously
 * after Turbo navigations, so it is usually absent when the content script first runs.
 */
export function waitForAnchor(signal: AbortSignal, timeoutMs = 15_000): Promise<Element | null> {
  return new Promise((resolve) => {
    const immediate = findAnchor();
    if (immediate) {
      resolve(immediate);
      return;
    }

    const finish = (result: Element | null) => {
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
