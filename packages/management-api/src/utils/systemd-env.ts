/**
 * Quote a value for systemd EnvironmentFile.
 *
 * systemd uses its own quoting rules inside EnvironmentFile:
 *   - Double-quoted values support \\, \n, \t only, not \"
 *   - Single-quoted values pass content through verbatim
 *   - Unquoted values cannot contain spaces, quotes, or newlines
 *
 * JSON/JWK values contain double quotes, so wrap them in single quotes to
 * preserve the content exactly.
 */
export function quoteSystemdEnvValue(value: string): string {
    if (value.includes('"')) {
        if (value.includes("'")) {
            throw new Error("systemd EnvironmentFile values containing both single and double quotes are not supported");
        }
        return `'${value}'`;
    }
    return `"${value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}
