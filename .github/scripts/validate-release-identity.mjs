import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateReleaseIdentity(path, version, config, packageVersion, tag) {
  const component = config.packages?.[path]?.component;
  if (!/^packages\/[a-z0-9-]+$/.test(path) || typeof component !== 'string'
    || !/^[a-z0-9-]+$/.test(component) || typeof version !== 'string'
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Unsupported release identity: ${path}`);
  }
  if (packageVersion !== version || tag !== `${component}-v${version}`) {
    throw new Error(`Release source mismatch: ${path} (${tag})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = 'packages/supacloud-lite';
  const read = file => JSON.parse(readFileSync(file, 'utf8'));
  validateReleaseIdentity(path, read('.release-please-manifest.json')[path],
    read('release-please-config.json'), read(`${path}/package.json`).version, process.env.RELEASE_TAG);
}
