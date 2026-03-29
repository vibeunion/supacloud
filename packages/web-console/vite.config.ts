import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	ssr: {
		noExternal: ['lucide-svelte'],
		external: ['bun', 'bun:sql', 'monaco-editor']
	},
	optimizeDeps: {
		exclude: ['bun', 'bun:sql', 'monaco-editor']
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
