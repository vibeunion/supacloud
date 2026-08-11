export interface GlobalAdminOptions {
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

interface ParsedGlobalArgument {
    optionKey?: GlobalOptionKey;
    optionValue?: string;
    commandArgument?: string;
    consumed: number;
}

function globalFlag(argument: string): keyof typeof GLOBAL_FLAGS | null {
    return (Object.keys(GLOBAL_FLAGS) as Array<keyof typeof GLOBAL_FLAGS>)
        .find((flag) => argument === flag || argument.startsWith(`${flag}=`)) ?? null;
}

function globalFlagValue(
    args: string[],
    index: number,
    flag: string,
): { flagValue: string; consumed: number } {
    if (args[index].startsWith(`${flag}=`)) {
        const inlineValue = args[index].slice(flag.length + 1);
        if (!inlineValue) throw new Error(`${flag} requires a value`);
        return { flagValue: inlineValue, consumed: 1 };
    }
    const followingValue = args[index + 1];
    if (!followingValue || followingValue.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return { flagValue: followingValue, consumed: 2 };
}

export function normalizeEnvironmentName(name: string): string {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
        throw new Error("--env and SUPACLOUD_ENV must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
    }
    const normalized = name.toLowerCase();
    return normalized === "prod" || normalized === "production" ? "production" : normalized;
}

function parseGlobalArgument(
    args: string[],
    index: number,
    selectedOptions: Partial<Record<GlobalOptionKey, string>>,
): ParsedGlobalArgument {
    const flag = globalFlag(args[index]);
    if (!flag) return { commandArgument: args[index], consumed: 1 };
    const optionKey = GLOBAL_FLAGS[flag];
    if (selectedOptions[optionKey] !== undefined) {
        throw new Error(`${flag} may be provided only once`);
    }
    const parsedFlag = globalFlagValue(args, index, flag);
    return { optionKey, optionValue: parsedFlag.flagValue, consumed: parsedFlag.consumed };
}

function validateEnvironmentSelection(selectedOptions: Partial<Record<GlobalOptionKey, string>>): void {
    if (selectedOptions.environmentName && selectedOptions.envFile) {
        throw new Error("--env and --env-file are mutually exclusive");
    }
    if (selectedOptions.environmentName) normalizeEnvironmentName(selectedOptions.environmentName);
}

export function parseGlobalAdminOptions(args: string[]): GlobalAdminOptions {
    const selectedOptions: Partial<Record<GlobalOptionKey, string>> = {};
    const commandArgs: string[] = [];

    for (let index = 0; index < args.length;) {
        const parsedArgument = parseGlobalArgument(args, index, selectedOptions);
        if (parsedArgument.commandArgument !== undefined) {
            commandArgs.push(parsedArgument.commandArgument);
        } else if (parsedArgument.optionKey && parsedArgument.optionValue !== undefined) {
            selectedOptions[parsedArgument.optionKey] = parsedArgument.optionValue;
        }
        index += parsedArgument.consumed;
    }

    validateEnvironmentSelection(selectedOptions);
    return { ...selectedOptions, args: commandArgs };
}
