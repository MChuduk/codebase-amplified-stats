import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

/**
 * Without a client ID nobody can sign in, and every request the extension makes is
 * authenticated — so the artefact would be inert. `pnpm dev` only warns, to keep the rest
 * of the extension workable while the OAuth app is being set up.
 *
 * Called from `build:before` rather than the vite config so that `wxt prepare`, which runs
 * on every `pnpm install`, is not caught by it.
 */
function checkClientId(mode: string): void {
  if (process.env.WXT_GITHUB_CLIENT_ID) return;

  const message =
    'WXT_GITHUB_CLIENT_ID is not set. Create an OAuth App at ' +
    'https://github.com/settings/developers with Device Flow enabled, then build with ' +
    'WXT_GITHUB_CLIENT_ID=<client id> pnpm build.';

  if (mode === 'production') throw new Error(message);
  console.warn(`\n[amplified-stats] ${message}\n`);
}

// https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  manifest: {
    name: 'Codebase Amplified Stats',
    description:
      'Real lines-of-code statistics per language for GitHub repositories, with vendored and generated files filtered out.',
    permissions: ['storage', 'offscreen'],
    host_permissions: [
      // REST metadata, and the archive request that redirects to codeload.
      'https://api.github.com/*',
      // OAuth Device Flow endpoints.
      'https://github.com/login/*',
      // Where the archive request lands after its redirect.
      'https://codeload.github.com/*',
    ],
  },
  hooks: {
    'build:before': (wxt) => checkClientId(wxt.config.mode),
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
