const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;
const FORBIDDEN_ENVIRONMENT_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const UNSUPPORTED_ENVIRONMENT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export function renderSystemdEnvLine(name: string, value: string): string {
    if (!ENVIRONMENT_NAME.test(name)) {
        throw new Error(`Invalid EnvironmentFile variable name: ${name}`);
    }
    if (FORBIDDEN_ENVIRONMENT_CONTROL_CHARACTERS.test(value)) {
        throw new Error(`${name} EnvironmentFile value contains a forbidden control character`);
    }
    return `${name}=${JSON.stringify(value)}`;
}

/**
 * Quote a value for systemd EnvironmentFile.
 *
 * systemd uses its own quoting rules inside EnvironmentFile:
 *   - Double-quoted values support backslash escaping
 *   - Single-quoted values pass content through verbatim
 *   - Unquoted values cannot contain spaces, quotes, or newlines
 *
 * JSON/JWK values contain double quotes, so wrap them in single quotes to
 * preserve the content exactly.
 */
export function quoteSystemdEnvValue(value: string): string {
    if (UNSUPPORTED_ENVIRONMENT_CONTROL_CHARACTERS.test(value)) {
        throw new Error("systemd EnvironmentFile value contains a forbidden control character");
    }
    if (value.includes('"')) {
        if (!value.includes("'")) {
            return `'${value}'`;
        }
    }
    return `"${value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")}"`;
}
