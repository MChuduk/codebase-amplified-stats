import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['.output/**', '.wxt/**', 'node_modules/**', 'src/logic/languages.generated.ts'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      'max-len': [
        'error',
        {
          code: 180,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
        },
      ],
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
    },
  },

  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  {
    // Node scripts and config, not browser code.
    files: ['scripts/**/*.ts', 'eslint.config.js', 'wxt.config.ts'],
    languageOptions: { globals: globals.node },
  },

  // This file sits outside tsconfig's project, so type-aware rules have nothing to read.
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
