import { describe, expect, test } from 'bun:test';
import packageJson from './package.json' with { type: 'json' };
import viteConfig from './vite.config';
import {
	WEB_CONSOLE_COMPONENT_MARKER_PLUGIN,
	webConsoleComponentMarker,
	webConsoleComponentMarkerSource
} from './component-marker';

type EmittedMarker = {
	type: 'asset';
	fileName: string;
	source: string;
};

describe('web console component marker', () => {
	test('uses the package version and stable component schema', () => {
		const markerSource = webConsoleComponentMarkerSource(packageJson);

		expect(markerSource).toBe(
			`{\n  "schema_version": 1,\n  "component": "web-console",\n  "version": "${packageJson.version}"\n}\n`
		);
	});

	test('rejects non-stable package versions before emitting a release marker', () => {
		for (const version of ['01.2.3', '0.28.8-rc.1', '0.28.8+build.4', '0.28.8\n']) {
			expect(() => webConsoleComponentMarkerSource({ version })).toThrow(
				'exact stable semantic version'
			);
		}
	});

	test('registers a build plugin that emits the marker at the build root', () => {
		const configuredPluginNames = viteConfig.plugins
			?.flat()
			.filter((plugin) => plugin && typeof plugin === 'object')
			.map((plugin) => plugin.name);
		expect(configuredPluginNames).toContain(WEB_CONSOLE_COMPONENT_MARKER_PLUGIN);

		const emittedMarkers: EmittedMarker[] = [];
		const plugin = webConsoleComponentMarker(packageJson);
		const generateBundle = plugin.generateBundle;
		if (typeof generateBundle !== 'function') {
			throw new Error('Web Console marker plugin must define generateBundle');
		}
		Reflect.apply(generateBundle, {
			emitFile(marker: EmittedMarker) {
				emittedMarkers.push(marker);
				return marker.fileName;
			}
		}, []);

		expect(emittedMarkers).toEqual([{
			type: 'asset',
			fileName: '.supacloud-component.json',
			source: webConsoleComponentMarkerSource(packageJson)
		}]);
	});
});
