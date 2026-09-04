import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import packageJson from './package.json' with { type: 'json' };
import { webConsoleComponentMarker } from './component-marker.ts';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), webConsoleComponentMarker(packageJson)],
	ssr: {
		noExternal: ['lucide-svelte'],
		external: ['bun', 'bun:sql', 'monaco-editor']
	},
	optimizeDeps: {
		// @svadmin/core publishes Svelte TypeScript source code; bypass pre-bundling and pass to Svelte compiler.
		exclude: ['bun', 'bun:sql', 'monaco-editor', '@svadmin/core']
	},
	build: {
		rollupOptions: {
			external: ['bun', 'bun:sql', 'monaco-editor']
		}
	},
	server: {
		fs: {
			// Allow serving files from management-api (since we use it via alias)
			allow: ['..']
		}
	}
});
