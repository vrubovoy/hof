import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// ARCHITECTURE.md §2: Core and Säckel do not import each other; only src/main.ts knows both. The
// rule covers their tests as well.
const boundary = (files, group, message) => ({
  files,
  rules: { 'no-restricted-imports': ['error', { patterns: [{ group, message }] }] },
});

export default defineConfig(
  globalIgnores(['design/', '_discard/', '_reserve/']),
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // node:test's test() and describe() return promises that the runner awaits itself.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'test'] },
          ],
        },
      ],
    },
  },
  // The scripts of the browser (ARCHITECTURE.md §6): ESLint's own rules, no type checking, and
  // only the globals of a page that they use. fx-head.js is an ordinary script, fx.js a module.
  {
    files: ['src/**/static/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        AudioContext: 'readonly',
        Audio: 'readonly',
        Element: 'readonly',
        HTMLAnchorElement: 'readonly',
        HTMLElement: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLMediaElement: 'readonly',
        Image: 'readonly',
        URL: 'readonly',
        addEventListener: 'readonly',
        clearTimeout: 'readonly',
        document: 'readonly',
        getComputedStyle: 'readonly',
        innerHeight: 'readonly',
        innerWidth: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        matchMedia: 'readonly',
        navigator: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        sessionStorage: 'readonly',
        setTimeout: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      eqeqeq: 'error',
      'no-implicit-globals': 'error',
      'no-undef': 'error',
      'no-unused-vars': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  { files: ['src/**/static/fx-head.js'], languageOptions: { sourceType: 'script' } },
  boundary(['src/core/**'], ['**/saeckel/**'], 'Core does not import Säckel (ARCHITECTURE.md §2).'),
  boundary(
    ['src/saeckel/**'],
    ['**/core/**', '**/main.ts'],
    'Säckel gets what it needs from main.ts, not from Core (ARCHITECTURE.md §2).',
  ),
);
