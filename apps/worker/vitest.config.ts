import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: '../../wrangler.jsonc' },
      // Stand-ins for the Worker secrets and the Access app; tests never reach Google or Access.
      miniflare: {
        bindings: {
          GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'test-secret',
          ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com',
          ACCESS_AUD: 'test-aud',
        },
      },
    }),
  ],
  // Same shim as wrangler.jsonc's alias: Workers can't compile WebAssembly at run time.
  resolve: { alias: { hysnappy: '/src/shims/hysnappy.ts' } },
  test: { setupFiles: ['./test/setup.ts'] },
});
