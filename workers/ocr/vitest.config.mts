import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// @cloudflare/vitest-plugin (renamed from vitest-pool-workers) is a
// vite-level plugin. `cloudflareTest()` receives
// what used to be `test.poolOptions.workers` and registers itself so
// vitest dispatches into the Workers runtime via Miniflare.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
});
