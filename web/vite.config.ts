import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The portal is served by the Dittoly server from dist/web. In development,
// `npm run web:dev` proxies API and auth calls to the port configured in .env.
const backend = `http://127.0.0.1:${process.env.PORT ?? '8080'}`;
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    proxy: { '/api': backend, '/auth': backend },
  },
});
