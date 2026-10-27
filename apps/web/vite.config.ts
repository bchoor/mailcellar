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
  // __BUILD__ names this build (the commit Workers Builds deploys), so answers saved by an older build are dropped.
  define: { __SINGLE_FILE__: JSON.stringify(single), __BUILD__: JSON.stringify(process.env.WORKERS_CI_COMMIT_SHA ?? String(Date.now())) },
  build: single
    ? { assetsInlineLimit: 100_000_000, cssCodeSplit: false, chunkSizeWarningLimit: 100_000 }
    : {
        outDir: 'dist/app',
        // Icons used by both the app and a lazy part went out as one file each (33 tiny requests
        // before first paint); they now share one. Icons only a lazy part uses stay with it.
        rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'icons', test: /node_modules[\\/]lucide-react/, minShareCount: 2 }] } } },
      },
});
