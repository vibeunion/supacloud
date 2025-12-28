
import type { Lang } from "../lib/i18n";
import { t } from "../lib/i18n";

export const BackupList = ({ files, lang = 'en' }: { files: any[], lang?: Lang }) => (
    <>
        {files.length === 0 && (
            <tr><td colSpan={4} className="text-center py-8 text-slate-500">No backups found</td></tr>
        )}
        {files.map((f: any) => (
            <tr className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="py-3 px-2 font-mono text-xs text-slate-400">{f.date}</td>
                <td className="py-3 px-2 font-mono text-xs text-emerald-400">{f.size}</td>
                <td className="py-3 px-2 font-mono text-xs text-slate-300">{f.name}</td>
                <td className="py-3 px-2 text-right">
                    <button
                        hx-post="/system/restore"
                        hx-vals={JSON.stringify({ file: f.name })}
                        hx-confirm={t(lang, 'confirm_restore').replace('{file}', f.name)}
                        className="text-xs bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white px-2 py-1 rounded transition-colors"
                    >
                        {t(lang, 'btn_restore')}
                    </button>
                </td>
            </tr>
        ))}
    </>
);
