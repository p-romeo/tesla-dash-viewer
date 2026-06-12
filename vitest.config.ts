import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Everything under test is pure logic (no DOM rendering), so the node
// environment suffices — SyncEngine tests stub rAF/video elements themselves.
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
