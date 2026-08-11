import { Type } from "@sinclair/typebox";
import {
    fetchMutationStatus,
    isMutationId,
} from "../mutation-protocol";
import { projectRefPathSegment } from "../project-ref";
import { stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpTransport } from "../transports/http";
import {
    releaseControlFailure,
    releaseControlSuccess,
    type ReleaseControlToolResponse,
} from "./release-control-response";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>,
    ) => void;
};

function requiredText(args: Record<string, unknown>, name: string): string {
    const candidate = args[name];
    if (typeof candidate !== "string" || !candidate.trim()) throw new Error(`'${name}' is required for 'status'`);
    return candidate.trim();
}

async function mutationStatus(
    http: HttpTransport,
    args: Record<string, unknown>,
): Promise<ReleaseControlToolResponse> {
    const ref = requiredText(args, "ref");
    projectRefPathSegment(ref, "Mutations");
    const mutationId = requiredText(args, "mutation_id");
    if (!isMutationId(mutationId)) throw new Error("'mutation_id' must be a UUIDv4");
    const readback = await fetchMutationStatus(http, ref, mutationId);
    if (readback.kind === "unavailable") {
        return releaseControlFailure("mutations.status", "HTTP_ERROR", readback.httpStatus);
    }
    if (readback.kind === "invalid") {
        return releaseControlFailure("mutations.status", "INVALID_RESPONSE", null);
    }
    return releaseControlSuccess("mutations.status", { project_ref: ref, mutation: readback.mutation });
}

export function registerMutationTools(server: ToolServer, http: HttpTransport): void {
    server.tool("mutations", "Durable mutation status readback", MUTATION_TOOL_SCHEMA,
        (args) => mutationStatus(http, args));
}

const MUTATION_TOOL_SCHEMA: ToolSchema = {
    action: withDescription(stringEnum(["status"]), "Action"),
    ref: withDescription(Type.String(), "[status] Project ref"),
    mutation_id: withDescription(Type.String(), "[status] Client mutation UUID"),
};
