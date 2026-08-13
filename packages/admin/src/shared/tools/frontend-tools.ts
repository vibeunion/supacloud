import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { HttpTransport } from "../transports/http";
import {
    activateFrontendRelease,
    getFrontendRelease,
    listFrontendReleases,
    uploadFrontendRelease,
} from "./frontend-release-control";

export function registerFrontendTools(server: { tool: (...args: any[]) => void }, http: HttpTransport): void {
    server.tool(
        "frontend",
        `Immutable prebuilt frontend release control.
Actions: list_releases, get_release, upload_release, activate_release`,
        {
            action: withDescription(stringEnum([
                "list_releases", "get_release", "upload_release", "activate_release",
            ]), "Action"),
            ref: optional(Type.String(), "Project ref"),
            id: optional(Type.String(), "Deployment ID"),
            zip_path: optional(Type.String(), "[upload_release] Local ZIP file path"),
            release_id: optional(Type.String(), "[get_release/activate_release] SHA-256 release ID"),
            expected_active_release_id: optional(Type.String(), "[activate_release] Current release SHA-256 or absent"),
            expected_activation_id: optional(Type.String(), "[activate_release] Current activation UUIDv4 or absent"),
            mutation_id: optional(Type.String(), "[activate_release] Required retry-stable UUIDv4"),
            cursor: optional(Type.String(), "[list_releases] Last release SHA-256 cursor"),
            limit: optional(Type.Number(), "[list_releases] Page size, 1-100 (default 50)"),
        },
        async (args: any) => {
            const {
                action, ref, id, zip_path, release_id,
                expected_active_release_id, expected_activation_id, mutation_id, cursor, limit,
            } = args;
            const need = (f: string, v: any) => { if (!v) throw new Error(`'${f}' required for '${action}'`); };
            switch (action) {
                case "list_releases":
                    need("ref", ref); need("id", id);
                    return listFrontendReleases(http, ref, id, cursor, limit);
                case "get_release":
                    need("ref", ref); need("id", id); need("release_id", release_id);
                    return getFrontendRelease(http, ref, id, release_id);
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
                default:
                    throw new Error("Unknown immutable frontend release action");
            }
        }
    );
}
