import type { Plugin } from 'vite';

const WEB_CONSOLE_COMPONENT_MARKER = '.supacloud-component.json';
export const WEB_CONSOLE_COMPONENT_MARKER_PLUGIN = 'supacloud-web-console-component-marker';

type WebConsolePackage = {
	version: string;
};

export function webConsoleComponentMarkerSource(packageJson: WebConsolePackage): string {
	return `${JSON.stringify(
		{
			schema_version: 1,
			component: 'web-console',
			version: packageJson.version
		},
		null,
		2
	)}\n`;
}

export function webConsoleComponentMarker(packageJson: WebConsolePackage): Plugin {
	return {
		name: WEB_CONSOLE_COMPONENT_MARKER_PLUGIN,
		apply: 'build',
		generateBundle() {
			this.emitFile({
				type: 'asset',
				fileName: WEB_CONSOLE_COMPONENT_MARKER,
				source: webConsoleComponentMarkerSource(packageJson)
			});
		}
	};
}
