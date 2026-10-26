import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// SINGLEFILE=1 inlines everything into one index.html (the shareable prototype page).
const single = process.env.SINGLEFILE === '1';
// The app lives under /app; the site root is the public page in site/, copied into dist by the build.

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(single ? [viteSingleFile()] : [])],
  base: single ? '/' : '/app/',
  define: { __SINGLE_FILE__: JSON.stringify(single) },
  build: single ? { assetsInlineLimit: 100_000_000, cssCodeSplit: false, chunkSizeWarningLimit: 100_000 } : { outDir: 'dist/app' },
});
