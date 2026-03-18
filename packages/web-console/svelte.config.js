import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({
			fallback: 'index.html',
			strict: false
		}),
		alias: {
			"$components": "src/lib/components",
			"$lib": "src/lib",
			"$management": "../management-api/src"
		}
	}
};

export default config;
