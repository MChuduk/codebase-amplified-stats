import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  manifest: {
    name: 'GitHub Amplified Stats',
    description:
      'Real lines-of-code statistics per language for GitHub repositories, with vendored and generated files filtered out.',
    permissions: ['storage', 'offscreen'],
    host_permissions: [
      'https://api.github.com/*',
      'https://github.com/*',
      'https://raw.githubusercontent.com/*',
    ],
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
