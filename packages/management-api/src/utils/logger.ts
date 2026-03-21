type LogMeta = Record<string, unknown> | string | Error | undefined;

function normalizeMeta(meta: LogMeta): Record<string, unknown> | undefined {
    if (meta === undefined) return undefined;
    if (typeof meta === "string") return { detail: meta };
    if (meta instanceof Error) return { error: meta.message, stack: meta.stack };
    return meta;
}

function log(level: string, message: string, meta?: LogMeta) {
    const normalized = normalizeMeta(meta);
    const output = {
        level,
        timestamp: new Date().toISOString(),
        message,
        ...(normalized && Object.keys(normalized).length > 0 ? { meta: normalized } : {}),
    };

    const logStr = JSON.stringify(output);

    switch (level) {
        case "ERROR":
            console.error(logStr);
            break;
        case "WARN":
            console.warn(logStr);
            break;
        case "DEBUG":
            console.debug(logStr);
            break;
        default:
            console.log(logStr);
    }
}

function info(message: string, meta?: LogMeta) {
    log("INFO", message, meta);
}

function warn(message: string, meta?: LogMeta) {
    log("WARN", message, meta);
}

function error(message: string | Error, meta?: LogMeta) {
    const errMsg = message instanceof Error ? message.message : message;
    const errStack = message instanceof Error ? message.stack : undefined;
    const normalized = normalizeMeta(meta);
    log("ERROR", errMsg, { ...normalized, stack: errStack });
}

function debug(message: string, meta?: LogMeta) {
    if (process.env.NODE_ENV !== "production") {
        log("DEBUG", message, meta);
    }
}

export const logger = { info, warn, error, debug };
