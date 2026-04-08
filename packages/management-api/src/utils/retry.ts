import { logger } from "./logger";

export interface RetryOptions {
    maxRetries?: number;
    initialDelayMs?: number;
    backoffFactor?: number;
    shouldRetry?: (error: unknown) => boolean;
}

/**
 * General retry wrapper function
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
        } catch (error: unknown) {
            if (retries >= maxRetries || !shouldRetry(error)) {
                logger.error(`Operation [${operationName}] failed permanently after ${retries} retries`, { error: (error instanceof Error ? error.message : String(error)) });
                throw error;
            }

            retries++;
            logger.warn(`Operation [${operationName}] failed, retrying (${retries}/${maxRetries})...`, { error: (error instanceof Error ? error.message : String(error)), nextDelayMs: delay });

            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= backoffFactor;
        }
    }
}
