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
  boundary(['src/core/**'], ['**/saeckel/**'], 'Core does not import Säckel (ARCHITECTURE.md §2).'),
  boundary(
    ['src/saeckel/**'],
    ['**/core/**', '**/main.ts'],
    'Säckel gets what it needs from main.ts, not from Core (ARCHITECTURE.md §2).',
  ),
);
