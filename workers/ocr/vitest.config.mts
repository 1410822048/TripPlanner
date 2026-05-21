import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// vitest-pool-workers 0.16+ swapped the `defineWorkersConfig` + pool
// option pattern for a vite-level plugin. `cloudflareTest()` receives
// what used to be `test.poolOptions.workers` and registers itself so
// vitest dispatches into the Workers runtime via Miniflare.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
});
