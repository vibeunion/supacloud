import { z } from "zod";

interface CliRunOptions {
    commandName?: string;
}

export async function runCli(
    cliTools: Record<string, { schema: any; callback: (args: any) => Promise<any> }>,
    args: string[],
    options: CliRunOptions = {}
) {
    const commandName = options.commandName || "supacloud";
    const formatAvailableCommands = () =>
        Object.keys(cliTools)
            .filter((k) => !["setup_help", "deploy_web_console"].includes(k))
            .join("\n  ");

    const getSchemaShape = (schema: any): Record<string, any> => {
        if (!schema) return {};
        if (typeof schema?.safeParse === "function") {
            const shape = schema?._def?.shape;
            if (typeof shape === "function") return shape();
            return shape || {};
        }
        if (
            typeof schema === "object" &&
            !Array.isArray(schema) &&
            !schema.shape &&
            !schema._def
        ) {
            return schema;
        }
        if (schema.shape) return schema.shape;
        if (schema._def?.shape) {
            return typeof schema._def.shape === "function" ? schema._def.shape() : schema._def.shape;
        }
        return {};
    };

    const getEnumOptions = (field: any): string[] => {
        if (Array.isArray(field?.options)) return field.options;
        if (Array.isArray(field?._def?.values)) return field._def.values;
        if (Array.isArray(field?._def?.entries)) return field._def.entries;
        return [];
    };

    const unwrapField = (field: any): any => field?._def?.innerType ?? field;

    const getDescription = (field: any): string => field?.description ?? field?._def?.description ?? "";

    const formatToolHelp = (toolName: string, tool: { schema: any }) => {
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
        tool: { schema: any }
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
            const key = arg.slice(2);
            let val: any = true;
            if (i + 1 < args.length && !args[i+1].startsWith("--")) {
                val = args[++i];
                // basic coercion
                if (val === "true") val = true;
                else if (val === "false") val = false;
                else if (!isNaN(Number(val)) && val.trim() !== '') val = Number(val);
            }
            parsedArgs[key] = val;
        }
    }
    
    try {
        const validator = (() => {
            if (!tool.schema) return null;
            if (typeof tool.schema.safeParse === "function") return tool.schema;
            if (typeof tool.schema === "object" && !Array.isArray(tool.schema)) {
                return z.object(tool.schema).strict();
            }
            return null;
        })();

        const validatedArgs = validator
            ? (() => {
                const result = validator.safeParse(parsedArgs);
                if (!result.success) {
                    const details = result.error.issues.map((issue: { path: Array<string | number>; message: string }) => {
                        const path = issue.path.length ? issue.path.join(".") : "args";
                        return `- ${path}: ${issue.message}`;
                    }).join("\n");
                    throw new Error(`Invalid arguments:\n${details}`);
                }
                return result.data;
            })()
            : parsedArgs;

        const result = await tool.callback(validatedArgs);
        if (result && result.content && Array.isArray(result.content)) {
            for (const c of result.content) {
                if (c.type === "text") {
                    console.log(c.text);
                }
            }
        } else {
            console.log(JSON.stringify(result, null, 2));
        }
        process.exit(0);
    } catch (err: any) {
        console.error(`❌ Error: ${err.message}`);
        if (err.message?.includes("required")) {
            console.error(`Hint: Pass arguments like --ref YOUR_REF`);
        }
        process.exit(1);
    }
}
