import type { HttpTransport as AdminHttpTransport } from "../transports/http";
import {
    registerGatewayTools as registerCliGatewayTools,
} from "../../../../cli/src/shared/tools/gateway-tools";

export function registerGatewayTools(
    server: Parameters<typeof registerCliGatewayTools>[0],
    http: AdminHttpTransport,
    options: { projectRef?: string } = {},
): void {
    registerCliGatewayTools(server, http, { ...options, refPriority: "project" });
}
