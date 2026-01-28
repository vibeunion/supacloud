
import { Layout } from "./Layout";
import { ProjectRow } from "./ProjectRow";
import { t } from "../lib/i18n";
import type { Lang } from "../lib/i18n";
import { BackupModal } from "./BackupModal";

export const Dashboard = ({ projects, lang = 'en' }: { projects: { name: string, runtime: string }[], lang?: Lang }) => (
    <Layout lang={lang}>
        <div className="flex flex-col gap-8">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                {/* Stats Cards */}
                <div x-data={`{
                    stats: { cpu: '0%', mem: '0%', net: '0KB' },
                    refresh() {
                        fetch('/system/stats').then(r => r.json()).then(d => this.stats = d).catch(() => {});
                    },
                    init() {
                        this.refresh();
                        setInterval(() => this.refresh(), 3000);
                    }
                }`} className="glass-card rounded-2xl p-6 flex flex-col relative overflow-hidden group col-span-2">
                    <div className="flex justify-between items-start mb-4">
                        <span className="text-slate-400 text-sm font-medium">{t(lang, 'section_monitoring')}</span>
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    </div>

                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <div className="text-xs text-slate-500 mb-1">{t(lang, 'monitor_cpu')}</div>
                            <div className="text-2xl font-bold font-mono text-emerald-400" x-text="stats.cpu">0%</div>
                        </div>
                        <div>
                            <div className="text-xs text-slate-500 mb-1">{t(lang, 'monitor_mem')}</div>
                            <div className="text-2xl font-bold font-mono text-purple-400" x-text="stats.mem">0%</div>
                        </div>
                        <div>
                            <div className="text-xs text-slate-500 mb-1">{t(lang, 'monitor_net')}</div>
                            <div className="text-2xl font-bold font-mono text-cyan-400" x-text="stats.net">0KB</div>
                        </div>
                    </div>
                </div>

                <div x-data={`{
                    backupOpen: false,
                    updateStatus: 'idle', // idle, checking, found, uptodate
                    newVersion: '',
                    checkUpdate() {
                        this.updateStatus = 'checking';
                        fetch('/system/check-update')
                            .then(r => r.json())
                            .then(data => {
                                if (data.hasUpdate) {
                                    this.updateStatus = 'found';
                                    this.newVersion = data.version;
                                } else {
                                    this.updateStatus = 'uptodate';
                                    setTimeout(() => this.updateStatus = 'idle', 3000);
                                }
                            })
                            .catch(() => this.updateStatus = 'idle');
                    }
                }`} className="glass-card rounded-2xl p-6 flex flex-col justify-center gap-3">
                    <span className="text-slate-400 text-sm font-medium">{t(lang, 'section_system')}</span>

                    {/* Update Section */}
                    <div className="w-full">
                        <template x-if="updateStatus === 'idle' || updateStatus === 'uptodate' || updateStatus === 'checking'">
                            <button
                                x-on:click="checkUpdate()"
                                disabled={false}
                                className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                            >
                                <span x-show="updateStatus === 'checking'" className="animate-spin w-4 h-4 border-2 border-slate-400 border-t-white rounded-full"></span>
                                <span x-show="updateStatus === 'idle'">{t(lang, 'btn_update_check')}</span>
                                <span x-show="updateStatus === 'checking'">{t(lang, 'msg_checking_update')}</span>
                                <span x-show="updateStatus === 'uptodate'" className="text-emerald-400">{t(lang, 'update_uptodate')}</span>
                            </button>
                        </template>

                        <template x-if="updateStatus === 'found'">
                            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                                <p className="text-xs text-emerald-400 mb-2 text-center" x-text="'Found new version: v' + newVersion"></p>
                                <div className="flex gap-2">
                                    <button
                                        hx-post="/system/update"
                                        hx-swap="none"
                                        hx-confirm={t(lang, 'msg_update_started')}
                                        className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs py-1.5 rounded transition-colors"
                                    >
                                        {t(lang, 'btn_update_now')}
                                    </button>
                                    <button
                                        x-on:click="updateStatus = 'idle'"
                                        className="px-3 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs py-1.5 rounded transition-colors"
                                    >
                                        {t(lang, 'btn_skip_update')}
                                    </button>
                                </div>
                            </div>
                        </template>
                    </div>

                    {/* Backup Button */}
                    <button {...{ "x-on:click": "backupOpen = true" }} className="w-full bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-400 border border-emerald-500/20 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" /></svg>
                        {t(lang, 'btn_backup_restore')}
                    </button>

                    {/* Backup Modal */}
                    <BackupModal lang={lang} />
                </div>

                <div className="glass-card rounded-2xl p-6 flex flex-col relative overflow-hidden group">
                    <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                        <svg className="w-16 h-16" fill="currentColor" viewBox="0 0 24 24"><path d="M4 6h16v12H4z" /></svg>
                    </div>
                    <span className="text-slate-400 text-sm font-medium mb-1">Active Projects</span>
                    <span className="text-4xl font-bold text-emerald-400">{projects.length}</span>
                </div>
                <div className="glass-card rounded-2xl p-6 flex flex-col">
                    <span className="text-slate-400 text-sm font-medium mb-1">{t(lang, 'status_label')}</span>
                    <div className="flex items-center gap-2 mt-1">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                        <span className="text-emerald-400 font-semibold">{t(lang, 'status_ok')}</span>
                    </div>
                </div>
            </div>

            <div className="flex justify-between items-end mb-6">
                <h2 className="text-2xl font-bold flex items-center gap-2">
                    <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                    {t(lang, 'projects_title')}
                </h2>

                <div x-data="{ open: false }">
                    <button
                        {...{ "x-on:click": "open = true" }}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg font-medium transition-all shadow-lg shadow-emerald-900/40 flex items-center gap-2"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                        {t(lang, 'btn_new')}
                    </button>

                    {/* Modal */}
                    <div x-show="open" className="fixed inset-0 z-50 flex items-center justify-center px-4" style="display: none;">
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...{ "x-on:click": "open = false" }}></div>
                        <div className="glass rounded-xl p-8 w-full max-w-md relative z-10 shadow-2xl animate-fade-in-up">
                            <h3 className="text-xl font-bold mb-4">{t(lang, 'modal_create_title')}</h3>
                            <form hx-post="/projects" hx-target="#project-list" hx-swap="afterbegin" {...{ "hx-on:htmx:after-request": "open = false" }}>
                                <div className="mb-6">
                                    <label className="block text-sm font-medium text-slate-400 mb-2">{t(lang, 'input_name_label')}</label>
                                    <input
                                        name="name"
                                        type="text"
                                        required
                                        pattern="[a-z0-9\-]+"
                                        placeholder={t(lang, 'input_name_placeholder')}
                                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-mono text-sm"
                                    />
                                    <p className="text-xs text-slate-500 mt-2">{t(lang, 'input_hint')}</p>
                                </div>
                                <div className="flex justify-end gap-3">
                                    <button type="button" {...{ "x-on:click": "open = false" }} className="px-4 py-2 hover:bg-slate-800 rounded-lg transition-colors">{t(lang, 'btn_cancel')}</button>
                                    <button type="submit" className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2 rounded-lg font-medium transition-colors">
                                        {t(lang, 'btn_create')}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            </div >

            <div className="glass rounded-2xl overflow-hidden min-h-[300px]">
                <div className="grid grid-cols-12 gap-4 p-4 border-b border-white/5 text-xs text-slate-400 font-semibold uppercase tracking-wider">
                    <div className="col-span-4">{t(lang, 'col_name')}</div>
                    <div className="col-span-3">{t(lang, 'col_status')}</div>
                    <div className="col-span-3">{t(lang, 'col_endpoints')}</div>
                    <div className="col-span-2 text-right">{t(lang, 'col_actions')}</div>
                </div>
                <div id="project-list" className="divide-y divide-white/5">
                    {projects.map(({ name, runtime }) => <ProjectRow name={name} runtime={runtime} lang={lang} />)}
                </div>
            </div>
        </div>
    </Layout>
);
