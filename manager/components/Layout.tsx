
import type { Lang } from "../lib/i18n";
import { t } from "../lib/i18n";

export const Layout = ({ children, title, lang = 'en' }: { children: any, title?: string, lang?: Lang }) => (
    <html lang={lang} className="dark">
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>{title ? `${title} - SupaCloud` : 'SupaCloud Manager'}</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.13.3/dist/cdn.min.js"></script>
            <script src="https://unpkg.com/htmx.org@1.9.10"></script>
            <style>{`
            .glass {
                background: rgba(30, 41, 59, 0.7);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.1);
            }
            .glass-card {
                background: rgba(15, 23, 42, 0.6);
                backdrop-filter: blur(8px);
                border: 1px solid rgba(255, 255, 255, 0.05);
            }
        `}</style>
        </head>
        <body className="bg-slate-900 text-slate-200 font-sans min-h-screen flex flex-col">
            <nav className="glass sticky top-0 z-50 px-6 py-4 flex justify-between items-center shadow-lg shadow-black/20">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
                        <svg className="w-5 h-5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                        </svg>
                    </div>
                    <span className="font-bold text-xl tracking-tight bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                        SupaCloud
                    </span>
                    <span className="text-xs font-mono bg-slate-800 px-2 py-0.5 rounded text-slate-400 border border-slate-700">v0.1.0</span>
                </div>
                <div className="flex gap-4 text-sm font-medium items-center">
                    <a href={`/lang?to=${lang === 'en' ? 'zh' : 'en'}`} className="hover:text-emerald-400 transition-colors">
                        {t(lang, 'lang_switch')}
                    </a>
                </div>
            </nav>

            <main className="flex-1 container mx-auto px-4 py-8 max-w-6xl">
                {children}
            </main>

            <footer className="text-center py-6 text-slate-600 text-sm border-t border-slate-800/50 mt-12">
                <p>Powered by SupaCloud • Open Source</p>
            </footer>
        </body>
    </html>
);
