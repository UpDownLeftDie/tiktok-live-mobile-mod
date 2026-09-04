import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    'apps/worker/.wrangler/**',
    'apps/worker/client/dist/**',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'sonarjs/todo-tag': 'off',
      'sonarjs/no-commented-code': 'off',
      'sonarjs/cognitive-complexity': ['error', 20],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'SpreadElement > LogicalExpression[operator="??"] > ObjectExpression[properties.length=0]',
          message:
            'Empty object fallback in a spread is a no-op. Spread the value directly; undefined is ignored.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
