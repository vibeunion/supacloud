
import type { Lang } from "../lib/i18n";
import { t } from "../lib/i18n";

export const ConfigModal = ({ name, config, lang = 'en' }: { name: string, config: string, lang?: Lang }) => (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" id="modal-container">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }}></div>
        <div className="glass rounded-xl p-6 w-full max-w-2xl relative z-10 shadow-2xl animate-fade-in-up">
            <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                {t(lang, 'modal_config_title')}: {name}
            </h3>
            <form hx-post={`/projects/${name}/config`} hx-target="#modal-container" hx-swap="delete">
                <div className="mb-4">
                    <textarea name="config" className="w-full h-64 bg-slate-950 border border-slate-700 rounded-lg p-4 font-mono text-xs text-slate-300 focus:outline-none focus:border-emerald-500">{config}</textarea>
                </div>
                <div className="flex justify-between items-center">
                    <span className="text-xs text-yellow-500/80 bg-yellow-500/10 px-2 py-1 rounded border border-yellow-500/20">{t(lang, 'hint_restart')}</span>
                    <div className="flex gap-3">
                        <button type="button" {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }} className="px-4 py-2 hover:bg-slate-800 rounded-lg transition-colors text-sm">{t(lang, 'btn_cancel')}</button>
                        <button type="submit" className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2 rounded-lg font-medium transition-colors text-sm">{t(lang, 'btn_save')}</button>
                    </div>
                </div>
            </form>
        </div>
    </div>
);
