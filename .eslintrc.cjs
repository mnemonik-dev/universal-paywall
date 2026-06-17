module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./packages/middleware/tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  plugins: ['@typescript-eslint'],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'cache/',
    'artifacts/',
    'typechain-types/',
    'coverage/',
    'contracts/',
    'apps/',
    '**/*.cjs',
    '**/tsup.config.ts',
    // Test files are excluded from the middleware tsconfig (build excludes
    // __tests__); ESLint with typed-linting cannot parse files outside the
    // referenced project. Vitest enforces correctness on these files.
    'packages/middleware/src/__tests__/',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': 'warn',
    '@typescript-eslint/no-explicit-any': 'warn',
  },
};
