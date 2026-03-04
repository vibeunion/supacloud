export class Logger {
    static info(message: string, meta?: Record<string, any>) {
        this.log("INFO", message, meta);
    }

    static warn(message: string, meta?: Record<string, any>) {
        this.log("WARN", message, meta);
    }

    static error(message: string | Error, meta?: Record<string, any>) {
        const errMsg = message instanceof Error ? message.message : message;
        const errStack = message instanceof Error ? message.stack : undefined;
        this.log("ERROR", errMsg, { ...meta, stack: errStack });
    }

    static debug(message: string, meta?: Record<string, any>) {
        if (process.env.NODE_ENV !== "production") {
            this.log("DEBUG", message, meta);
        }
    }

    private static log(level: string, message: string, meta?: Record<string, any>) {
        const output = {
            level,
            timestamp: new Date().toISOString(),
            message,
            ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
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
}

export const logger = Logger;
