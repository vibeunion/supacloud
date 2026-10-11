export function outcomeUnknownGuidance(text: string): string | null {
    let payload: unknown;
    try {
        payload = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof payload !== "object" || payload === null
        || !("ok" in payload) || payload.ok !== false
        || !("error" in payload) || typeof payload.error !== "object"
        || payload.error === null || !("code" in payload.error)
        || payload.error.code !== "OUTCOME_UNKNOWN") return null;

    const data = payload as Record<string, unknown>;
    const ref = data.project_ref, id = data.application_id, environment = data.environment_id;
    const safeScope = typeof ref === "string" && /^[a-z0-9-]{1,20}$/.test(ref)
        && typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id)
        && typeof environment === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(environment);
    let command: string | undefined;
    if (safeScope && (data.operation === "applications.promote_application" || data.operation === "applications.reconcile_promotion")
        && typeof data.mutation_id === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.mutation_id)) {
        command = `supacloud-cli app promote-status --ref ${ref} --id ${id} --environment_id ${environment} --mutation_id ${data.mutation_id}`;
    } else if (safeScope && (data.operation === "applications.create_preview" || data.operation === "applications.cleanup_preview")) {
        command = `supacloud-cli app preview-list --ref ${ref} --id ${id} --environment_id ${environment}`;
    }
    return "OUTCOME_UNKNOWN：操作结果无法确认，服务端可能已经完成操作，但客户端未收到可验证的最终结果。"
        + "请先查询当前状态或操作回执，再决定是否重试；不要直接重复提交。"
        + (command ? `\n保持原 --env/--env-file 选择，先查询：${command}` : "");
}
