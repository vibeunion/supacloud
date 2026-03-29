import { init, locale, getLocaleFromNavigator } from 'svelte-i18n';
init({ fallbackLocale: 'en', initialLocale: 'zh-CN' });
let val;
locale.subscribe(v => val = v)();
console.log("Locale is:", val);
