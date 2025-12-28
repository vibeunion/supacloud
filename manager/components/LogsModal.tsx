
import type { Lang } from "../lib/i18n";
import { t } from "../lib/i18n";

export const LogsModal = ({ name, logs, lang = 'en' }: { name: string, logs: string, lang?: Lang }) => (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" id="modal-container">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }}></div>
        <div className="glass rounded-xl p-6 w-full max-w-4xl max-h-[80vh] flex flex-col relative z-10 shadow-2xl animate-fade-in-up">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-bold flex items-center gap-2">
                    <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    {t(lang, 'modal_logs_title')}: {name}
                </h3>
                <button {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }} className="text-slate-400 hover:text-white">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
            </div>
            <pre className="flex-1 overflow-auto bg-slate-950 p-4 rounded-lg text-xs font-mono text-slate-300 whitespace-pre-wrap border border-slate-800">
                {logs}
            </pre>
        </div>
    </div>
);
