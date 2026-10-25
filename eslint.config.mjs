import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/drizzle/**', 'apps/web/src/components/ui/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/server/**', '@scm/server', '@scm/server/*'], message: 'Browser-facing code must not import server modules.' }
        ]
      }]
    }
  },
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/apps/**', '@scm/*'], message: 'Shared contracts must not import application modules.' }
        ]
      }]
    }
  }
);
