import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    assetsInlineLimit: 100000000, // inline all assets
    cssCodeSplit: false,
  },
  server: {
    proxy: {
      '/api/lusha': {
        target: 'https://api.lusha.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/lusha/, ''),
      },
      '/api/zyla': {
        target: 'https://zylalabs.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/zyla/, ''),
      },
      '/api/builtwith': {
        target: 'https://api.builtwith.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/builtwith/, ''),
      },
      '/api/pagespeed': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pagespeed/, '/pagespeed'),
      },
      '/api/scrape': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/scrape/, '/scrape'),
      },
    },
  },
})
