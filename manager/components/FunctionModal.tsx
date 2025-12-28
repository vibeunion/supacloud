
import type { Lang } from "../lib/i18n";
import { t } from "../lib/i18n";

export interface FunctionModalProps {
    name: string;
    files: string[];
    selectedFile: string;
    fileContent: string;
    lang?: Lang;
}

export const FunctionModal = ({ name, files, selectedFile, fileContent, lang = 'en' }: FunctionModalProps) => (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" id="modal-container">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }}></div>
        <div className="glass rounded-xl w-full max-w-5xl relative z-10 shadow-2xl animate-fade-in-up flex h-[80vh] overflow-hidden" x-data={`{
            currentFile: '${selectedFile}',
            isNew: ${!selectedFile},
            content: \`${fileContent.replace(/`/g, '\\`')}\`,
            files: ${JSON.stringify(files)},
            loadFile(file) {
                this.currentFile = file;
                this.isNew = false;
                fetch(\`/projects/${name}/code/\${file}\`).then(r => r.text()).then(t => this.content = t);
            },
            newFile() {
                this.currentFile = '';
                this.isNew = true;
                this.content = '';
            },
            async save() {
                if (!this.currentFile) return;
                await fetch(\`/projects/${name}/code/\${this.currentFile}\`, {
                    method: 'POST',
                    body: this.content
                });
                // Simple reload to refresh list if needed
                htmx.ajax('GET', \`/projects/${name}/code?file=\${this.currentFile}\`, '#modal-container');
            },
            async del() {
                if (!confirm('${t(lang, 'confirm_delete').replace('{name}', "' + this.currentFile + '")}')) return;
                await fetch(\`/projects/${name}/code/\${this.currentFile}\`, { method: 'DELETE' });
                htmx.ajax('GET', \`/projects/${name}/code\`, '#modal-container');
            }
        }`}>
            {/* Sidebar */}
            <div className="w-1/4 bg-slate-950/50 border-r border-slate-800 flex flex-col">
                <div className="p-4 border-b border-white/5 flex justify-between items-center">
                    <h3 className="font-bold text-slate-300">{t(lang, 'modal_code_title')}</h3>
                    <button x-on:click="newFile()" className="text-emerald-400 hover:text-emerald-300 text-xs bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20 transition-colors">
                        + {t(lang, 'btn_add_func')}
                    </button>
                </div>
                <div className="flex-1 overflow-auto p-2 space-y-1">
                    <template x-for="file in files">
                        <button
                            x-on:click="loadFile(file)"
                            {...{ ":class": "currentFile === file ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200 border-transparent'" }}
                            className="w-full text-left px-3 py-2 rounded text-sm font-mono border transition-all truncate"
                            x-text="file"
                        ></button>
                    </template>
                </div>
            </div>

            {/* Editor Area */}
            <div className="flex-1 flex flex-col bg-slate-900/50">
                <div className="p-4 border-b border-white/5 flex items-center gap-4 bg-slate-900/30">
                    <div className="flex-1">
                        <input
                            type="text"
                            x-model="currentFile"
                            {...{ ":disabled": "!isNew" }}
                            placeholder={t(lang, 'placeholder_func_name')}
                            className="bg-transparent text-slate-200 font-mono text-sm focus:outline-none w-full placeholder-slate-600"
                        />
                    </div>
                    <div className="flex gap-2">
                        <button x-show="!isNew" x-on:click="del()" className="text-red-400 hover:bg-red-500/10 px-3 py-1.5 rounded text-xs transition-colors">{t(lang, 'btn_delete_func')}</button>
                        <button x-on:click="save()" className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded text-xs font-medium transition-colors">{t(lang, 'btn_save')}</button>
                    </div>
                </div>
                <textarea
                    x-model="content"
                    className="flex-1 w-full bg-slate-950 p-4 font-mono text-xs text-slate-300 focus:outline-none resize-none"
                    spellCheck="false"
                ></textarea>
                <div className="p-2 bg-slate-950 border-t border-slate-800 text-right">
                    <span className="text-xs text-yellow-500/80">{t(lang, 'hint_save_restart')}</span>
                </div>
            </div>

            {/* Close Button */}
            <button {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }} className="absolute top-2 right-2 text-slate-500 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
        </div>
    </div>
);
