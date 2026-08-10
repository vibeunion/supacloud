import type { TSchema } from "@sinclair/typebox";
import {
    parseToolArguments,
    schemaDescription,
    schemaEnumValues,
    schemaProperties,
} from "./schema";
import type { ToolSchema } from "./schema";
import { redactSshOutput } from "./transports/ssh";

interface CliRunOptions {
    commandName?: string;
}

interface CliToolResult {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
}

function coerceCliValue(value: string): string | number | boolean {
    if (value === "true") return true;
    if (value === "false") return false;
    if (value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
    return value;
}

function sanitizedCliDiagnostic(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactSshOutput(message)
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, 1_000);
}

function nestedCliDiagnostics(error: unknown): string[] {
    if (error instanceof AggregateError) {
        return [
            sanitizedCliDiagnostic(error),
            ...error.errors.flatMap(candidate => nestedCliDiagnostics(candidate)),
        ];
    }
    return [sanitizedCliDiagnostic(error)];
}

export function formatCliError(error: unknown): string {
    const summary = sanitizedCliDiagnostic(error);
    const diagnostics = [...new Set(nestedCliDiagnostics(error))].filter(message => message && message !== summary);
    if (diagnostics.length === 0) return summary;
    return `${summary}\nDetails:\n${diagnostics.map(message => `  - ${message}`).join("\n")}`;
}

export async function runCli(
    cliTools: Record<string, { schema: ToolSchema; callback: (args: any) => Promise<any> }>,
    args: string[],
    options: CliRunOptions = {}
) {
    const commandName = options.commandName || "supacloud-admin";
    const formatAvailableCommands = () =>
        Object.keys(cliTools)
            .filter((k) => !["setup_help", "deploy_web_console"].includes(k))
            .join("\n  ");

    const getSchemaShape = (schema: ToolSchema) => schemaProperties(schema);
    const getEnumOptions = (field: TSchema) => schemaEnumValues(field);
    const getDescription = (field: TSchema) => schemaDescription(field);

    const formatToolHelp = (toolName: string, tool: { schema: ToolSchema }) => {
        const shape = getSchemaShape(tool.schema);
        const actionField = shape.action;
        const actionOptions = getEnumOptions(actionField);
        const otherFields = Object.entries(shape).filter(([name]) => name !== "action");

        const actionLines = actionOptions.length
            ? `Available actions:\n  ${actionOptions.join("\n  ")}`
            : "This command does not declare action metadata.";

        const argLines = otherFields.length
            ? otherFields
                .map(([name, field]) => {
                    const description = getDescription(field) || "(no description)";
                    return `  --${name}  ${description}`;
                })
                .join("\n")
            : "  (no additional flags)";

        return [
            `Usage: ${commandName} ${toolName} <action> [--flags]`,
            "",
            actionLines,
            "",
            "Flags:",
            argLines,
        ].join("\n");
    };

    const formatActionHelp = (
        toolName: string,
        action: string,
        tool: { schema: ToolSchema }
    ) => {
        const shape = getSchemaShape(tool.schema);
        const otherFields = Object.entries(shape).filter(([name]) => name !== "action");
        const relevantFields = otherFields.filter(([, field]) => {
            const description = getDescription(field);
            return description.includes(`[${action}]`) || description.includes("[*]");
        });

        const argLines = relevantFields.length
            ? relevantFields
                .map(([name, field]) => `  --${name}  ${getDescription(field) || "(no description)"}`)
                .join("\n")
            : "  (no documented action-specific flags)";

        return [
            `Usage: ${commandName} ${toolName} ${action} [--flags]`,
            "",
            "Flags:",
            argLines,
        ].join("\n");
    };

    const toolName = args[0];
    const tool = cliTools[toolName];
    
    if (!tool) {
        console.error(`❌ Unknown command: ${toolName}`);
        console.error(`Available commands: \n  ${formatAvailableCommands()}`);
        process.exit(1);
    }

    if (args.length === 1 || args[1] === "--help" || args[1] === "-h") {
        console.error(formatToolHelp(toolName, tool));
        process.exit(0);
    }

    if (
        args.length > 2 &&
        !args[1].startsWith("--") &&
        (args[2] === "--help" || args[2] === "-h")
    ) {
        console.error(formatActionHelp(toolName, args[1], tool));
        process.exit(0);
    }
    
    const parsedArgs: Record<string, any> = {};
    let startIdx = 1;

    // Check if there is an action argument (assuming index 1 is action if not starting with '--')
    if (args.length > 1 && !args[1].startsWith("--")) {
        parsedArgs.action = args[1];
        startIdx = 2;
    }
    
    for (let i = startIdx; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--") && arg.length > 2) {
            const rawFlag = arg.slice(2);
            const equalsIndex = rawFlag.indexOf("=");
            const key = equalsIndex >= 0 ? rawFlag.slice(0, equalsIndex) : rawFlag;
            let val: string | number | boolean = true;
            if (equalsIndex >= 0) {
                val = coerceCliValue(rawFlag.slice(equalsIndex + 1));
            } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                val = coerceCliValue(args[++i]);
            }
            parsedArgs[key] = val;
        }
    }
    
    try {
        const validatedArgs = parseToolArguments(tool.schema, parsedArgs);

        const result = await tool.callback(validatedArgs) as CliToolResult;
        if (result && result.content && Array.isArray(result.content)) {
            for (const c of result.content) {
                if (c.type === "text") {
                    console.log(c.text);
                }
            }
        } else {
            console.log(JSON.stringify(result, null, 2));
        }
        process.exit(result && typeof result === "object" && "isError" in result && result.isError === true ? 1 : 0);
    } catch (error: unknown) {
        const message = formatCliError(error);
        console.error(`❌ Error: ${message}`);
        if (message.includes("required")) {
            console.error(`Hint: Pass arguments like --ref YOUR_REF`);
        }
        process.exit(1);
    }
}
