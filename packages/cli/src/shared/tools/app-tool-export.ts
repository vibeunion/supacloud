import type { ModuleNode } from "@supacloud/compiler";

export interface AppManifest {
    version: number;
    modules: ModuleNode[];
    externalTokens: string[];
}

export interface ToolSchemaProperty {
    type: string;
    description: string;
    additionalProperties?: boolean;
}

export interface ToolInputSchema {
    type: "object";
    properties: Record<string, ToolSchemaProperty>;
    required: string[];
    additionalProperties?: boolean;
}

export interface OpenAIToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: ToolInputSchema;
    };
}

export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: ToolInputSchema;
    annotations: {
        readOnly: boolean;
        audited: boolean;
        permission: string;
        httpPath?: string;
        httpMethod?: string;
    };
}

export interface ExportedToolDefinitions {
    openai: OpenAIToolDefinition[];
    mcp: McpToolDefinition[];
}

interface CommandRoute {
    httpMethod: string;
    path: string;
    bodySchema?: string;
    paramsSchema?: string;
    querySchema?: string;
}

function sanitizeToolName(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
    return sanitized || "supacloud_command";
}

function uniqueToolName(name: string, moduleName: string, used: Set<string>): string {
    const base = sanitizeToolName(name);
    if (!used.has(base)) {
        used.add(base);
        return base;
    }

    const prefix = sanitizeToolName(moduleName).slice(0, 32);
    const candidateBase = `${prefix}_${base}`.slice(0, 64);
    let candidate = candidateBase;
    let suffix = 2;
    while (used.has(candidate)) {
        candidate = `${candidateBase.slice(0, 64 - String(suffix).length - 1)}_${suffix}`;
        suffix += 1;
    }
    used.add(candidate);
    return candidate;
}

function findRouteForCommand(manifest: AppManifest, commandClassName: string): CommandRoute | undefined {
    for (const module of manifest.modules) {
        for (const controller of module.controllers) {
            for (const route of controller.routes) {
                if (route.command !== commandClassName) continue;
                return {
                    httpMethod: route.method,
                    path: `${controller.path}${route.path}`,
                    bodySchema: route.body,
                    paramsSchema: route.params,
                    querySchema: route.query,
                };
            }
        }
    }
    return undefined;
}

function inputSchema(route: CommandRoute | undefined): ToolInputSchema {
    const properties: Record<string, ToolSchemaProperty> = {};

    if (route?.bodySchema) {
        properties.body = {
            type: "object",
            description: `Request body. Schema reference: ${route.bodySchema}`,
            additionalProperties: true,
        };
    }
    if (route?.paramsSchema) {
        properties.params = {
            type: "object",
            description: `Path parameters. Schema reference: ${route.paramsSchema}`,
            additionalProperties: true,
        };
    }
    if (route?.querySchema) {
        properties.query = {
            type: "object",
            description: `Query parameters. Schema reference: ${route.querySchema}`,
            additionalProperties: true,
        };
    }

    return {
        type: "object",
        properties,
        required: [],
        additionalProperties: Object.keys(properties).length === 0,
    };
}

function descriptionForCommand(
    command: ModuleNode["commands"][number],
    route: CommandRoute | undefined,
): string {
    const parts = [`Command ${command.name}`, `permission ${command.permission}`];
    if (command.transaction === "required") parts.push("transaction required");
    if (command.idempotency === "required") parts.push("idempotent");
    if (command.audit) parts.push(`audit ${command.audit}`);
    if (route) parts.push(`HTTP ${route.httpMethod} ${route.path}`);
    return `${parts.join("; ")}.`;
}

export function buildToolDefinitions(manifest: AppManifest): ExportedToolDefinitions {
    const openai: OpenAIToolDefinition[] = [];
    const mcp: McpToolDefinition[] = [];
    const usedNames = new Set<string>();

    for (const module of manifest.modules) {
        for (const command of module.commands) {
            if (!command.permission) continue;

            const route = findRouteForCommand(manifest, command.className);
            const name = uniqueToolName(command.name, module.name, usedNames);
            const description = descriptionForCommand(command, route);
            const parameters = inputSchema(route);

            openai.push({
                type: "function",
                function: { name, description, parameters },
            });
            mcp.push({
                name,
                description,
                inputSchema: parameters,
                annotations: {
                    readOnly: false,
                    audited: !!command.audit,
                    permission: command.permission,
                    ...(route ? { httpPath: route.path, httpMethod: route.httpMethod } : {}),
                },
            });
        }
    }

    return { openai, mcp };
}

