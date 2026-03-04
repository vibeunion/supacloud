import { logger } from "./logger";

export interface RetryOptions {
    maxRetries?: number;
    initialDelayMs?: number;
    backoffFactor?: number;
    shouldRetry?: (error: any) => boolean;
}

/**
 * 通用重试包裹函数
 */
export async function withRetry<T>(
    operationName: string,
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const {
        maxRetries = 3,
        initialDelayMs = 100,
        backoffFactor = 2,
        shouldRetry = () => true,
    } = options;

    let retries = 0;
    let delay = initialDelayMs;

    while (true) {
        try {
            return await fn();
        } catch (error: any) {
            if (retries >= maxRetries || !shouldRetry(error)) {
                logger.error(`Operation [${operationName}] failed permanently after ${retries} retries`, { error: error.message });
                throw error;
            }

            retries++;
            logger.warn(`Operation [${operationName}] failed, retrying (${retries}/${maxRetries})...`, { error: error.message, nextDelayMs: delay });

            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= backoffFactor;
        }
    }
}
