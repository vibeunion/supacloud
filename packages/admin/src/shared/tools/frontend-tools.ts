import { Type } from "typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { HttpTransport } from "../transports/http";
import { registerTool, type ToolServer } from "@supacloud/cli/tool-runtime";
import {
    activateFrontendRelease,
    getActiveFrontendRelease,
    getFrontendRelease,
    listFrontendReleases,
    rollbackFrontendRelease,
    uploadFrontendRelease,
} from "./frontend-release-control";

export function registerFrontendTools(server: ToolServer, http: HttpTransport): void {
    registerTool(server,
        "frontend",
        `Immutable prebuilt frontend release control.
Actions: list_releases, get_active_release, get_release, upload_release, activate_release, rollback`,
        {
            action: withDescription(stringEnum([
                "list_releases", "get_active_release", "get_release", "upload_release", "activate_release", "rollback",
            ]), "Action"),
            ref: optional(Type.String(), "Project ref"),
            id: optional(Type.String(), "Deployment ID"),
            zip_path: optional(Type.String(), "[upload_release] Local ZIP file path"),
            release_id: optional(Type.String(), "[get_release/activate_release] SHA-256 release ID; [rollback] optional, defaults to journal-verified previous release"),
            expected_active_release_id: optional(Type.String(), "[activate_release] Current release SHA-256 or absent"),
            expected_activation_id: optional(Type.String(), "[activate_release] Current activation UUIDv4 or absent"),
            mutation_id: optional(Type.String(), "[activate_release] Required retry-stable UUIDv4"),
            cursor: optional(Type.String(), "[list_releases] Last release SHA-256 cursor"),
            limit: optional(Type.Number(), "[list_releases] Page size, 1-100 (default 50)"),
        },
        async (args) => {
            const {
                action, ref, id, zip_path, release_id,
                expected_active_release_id, expected_activation_id, mutation_id, cursor, limit,
            } = args;
            function need<T>(f: string, v: T): asserts v is NonNullable<T> {
                if (!v) throw new Error(`'${f}' required for '${action}'`);
            }
            switch (action) {
                case "list_releases":
                    need("ref", ref); need("id", id);
                    return listFrontendReleases(http, ref, id, cursor, limit);
                case "get_release":
                    need("ref", ref); need("id", id); need("release_id", release_id);
                    return getFrontendRelease(http, ref, id, release_id);
                case "get_active_release":
                    need("ref", ref); need("id", id);
                    return getActiveFrontendRelease(http, ref, id);
                case "upload_release":
                    need("ref", ref); need("id", id); need("zip_path", zip_path);
                    return uploadFrontendRelease(http, ref, id, zip_path);
                case "activate_release":
                    need("ref", ref); need("id", id); need("release_id", release_id);
                    need("expected_active_release_id", expected_active_release_id);
                    need("expected_activation_id", expected_activation_id);
                    need("mutation_id", mutation_id);
                    return activateFrontendRelease(http, {
                        projectRef: ref,
                        deploymentId: id,
                        releaseId: release_id,
                        expectedActiveReleaseId: expected_active_release_id,
                        expectedActivationId: expected_activation_id,
                        mutationId: mutation_id,
                    });
                case "rollback":
                    need("ref", ref); need("id", id);
                    return rollbackFrontendRelease(http, ref, id, release_id);
                default:
                    throw new Error("Unknown immutable frontend release action");
            }
        }
    );
}
