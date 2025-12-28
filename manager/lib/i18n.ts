
// Basic translation support
import { getCookie } from "hono/cookie";
import type { Context } from "hono";

export const DICTIONARY = {
    en: {
        status_label: "System Status",
        status_ok: "Operational",
        projects_title: "Projects",
        btn_new: "New Project",
        btn_restart: "Restart",
        btn_start: "Start",
        btn_stop: "Stop",
        btn_logs: "Logs",
        btn_config: "Config",
        btn_delete: "Delete",
        btn_cancel: "Cancel",
        btn_create: "Create",
        btn_save: "Save Changes",
        modal_create_title: "Create New Project",
        input_name_label: "Project Name",
        input_name_placeholder: "e.g. my-awesome-app",
        input_hint: "Only lowercase letters, numbers, and hyphens.",
        modal_logs_title: "Logs",
        modal_config_title: "Environment Variables",
        hint_restart: "Restart required after saving",
        confirm_delete: "Are you sure you want to delete {name}? This cannot be undone.",
        link_studio: "Studio",
        link_api: "API Endpoint",
        lang_switch: "中文",
        col_name: "Project Name",
        col_status: "Status",
        col_endpoints: "Endpoints",
        col_actions: "Actions",
        btn_code: "Code",
        modal_code_title: "Function Code",
        btn_add_func: "New Function",
        btn_delete_func: "Delete",
        placeholder_func_name: "index.ts",
        title_env_vars: "Environment Variables",
        hint_save_restart: "Save changes and restart service to apply",
        // New features
        section_monitoring: "Monitoring",
        section_system: "System Operations",
        btn_update_check: "Check for Updates",
        btn_update_now: "Update System",
        btn_backup_restore: "Backups & Restore",
        modal_system_update_title: "System Update",
        modal_restore_title: "Data Restore",
        monitor_cpu: "CPU Usage",
        monitor_mem: "Memory Usage",
        monitor_net: "Net I/O",
        table_backup_file: "Backup File",
        table_backup_size: "Size",
        table_backup_date: "Date",
        btn_restore: "Restore",
        confirm_restore: "Are you sure you want to restore {file}? CURRENT DATA WILL BE LOST!",
        update_available: "New version available!",
        update_uptodate: "Your system is up to date.",
        msg_update_started: "Update started. System will restart...",
        msg_checking_update: "Checking for updates...",
        msg_update_found: "New version found: v{version}",
        msg_no_update: "You are on the latest version.",
        btn_skip_update: "Skip"
    },
    zh: {
        status_label: "系统状态",
        status_ok: "运行正常",
        projects_title: "项目管理",
        btn_new: "新建项目",
        btn_restart: "重启服务",
        btn_start: "启动服务",
        btn_stop: "停止服务",
        btn_logs: "查看日志",
        btn_config: "修改配置",
        btn_delete: "删除项目",
        btn_cancel: "取消",
        btn_create: "立即创建",
        btn_save: "保存更改",
        modal_create_title: "创建新项目",
        input_name_label: "项目名称",
        input_name_placeholder: "例如: my-app",
        input_hint: "仅支持小写字母、数字和连接符",
        modal_logs_title: "运行日志",
        modal_config_title: "环境变量配置",
        hint_restart: "⚠️ 保存后会自动需要重启服务",
        confirm_delete: "确定要彻底删除项目 {name} 吗？数据无法恢复！",
        link_studio: "管理面板",
        link_api: "API 接口",
        lang_switch: "English",
        col_name: "项目名称",
        col_status: "状态",
        col_endpoints: "服务端点",
        col_actions: "操作",
        btn_code: "代码",
        modal_code_title: "函数代码",
        btn_add_func: "新建函数",
        btn_delete_func: "删除",
        placeholder_func_name: "index.ts",
        title_env_vars: "环境变量",
        hint_save_restart: "保存并重启服务以生效",
        // New features
        section_monitoring: "监控面板",
        section_system: "系统运维",
        btn_update_check: "检查更新",
        btn_update_now: "系统更新",
        btn_backup_restore: "备份与恢复",
        modal_system_update_title: "系统更新",
        modal_restore_title: "数据恢复",
        monitor_cpu: "CPU 使用率",
        monitor_mem: "内存使用",
        monitor_net: "网络 I/O",
        table_backup_file: "备份文件",
        table_backup_size: "大小",
        table_backup_date: "日期",
        btn_restore: "立即恢复",
        confirm_restore: "⚠️ 确定要从 {file} 恢复吗？当前数据将被覆盖且无法找回！",
        update_available: "发现新版本！",
        update_uptodate: "当前已是最新系统。",
        msg_update_started: "更新任务已后台启动，系统即将重启...",
        msg_checking_update: "正在检查更新...",
        msg_update_found: "发现新版本: v{version}",
        msg_no_update: "当前已是最新版本",
        btn_skip_update: "暂不更新"
    }
};

export type Lang = 'en' | 'zh';

export function getLang(c: Context): Lang {
    const cookieLang = getCookie(c, 'lang');
    if (cookieLang === 'zh' || cookieLang === 'en') return cookieLang;

    // Auto-detect from Accept-Language header
    const acceptLang = c.req.header('Accept-Language');
    if (acceptLang && acceptLang.toLowerCase().includes('zh')) {
        return 'zh';
    }

    return 'en';
}

export function t(lang: Lang, key: keyof typeof DICTIONARY['en'], params?: Record<string, string>) {
    let text = DICTIONARY[lang][key] || DICTIONARY['en'][key] || key;
    if (params) {
        Object.entries(params).forEach(([k, v]) => {
            text = text.replace(`{${k}}`, v);
        });
    }
    return text;
}
