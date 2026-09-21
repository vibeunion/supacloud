import { Flow } from "@pgflow/dsl";

export default new Flow<{ value: number; delayMs?: number }>({
    slug: "self_hosted_example", timeout: 5, maxAttempts: 3, baseDelay: 1,
}).step({ slug: "echo" }, async (input) => {
    if (input.delayMs) await Bun.sleep(Math.min(input.delayMs, 3000));
    return { value: input.value };
});
