import { register, init, getLocaleFromNavigator, locale, waitLocale } from 'svelte-i18n';

register('en', () => import('./locales/en.json'));
register('zh', () => import('./locales/zh.json'));

const savedLocale = typeof localStorage !== 'undefined' ? localStorage.getItem('selected-locale') : null;

init({
  fallbackLocale: 'en',
  initialLocale: savedLocale || getLocaleFromNavigator(),
});

// 在客戶端環境下導出一個等待函數
export { waitLocale };

// 持久化語言選擇
if (typeof localStorage !== 'undefined') {
  locale.subscribe(val => {
    if (val) localStorage.setItem('selected-locale', val);
  });
}
