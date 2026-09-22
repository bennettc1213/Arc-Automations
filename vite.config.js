import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
  },
});
