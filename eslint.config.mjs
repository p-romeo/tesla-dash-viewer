import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    // Build output, packaging output, and the git-ignored sample footage.
    ignores: ['out/**', 'releases/**', 'build/**', 'TeslaCam/**', 'TeslaTrackMode/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // React hooks correctness only applies to renderer code.
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules
  },
  {
    // Tailwind/PostCSS configs are CommonJS files run by Node.
    files: ['*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' }
    }
  },
  {
    rules: {
      // tsconfig already enforces noUnusedLocals/noUnusedParameters; mirror its
      // underscore-prefix escape hatch instead of double-flagging.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  }
)
