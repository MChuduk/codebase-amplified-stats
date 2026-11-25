import type { RepoRef } from '../../common';

// GitHub serves several CSS-module naming formats, with the build hash on either side
// of `sidebarSection`. The classic sidebar uses a plain class name.
const SIDEBAR_SECTION = [
  '[class*="sidebarSection__"]',
  '[class*="SidebarSection-module_"][class*="_sidebarSection"]',
  '.BorderGrid-row',
].join(', ');
const SIDEBAR_PANE = '[data-component="SplitPageLayout.Pane"], [data-component="PageLayout.Pane"]';
const SIDEBAR_GRID = '[class*="borderGrid"], .BorderGrid';

function enclosingSection(element: Element): Element | null {
  const knownSection = element.closest(SIDEBAR_SECTION);
  if (knownSection) return knownSection;

  const pane = element.closest(SIDEBAR_PANE);
  if (!pane) return null;

  const grid = element.closest(SIDEBAR_GRID);
  const container = grid && pane.contains(grid) ? grid : pane;
  let section = element;
  while (section.parentElement && section.parentElement !== container) {
    section = section.parentElement;
  }
  return section;
}

/** Only works on English-language pages, so it is not the only way we look. */
function byLanguagesHeading(): Element | null {
  for (const heading of document.querySelectorAll('h2, h3, [role="heading"]')) {
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
  for (const link of document.querySelectorAll('a[href*="/search?l="]')) {
    const section = enclosingSection(link);
    if (section) return section;
  }
  return null;
}

/** The Languages section, which the panel is inserted after. */
export function findAnchor(repo: RepoRef): Element | null {
  const repoPath = document.querySelector<HTMLAnchorElement>('a#code-view-repo-link')?.pathname;
  if (
    repoPath &&
    repoPath.replace(/\/$/, '').toLowerCase() !== `/${repo.owner}/${repo.repo}`.toLowerCase()
  ) {
    return null;
  }

  if (repo.ref) {
    const picker = document.querySelector(
      '#ref-picker-repos-header-ref-selector, .overview-ref-selector',
    );
    const label = picker?.querySelector(
      '.ref-selector-button-text-container, [data-component="text"]',
    );
    const selectedRef = label?.textContent?.trim();
    if (selectedRef && selectedRef !== repo.ref) return null;
  }

  return byLanguagesHeading() ?? byLanguageSearchLink();
}

/**
 * Waits for the Languages section to appear. GitHub renders the sidebar asynchronously
 * after Turbo navigations, so it is usually absent when the content script first runs.
 */
export function waitForAnchor(
  repo: RepoRef,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<Element | null> {
  if (signal.aborted) return Promise.resolve(null);

  return new Promise((resolve) => {
    const immediate = findAnchor(repo);
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
      const match = findAnchor(repo);
      if (match) finish(match);
    });

    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);

    signal.addEventListener('abort', onAbort);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  });
}
