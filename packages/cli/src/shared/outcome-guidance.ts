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

    return "OUTCOME_UNKNOWN：操作结果无法确认，服务端可能已经完成操作，但客户端未收到可验证的最终结果。"
        + "请先查询当前状态或操作回执，再决定是否重试；不要直接重复提交。";
}
