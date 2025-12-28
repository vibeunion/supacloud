
import type { Lang } from "../lib/i18n";
import { t } from "../lib/i18n";

export const BackupModal = ({ lang = 'en' }: { lang?: Lang }) => (
    <div x-show="backupOpen" className="fixed inset-0 z-50 flex items-center justify-center px-4" style="display: none;">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...{ "x-on:click": "backupOpen = false" }}></div>
        <div className="glass rounded-xl p-6 w-full max-w-5xl relative z-10 shadow-2xl animate-fade-in-up flex flex-col max-h-[85vh]">
            <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" /></svg>
                {t(lang, 'modal_restore_title')}
            </h3>

            <div className="flex-1 overflow-auto bg-slate-950/50 rounded-lg border border-white/5 min-h-[300px]">
                <table className="w-full text-left">
                    <thead className="text-xs text-slate-500 uppercase bg-slate-900/50 sticky top-0 backdrop-blur-md">
                        <tr>
                            <th className="py-2 px-2 pl-4">{t(lang, 'table_backup_date')}</th>
                            <th className="py-2 px-2">{t(lang, 'table_backup_size')}</th>
                            <th className="py-2 px-2 w-full">{t(lang, 'table_backup_file')}</th>
                            <th className="py-2 px-2 pr-4 text-right">{t(lang, 'col_actions')}</th>
                        </tr>
                    </thead>
                    <tbody hx-get="/system/backups" hx-trigger="intersect once">
                        <tr><td colSpan={4} className="text-center py-8 text-slate-500 animate-pulse">Loading backups from S3...</td></tr>
                    </tbody>
                </table>
            </div>

            <div className="flex justify-end gap-3 mt-6">
                <button type="button" {...{ "x-on:click": "backupOpen = false" }} className="px-4 py-2 hover:bg-slate-800 rounded-lg transition-colors">{t(lang, 'btn_cancel')}</button>
            </div>
        </div>
    </div>
);
