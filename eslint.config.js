import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // .head-worktree/ is the before-copy for the ADR-039 fuzz check, a whole
    // second checkout; ESLint does not read .gitignore.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.head-worktree/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
);
