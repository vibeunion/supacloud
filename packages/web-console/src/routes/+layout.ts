export const ssr = false;
export const prerender = false;
export const trailingSlash = 'never';

import { waitLocale } from '$lib/i18n';

export const load = async () => {
  await waitLocale();
  return {};
};