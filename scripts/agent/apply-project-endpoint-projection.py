from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, content: str) -> None:
    Path(path).write_text(content)


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one replacement in {path}, found {count}: {old[:140]!r}")
    write(path, content.replace(old, new, 1))


def main() -> None:
    replace_once(
        "packages/management-api/src/routes/projects.ts",
        'import { projectCrudRoutes } from "./project-crud";\n',
        'import { projectEndpointRoutes } from "./project-endpoints";\nimport { projectCrudRoutes } from "./project-crud";\n',
    )
    replace_once(
        "packages/management-api/src/routes/projects.ts",
        'export const projectRoutes = new Elysia()\n  .use(projectCrudRoutes)\n',
        'export const projectRoutes = new Elysia()\n  .use(projectEndpointRoutes)\n  .use(projectCrudRoutes)\n',
    )
    replace_once(
        "packages/management-api/src/services/project.service.ts",
        '''  async listProjects(): Promise<ProjectResponse[]> {\n    const projects = await projectRepository.findAll();\n    return Promise.all(projects.map((p) => this.toResponse(p)));\n  }\n\n  // Get project details\n''',
        '''  async listProjects(): Promise<ProjectResponse[]> {\n    const projects = await projectRepository.findAll();\n    return Promise.all(projects.map((p) => this.toResponse(p)));\n  }\n\n  async listProjectDetails(): Promise<ProjectDetailResponse[]> {\n    const projects = await projectRepository.findAll();\n    return Promise.all(projects.map((project) => this.toDetailResponse(project)));\n  }\n\n  // Get project details\n''',
    )

    for path in [
        "packages/cli/src/shared/tools/project-cli-tools.ts",
        "packages/admin/src/shared/tools/project-cli-tools.ts",
    ]:
        replace_once(
            path,
            '} from "./project-read-projection";\n',
            '} from "./project-read-projection";\nimport { projectEndpointListRead, projectEndpointsRead } from "./project-endpoint-projection";\n',
        )

    replace_once(
        "packages/cli/src/shared/tools/project-cli-tools.ts",
        '''Actions: get, pause, restore, health, logs, api_keys, settings, tasks, task_detail, task_cancel, task_retry, task_stats, dlq, background_settings, update_background_settings`,\n        {\n            action: withDescription(stringEnum([\n                "get", "pause", "restore", "health", "logs", "api_keys", "settings",\n''',
        '''Actions: list, get, endpoints, pause, restore, health, logs, api_keys, settings, tasks, task_detail, task_cancel, task_retry, task_stats, dlq, background_settings, update_background_settings`,\n        {\n            action: withDescription(stringEnum([\n                "list", "get", "endpoints", "pause", "restore", "health", "logs", "api_keys", "settings",\n''',
    )
    replace_once(
        "packages/cli/src/shared/tools/project-cli-tools.ts",
        '''        async ({ action, ref, log_type, task_id, limit, concurrency, max_attempts }) => {\n            const resolvedRef = resolveRef(ref, projectRef);\n            let text: string;\n\n            switch (action) {\n                case "get":\n''',
        '''        async ({ action, ref, log_type, task_id, limit, concurrency, max_attempts }) => {\n            if (action === "list") {\n                return {\n                    isError: true,\n                    content: [{\n                        type: "text" as const,\n                        text: "Project enumeration is a platform operation.\\nUse: supacloud-admin project list",\n                    }],\n                };\n            }\n            const resolvedRef = resolveRef(ref, projectRef);\n            let text: string;\n\n            switch (action) {\n                case "get":\n''',
    )
    replace_once(
        "packages/cli/src/shared/tools/project-cli-tools.ts",
        '''                        resolvedRef,\n                    ));\n                case "pause":\n''',
        '''                        resolvedRef,\n                    ));\n                case "endpoints":\n                    return projectReadResponse(projectEndpointsRead(\n                        await http.get(`/v1/projects/${resolvedRef}/endpoints`, {\n                            maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,\n                        }),\n                        resolvedRef,\n                    ));\n                case "pause":\n''',
    )

    replace_once(
        "packages/cli/src/shared/tools/project-cli-tools.ts",
        '''Actions: list, create, get, delete, pause, restore, restart, settings, update_settings, api_keys, health, logs, tasks, task_detail, task_cancel, task_retry, task_stats, dlq, background_settings, update_background_settings`,\n''',
        '''Actions: list, list_endpoints, create, get, endpoints, delete, pause, restore, restart, settings, update_settings, api_keys, health, logs, tasks, task_detail, task_cancel, task_retry, task_stats, dlq, background_settings, update_background_settings`,\n''',
    )
    replace_once(
        "packages/cli/src/shared/tools/project-cli-tools.ts",
        '''                "list", "create", "get", "delete", "pause", "restore",\n''',
        '''                "list", "list_endpoints", "create", "get", "endpoints", "delete", "pause", "restore",\n''',
    )
    replace_once(
        "packages/cli/src/shared/tools/project-cli-tools.ts",
        '''            ref: optional(Type.String(), "Project ref (required for most actions except 'list' and 'create')"),\n''',
        '''            ref: optional(Type.String(), "Project ref (required for most actions except 'list', 'list_endpoints', and 'create')"),\n''',
    )
    replace_once(
        "packages/cli/src/shared/tools/project-cli-tools.ts",
        '''                case "list":\n                    return projectReadResponse(projectListRead(await http.get("/v1/projects", {\n                        maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,\n                    })));\n                case "create": {\n''',
        '''                case "list":\n                    return projectReadResponse(projectListRead(await http.get("/v1/projects", {\n                        maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,\n                    })));\n                case "list_endpoints":\n                    return projectReadResponse(projectEndpointListRead(await http.get("/v1/projects/endpoints", {\n                        maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,\n                    })));\n                case "create": {\n''',
    )
    replace_once(
        "packages/cli/src/shared/tools/project-cli-tools.ts",
        '''                        resolvedRef,\n                    ));\n                }\n                case "delete": {\n''',
        '''                        resolvedRef,\n                    ));\n                }\n                case "endpoints": {\n                    const resolvedRef = resolveRef(ref);\n                    return projectReadResponse(projectEndpointsRead(\n                        await http.get(`/v1/projects/${resolvedRef}/endpoints`, {\n                            maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,\n                        }),\n                        resolvedRef,\n                    ));\n                }\n                case "delete": {\n''',
    )

    replace_once(
        "packages/admin/src/shared/tools/project-cli-tools.ts",
        '''"Platform-level project lifecycle management. Actions: list, create, get, delete, pause, restore, restart, settings, update_settings, api_keys, health, logs, tasks, services, runtime_snapshot, service_control",\n''',
        '''"Platform-level project lifecycle management. Actions: list, list_endpoints, create, get, endpoints, delete, pause, restore, restart, settings, update_settings, api_keys, health, logs, tasks, services, runtime_snapshot, service_control",\n''',
    )
    replace_once(
        "packages/admin/src/shared/tools/project-cli-tools.ts",
        '''                "list", "create", "get", "delete", "pause", "restore",\n''',
        '''                "list", "list_endpoints", "create", "get", "endpoints", "delete", "pause", "restore",\n''',
    )
    replace_once(
        "packages/admin/src/shared/tools/project-cli-tools.ts",
        '''            ref: optional(Type.String(), "[*] Project ref (required for most actions except 'list' and 'create')"),\n''',
        '''            ref: optional(Type.String(), "[*] Project ref (required for most actions except 'list', 'list_endpoints', and 'create')"),\n''',
    )
    replace_once(
        "packages/admin/src/shared/tools/project-cli-tools.ts",
        '''                case "list":\n                    return projectReadResponse(projectListRead(await http.get("/v1/projects", {\n                        maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,\n                    })));\n                case "create": {\n''',
        '''                case "list":\n                    return projectReadResponse(projectListRead(await http.get("/v1/projects", {\n                        maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,\n                    })));\n                case "list_endpoints":\n                    return projectReadResponse(projectEndpointListRead(await http.get("/v1/projects/endpoints", {\n                        maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,\n                    })));\n                case "create": {\n''',
    )
    replace_once(
        "packages/admin/src/shared/tools/project-cli-tools.ts",
        '''                        resolvedRef,\n                    ));\n                }\n                case "delete": {\n''',
        '''                        resolvedRef,\n                    ));\n                }\n                case "endpoints": {\n                    const resolvedRef = resolveRef(ref);\n                    return projectReadResponse(projectEndpointsRead(\n                        await http.get(`/v1/projects/${resolvedRef}/endpoints`, {\n                            maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,\n                        }),\n                        resolvedRef,\n                    ));\n                }\n                case "delete": {\n''',
    )

    replace_once(
        "packages/cli/src/shared/execution-policy.ts",
        '''        read: ["get", "health", "logs", "api_keys", "settings", "tasks", "task_detail", "task_stats", "dlq", "background_settings"],\n''',
        '''        read: ["list", "get", "endpoints", "health", "logs", "api_keys", "settings", "tasks", "task_detail", "task_stats", "dlq", "background_settings"],\n''',
    )
    replace_once(
        "packages/admin/src/shared/execution-policy.ts",
        '''            "list", "get", "settings", "api_keys", "health", "logs", "tasks", "services", "runtime_snapshot",\n''',
        '''            "list", "list_endpoints", "get", "endpoints", "settings", "api_keys", "health", "logs", "tasks", "services", "runtime_snapshot",\n''',
    )
    replace_once(
        "packages/admin/src/shared/execution-policy.ts",
        '''        return ["list", "create"].includes(action) ? null : stringArgument(args, "ref");\n''',
        '''        return ["list", "list_endpoints", "create"].includes(action) ? null : stringArgument(args, "ref");\n''',
    )

    replace_once(
        "packages/cli/src/index.ts",
        '''    "get", "pause", "restore", "health", "logs", "api_keys", "settings",\n''',
        '''    "list", "get", "endpoints", "pause", "restore", "health", "logs", "api_keys", "settings",\n''',
    )
    replace_once(
        "packages/cli/src/index.ts",
        '''  ${preferredCommand} project get\n  ${preferredCommand} project logs --log_type database\n''',
        '''  ${preferredCommand} project get\n  ${preferredCommand} project endpoints --ref abc123\n  ${preferredCommand} project logs --log_type database\n''',
    )
    replace_once(
        "packages/admin/src/index.ts",
        '''  supacloud-admin project list\n  supacloud-admin project services --ref abc123\n''',
        '''  supacloud-admin project list\n  supacloud-admin project endpoints --ref abc123\n  supacloud-admin project list_endpoints\n  supacloud-admin project services --ref abc123\n''',
    )

    replace_once(
        "packages/cli/skills/supacloud-cli/references/command-map.md",
        '''| Inspect project health/logs/tasks | `project`, `queue`, `task_events`, `diagnostics` | Prefer bounded reads |\n''',
        '''| Inspect project health/logs/tasks | `project`, `queue`, `task_events`, `diagnostics` | Prefer bounded reads |\n| Inspect authoritative API/Auth/Studio endpoints | `project endpoints` | Project-scoped, secret-free projection |\n''',
    )
    replace_once(
        "packages/cli/skills/supacloud-cli/references/command-map.md",
        '''- `project`: project metadata, health, logs, API keys/settings, background tasks, retry/cancel, DLQ, and background settings.\n''',
        '''- `project`: project metadata, authoritative endpoint projection, health, logs, API keys/settings, background tasks, retry/cancel, DLQ, and background settings. Cross-project enumeration remains an admin operation.\n''',
    )
    replace_once(
        "docs/README.md",
        '''- [CLI Guide](./cli-guide.md) - User CLI vs admin CLI entrypoints and command boundaries\n''',
        '''- [CLI Guide](./cli-guide.md) - User CLI vs admin CLI entrypoints and command boundaries\n- [Project Endpoint Projection](./project-endpoint-projection.md) - Authoritative API/Auth/Studio origins, CLI boundaries, and legacy backup compatibility boundary\n''',
    )


if __name__ == "__main__":
    main()
