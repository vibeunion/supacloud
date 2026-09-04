import { register, init, getLocaleFromNavigator, locale, waitLocale } from 'svelte-i18n';

register('en', () => import('./locales/en.json'));
register('zh', () => import('./locales/zh.json'));
register('zh-CN', () => import('./locales/zh.json'));
register('en-US', () => import('./locales/en.json'));

const SUPPORTED = new Set(["en", "en-US", "zh", "zh-CN"]);

function normalizeLocale(value: string | null | undefined): string {
  if (!value) return "zh-CN";
  const trimmed = value.trim();
  if (SUPPORTED.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en";
  return "zh-CN";
}

const savedLocale = typeof localStorage !== 'undefined' ? localStorage.getItem('selected-locale') : null;
const initialLocale = normalizeLocale(savedLocale || getLocaleFromNavigator());

init({
  fallbackLocale: 'en',
  initialLocale,
});

// Guard against race conditions where templates call $t() before locale settles.
locale.set(initialLocale);

// Export a wait function in client environment
export { waitLocale };

// Persist locale selection
if (typeof localStorage !== 'undefined') {
  locale.subscribe(val => {
    if (val) localStorage.setItem('selected-locale', normalizeLocale(val));
  });
}
