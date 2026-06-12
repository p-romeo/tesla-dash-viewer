import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Production CSP, injected into the built index.html only. Dev must stay
// CSP-free: @vitejs/plugin-react's refresh preamble is an inline script and HMR
// needs a websocket — a strict policy in the source HTML would break both.
// media:// and tiles:// are registered bypassCSP in src/main/index.ts, so
// video/CSV streaming and tile fetches work regardless; both are listed anyway
// as belt-and-suspenders. MapLibre spawns its worker from a blob: URL and may
// decode tiles via blob image URLs. Map tiles go through tiles:// (the main
// process proxies https://tile.openstreetmap.org behind the disk cache), so
// the renderer itself no longer talks to any external origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: tiles:",
  "media-src 'self' media:",
  "connect-src 'self' tiles:",
  "worker-src blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'"
].join('; ')

function injectCsp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    // Structural tag injection (not string replacement) so the CSP can't
    // silently vanish if the source HTML's formatting changes. head-prepend
    // puts the policy before the script/style tags it must govern.
    transformIndexHtml: {
      handler: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react(), injectCsp()]
  }
})
