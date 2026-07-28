import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXTENSION = resolve(import.meta.dirname, '../.output/chrome-mv3');
const REPO_URL = process.argv[2] ?? 'https://github.com/sindresorhus/got';

const profile = mkdtempSync(join(tmpdir(), 'gas-profile-'));

// Extensions are only fully supported in headed Chrome; headless shell also gets
// throttled by GitHub with 503s.
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  channel: 'chromium',
  viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});

const log: string[] = [];
context.on('console', (message) => {
  if (message.type() === 'error' || message.text().includes('amplified')) {
    log.push(`[console.${message.type()}] ${message.text()}`);
  }
});
context.on('weberror', (error) => log.push(`[page error] ${error.error().message}`));

try {
  // The service worker registers a moment after launch.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  console.log(`service worker: ${worker.url()}`);

  const page = await context.newPage();

  // Record every add and remove of our host element, to tell "never mounted" apart from
  // "mounted then wiped out by GitHub's own React re-render".
  await page.addInitScript(`
    window.__gasEvents = [];
    const startObserving = () => new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeName && node.nodeName.toLowerCase() === 'amplified-stats-panel') {
            window.__gasEvents.push('added @' + Math.round(performance.now()));
          }
        }
        for (const node of record.removedNodes) {
          if (node.nodeName && node.nodeName.toLowerCase() === 'amplified-stats-panel') {
            window.__gasEvents.push('removed @' + Math.round(performance.now()));
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

    if (document.documentElement) startObserving();
    else document.addEventListener('readystatechange', () => {
      if (document.documentElement) startObserving();
    }, { once: true });
  `);

  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && text.includes('503')) return; // GitHub CDN noise
    log.push(`[page console.${message.type()}] ${text}`);
  });

  await page.goto(REPO_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Report what the page actually looks like before asserting on our own markup, so a
  // GitHub redesign is distinguishable from a bug in the extension.
  const dom = await page.evaluate(() => ({
    title: document.title,
    sidebar: Boolean(document.querySelector('.Layout-sidebar')),
    borderGridRows: document.querySelectorAll('.BorderGrid-row').length,
    languagesHeading: [...document.querySelectorAll('h2, h3')].some(
      (h) => h.textContent?.trim().toLowerCase() === 'languages',
    ),
    languageSearchLink: Boolean(document.querySelector('a[href*="/search?l="]')),
  }));
  console.log('page:', JSON.stringify(dom));

  // List custom elements actually present, so a renamed host tag is obvious.
  const customElements = await page.evaluate(
    `[...document.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()).filter((t) => t.includes('-')).filter((t, i, a) => a.indexOf(t) === i)`,
  );
  console.log('custom elements on page:', JSON.stringify(customElements));

  // The panel lives inside a shadow root; Playwright pierces shadow DOM by default.
  const panel = page.locator('amplified-stats-panel').first();
  try {
    await panel.waitFor({ state: 'attached', timeout: 30_000 });
  } finally {
    console.log('host element events:', JSON.stringify(await page.evaluate('window.__gasEvents')));
  }
  console.log('panel: mounted into the sidebar');

  const placement = await page.evaluate(`(() => {
    const host = document.querySelector('amplified-stats-panel');
    if (!host) return null;
    const label = (el) => el ? (el.tagName.toLowerCase() + ' :: ' + (el.textContent || '').trim().slice(0, 45)) : null;
    const parent = host.parentElement;
    return {
      previousSibling: label(host.previousElementSibling),
      nextSibling: label(host.nextElementSibling),
      parentClass: parent ? parent.className.slice(0, 80) : null,
      siblingOrder: parent ? [...parent.children].map((c) =>
        (c.tagName.toLowerCase() === 'amplified-stats-panel' ? '>>> PANEL' : (c.textContent || '').trim().slice(0, 30))
      ) : [],
    };
  })()`);
  console.log('placement:', JSON.stringify(placement, null, 2));

  // DOM order and visual order can differ under CSS grid/flex, so compare actual
  // vertical positions of each sidebar section.
  const layout = await page.evaluate(`(() => {
    const host = document.querySelector('amplified-stats-panel');
    const parent = host && host.parentElement;
    if (!parent) return null;
    return [...parent.children].map((c) => ({
      label: c.tagName.toLowerCase() === 'amplified-stats-panel' ? '>>> PANEL' : (c.textContent || '').trim().slice(0, 22),
      top: Math.round(c.getBoundingClientRect().top + window.scrollY),
    })).sort((a, b) => a.top - b.top);
  })()`);
  console.log('visual order:', JSON.stringify(layout));

  const heading = await panel.locator('h2').first().textContent();
  console.log(`panel heading: ${heading}`);

  // Wait for the preview to resolve into either a count button or an error.
  const button = panel.getByRole('button', { name: /count lines/i });
  const error = panel.locator('p.text-\\[var\\(--fgColor-danger\\,#d1242f\\)\\]');

  await Promise.race([
    button.waitFor({ state: 'visible', timeout: 45_000 }),
    error.waitFor({ state: 'visible', timeout: 45_000 }),
  ]);

  if (await error.isVisible()) {
    console.log(`preview error: ${await error.textContent()}`);
  } else {
    console.log(`preview: "${(await panel.locator('p').first().textContent())?.trim()}"`);

    await button.click();
    console.log('clicked Count lines, waiting for the run…');

    // The total appears as a large number once counting finishes.
    const total = panel.locator('p.text-xl');
    await total.waitFor({ state: 'visible', timeout: 180_000 });
    console.log(`RESULT: ${await total.textContent()} lines of code`);

    const rows = await panel.locator('table tbody tr').all();
    console.log(`languages listed: ${rows.length}`);
    for (const row of rows.slice(0, 5)) {
      console.log(`  ${(await row.textContent())?.replace(/\s+/g, ' ').trim()}`);
    }
  }

  await panel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: '.output/panel.png', fullPage: false });
  console.log('screenshot written');

  // Reload and confirm the cached result comes straight back with no counting step:
  // the blob-SHA cache is the difference between a 3-second wait and an instant answer.
  console.log('\nreloading to check the cache…');
  const reloadStart = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });

  const cachedPanel = page.locator('amplified-stats-panel').first();
  await cachedPanel.waitFor({ state: 'attached', timeout: 30_000 });
  const cachedTotal = cachedPanel.locator('p.text-xl');
  await cachedTotal.waitFor({ state: 'visible', timeout: 30_000 });
  console.log(
    `cached result: ${await cachedTotal.textContent()} lines, shown ${((Date.now() - reloadStart) / 1000).toFixed(1)}s after reload (no Count click)`,
  );
} catch (error) {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (log.length) {
    console.log('\n--- console/errors ---');
    for (const line of log.slice(0, 25)) console.log(line);
  }
  await context.close();
}
