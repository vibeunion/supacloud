
import type { Lang } from "../lib/i18n";
import { t } from "../lib/i18n";
import { ROOT_DOMAIN } from "../lib/config";

export const ProjectRow = ({ name, lang = 'en' }: { name: string, lang?: Lang }) => (
    <div className="grid grid-cols-12 gap-4 p-4 items-center hover:bg-white/5 transition-colors group">
        <div className="col-span-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center font-bold text-slate-300 font-mono text-lg border border-white/5">
                {name.substring(0, 2).toUpperCase()}
            </div>
            <div>
                <div className="font-semibold text-slate-200">{name}</div>
                <div className="text-xs text-slate-500">Postgres 15 • 2 Services</div>
            </div>
        </div>
        <div className="col-span-3">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                {t(lang, 'status_ok')}
            </span>
        </div>
        <div className="col-span-3 flex flex-col gap-1">
            <a href={`http://${name}.studio.${ROOT_DOMAIN}`} target="_blank" className="text-xs text-cyan-400 hover:underline flex items-center gap-1">
                {t(lang, 'link_studio')}
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </a>
            <a href={`http://${name}.${ROOT_DOMAIN}`} target="_blank" className="text-xs text-slate-400 hover:text-slate-200 transaction-colors">{t(lang, 'link_api')}</a>
        </div>
        <div className="col-span-2 text-right opacity-0 group-hover:opacity-100 transition-opacity flex justify-end gap-2">
            {/* Start/Stop Buttons */}
            <button
                hx-post={`/projects/${name}/stop`}
                hx-swap="none"
                className="text-amber-400 hover:bg-white/10 hover:text-amber-300 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                title={t(lang, 'btn_stop')}
                onclick="setTimeout(() => window.location.reload(), 2000)"
            >
                {t(lang, 'btn_stop')}
            </button>
            <button
                hx-post={`/projects/${name}/start`}
                hx-swap="none"
                className="text-emerald-400 hover:bg-white/10 hover:text-emerald-300 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                title={t(lang, 'btn_start')}
                onclick="setTimeout(() => window.location.reload(), 2000)"
            >
                {t(lang, 'btn_start')}
            </button>

            <button
                hx-get={`/projects/${name}/logs`}
                hx-target="body"
                hx-swap="beforeend"
                title={t(lang, 'btn_logs')}
                className="text-slate-400 hover:bg-white/10 hover:text-white px-3 py-1.5 rounded text-xs font-medium transition-colors"
            >
                {t(lang, 'btn_logs')}
            </button>
            <button
                hx-get={`/projects/${name}/config`}
                hx-target="body"
                hx-swap="beforeend"
                title={t(lang, 'btn_config')}
                className="text-slate-400 hover:bg-white/10 hover:text-white px-3 py-1.5 rounded text-xs font-medium transition-colors"
            >
                {t(lang, 'btn_config')}
            </button>
            <button
                hx-get={`/projects/${name}/code`}
                hx-target="body"
                hx-swap="beforeend"
                title={t(lang, 'btn_code')}
                className="text-slate-400 hover:bg-white/10 hover:text-white px-3 py-1.5 rounded text-xs font-medium transition-colors"
            >
                {t(lang, 'btn_code')}
            </button>
            <button
                hx-post={`/projects/${name}/restart`}
                hx-swap="none"
                title={t(lang, 'btn_restart')}
                className="text-slate-400 hover:bg-white/10 hover:text-white px-3 py-1.5 rounded text-xs font-medium transition-colors"
            >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            </button>
            <button
                hx-delete={`/projects/${name}`}
                hx-target="#project-list"
                hx-confirm={t(lang, 'confirm_delete').replace('{name}', name)}
                title={t(lang, 'btn_delete')}
                className="text-slate-400 hover:bg-white/10 hover:text-red-400 px-3 py-1.5 rounded text-xs font-medium transition-colors"
            >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
        </div>
    </div>
);
