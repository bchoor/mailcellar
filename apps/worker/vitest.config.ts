import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: '../../wrangler.jsonc' },
      // Stand-ins for the Worker secrets; tests never reach Google.
      miniflare: { bindings: { GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret' } },
    }),
  ],
});
