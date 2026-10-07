import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Tell the dev tab apart from prod: only `vite` (serve) renames it.
    {
      name: 'dev-title',
      apply: 'serve',
      transformIndexHtml: (html) => html.replace('<title>Ari</title>', '<title>Dev Ari</title>'),
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      // Note: SuperTokens auth API is now at /api/auth/* (covered by /api proxy above)
      // Frontend /auth/* UI is handled by React Router (no proxy needed)
    },
  },
});
