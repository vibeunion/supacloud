export interface GlobalCliOptions {
    environmentName?: string;
    envFile?: string;
    confirmProduction?: string;
    args: string[];
}

const GLOBAL_FLAGS = {
    "--env": "environmentName",
    "--env-file": "envFile",
    "--confirm-production": "confirmProduction",
} as const;

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type GlobalOptionKey = typeof GLOBAL_FLAGS[keyof typeof GLOBAL_FLAGS];

function globalFlag(arg: string): keyof typeof GLOBAL_FLAGS | null {
    return (Object.keys(GLOBAL_FLAGS) as Array<keyof typeof GLOBAL_FLAGS>)
        .find((flag) => arg === flag || arg.startsWith(`${flag}=`)) ?? null;
}

function globalFlagValue(args: string[], index: number, flag: string): { value: string; consumed: number } {
    const inlineValue = args[index].slice(flag.length + 1);
    if (args[index].startsWith(`${flag}=`)) {
        if (!inlineValue) throw new Error(`${flag} requires a value`);
        return { value: inlineValue, consumed: 1 };
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return { value, consumed: 2 };
}

export function normalizeEnvironmentName(name: string): string {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
        throw new Error("--env and SUPACLOUD_ENV must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
    }
    const normalized = name.toLowerCase();
    return normalized === "prod" || normalized === "production" ? "production" : normalized;
}

export function parseGlobalOptions(args: string[]): GlobalCliOptions {
    const values: Partial<Record<GlobalOptionKey, string>> = {};
    const remainingArgs: string[] = [];

    for (let index: number = 0; index < args.length;) {
        const flag = globalFlag(args[index]);
        if (!flag) {
            remainingArgs.push(args[index]);
            index += 1;
            continue;
        }
        const key = GLOBAL_FLAGS[flag];
        if (values[key] !== undefined) throw new Error(`${flag} may be provided only once`);
        const parsed = globalFlagValue(args, index, flag);
        values[key] = parsed.value;
        index += parsed.consumed;
    }

    if (values.environmentName && values.envFile) {
        throw new Error("--env and --env-file are mutually exclusive");
    }
    if (values.environmentName) normalizeEnvironmentName(values.environmentName);

    return { ...values, args: remainingArgs };
}
