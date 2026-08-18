import { randomUUID } from "node:crypto";
import {
    chmodSync,
    chownSync,
    lstatSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";

const SECTION_HEADER = /^\s*\[[^\]]+\]\s*(?:[;#].*)?$/;
const SERVER_SECTION = /^\s*\[server\]\s*(?:[;#].*)?$/i;
const ROOT_URL_SETTING = /^\s*root_url\s*=.*$/i;
const GRAFANA_ROOT_URL = /=\s*\S*\/grafana\/\s*$/i;
const SERVE_FROM_SUB_PATH_SETTING = /^\s*serve_from_sub_path\s*=.*$/i;

export type GrafanaConfigSnapshot = {
    path: string;
    content: Buffer;
    mode: number;
    uid: number;
    gid: number;
};

function settingInsertionIndex(sectionLines: string[]): number {
    let insertionIndex = sectionLines.length;
    while (insertionIndex > 0 && sectionLines[insertionIndex - 1]?.trim() === "") insertionIndex -= 1;
    return insertionIndex;
}

function setServerSetting(
    sectionLines: string[],
    settingPattern: RegExp,
    renderSetting: (currentSetting?: string) => string,
    settingName: string,
): string[] {
    const matches = sectionLines.flatMap((line, index) => settingPattern.test(line) ? [index] : []);
    if (matches.length > 1) throw new Error(`Grafana [server] contains duplicate ${settingName} settings`);
    if (matches.length === 0) {
        const insertionIndex = settingInsertionIndex(sectionLines);
        return [...sectionLines.slice(0, insertionIndex), renderSetting(), ...sectionLines.slice(insertionIndex)];
    }
    const updatedLines = [...sectionLines];
    const settingIndex = matches[0] as number;
    updatedLines[settingIndex] = renderSetting(updatedLines[settingIndex]);
    return updatedLines;
}

export function renderGrafanaSubpathConfig(source: string): string {
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    const trailingNewline = source.endsWith("\n");
    const lines = source.split(/\r?\n/);
    if (trailingNewline) lines.pop();
    const serverStart = lines.findIndex(line => SERVER_SECTION.test(line));
    if (serverStart < 0) throw new Error("Grafana config does not contain a [server] section");
    const nextSection = lines.findIndex((line, index) => index > serverStart && SECTION_HEADER.test(line));
    const serverEnd = nextSection < 0 ? lines.length : nextSection;
    let serverLines = lines.slice(serverStart + 1, serverEnd);
    serverLines = setServerSetting(serverLines, ROOT_URL_SETTING, current => (
        current && GRAFANA_ROOT_URL.test(current) ? current : "root_url = /grafana/"
    ), "root_url");
    serverLines = setServerSetting(
        serverLines,
        SERVE_FROM_SUB_PATH_SETTING,
        () => "serve_from_sub_path = true",
        "serve_from_sub_path",
    );
    const rendered = [...lines.slice(0, serverStart + 1), ...serverLines, ...lines.slice(serverEnd)].join(newline);
    return trailingNewline ? `${rendered}${newline}` : rendered;
}

function captureGrafanaConfig(path: string): GrafanaConfigSnapshot | null {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (!stats) return null;
    if (!stats.isFile() || stats.nlink !== 1) {
        throw new Error(`Grafana config must be a direct regular file: ${path}`);
    }
    return {
        path,
        content: readFileSync(path),
        mode: stats.mode & 0o777,
        uid: stats.uid,
        gid: stats.gid,
    };
}

export function captureGrafanaConfigSnapshots(paths: string[]): GrafanaConfigSnapshot[] {
    return [...new Set(paths)].flatMap(path => {
        const snapshot = captureGrafanaConfig(path);
        return snapshot ? [snapshot] : [];
    });
}

function replaceGrafanaConfig(snapshot: GrafanaConfigSnapshot, content: string | Buffer): void {
    const temporaryPath = `${snapshot.path}.tmp-${process.pid}-${randomUUID()}`;
    try {
        writeFileSync(temporaryPath, content, { flag: "wx", mode: snapshot.mode });
        chownSync(temporaryPath, snapshot.uid, snapshot.gid);
        chmodSync(temporaryPath, snapshot.mode);
        renameSync(temporaryPath, snapshot.path);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}

export function applyGrafanaSubpathConfig(snapshots: GrafanaConfigSnapshot[]): boolean {
    let changed = false;
    for (const snapshot of snapshots) {
        const current = snapshot.content.toString("utf8");
        const rendered = renderGrafanaSubpathConfig(current);
        if (rendered === current) continue;
        replaceGrafanaConfig(snapshot, rendered);
        changed = true;
    }
    return changed;
}

export function restoreGrafanaConfig(snapshot: GrafanaConfigSnapshot): void {
    replaceGrafanaConfig(snapshot, snapshot.content);
}
