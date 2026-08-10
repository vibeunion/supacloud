import type { Plugin } from 'vite';

const WEB_CONSOLE_COMPONENT_MARKER = '.supacloud-component.json';
export const WEB_CONSOLE_COMPONENT_MARKER_PLUGIN = 'supacloud-web-console-component-marker';
const EXACT_STABLE_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

type WebConsolePackage = {
	version: string;
};

function exactStableWebConsoleVersion(version: string): string {
	if (!EXACT_STABLE_SEMVER.test(version)) {
		throw new Error('Web Console package version must be an exact stable semantic version');
	}
	return version;
}

export function webConsoleComponentMarkerSource(packageJson: WebConsolePackage): string {
	return `${JSON.stringify(
		{
			schema_version: 1,
			component: 'web-console',
			version: exactStableWebConsoleVersion(packageJson.version)
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
