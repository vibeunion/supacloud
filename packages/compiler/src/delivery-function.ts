import { relativeImportPath } from "./util";

interface DeliveryFunctionHost {
  fetch(request: Request): Response | Promise<Response>;
}

/**
 * Wrap a module-backed Function target in the host-owned application factory.
 * The generated application is already in scope as `createCompiledModules`.
 */
export function renderDeliveryFunctionEntry(generatedDirectory: string, hostPath: string): string {
  const specifier = relativeImportPath(generatedDirectory, hostPath);
  return `
import * as deliveryFunctionHostModule from ${JSON.stringify(specifier)};

type DeliveryFunctionHost = {
  fetch(request: Request): Response | Promise<Response>;
};

const createDeliveryFunctionHost = (deliveryFunctionHostModule as {
  createDeliveryApplication?: (
    modules: ReturnType<typeof createCompiledModules>,
    lifecycle: { signal: AbortSignal },
  ) => DeliveryFunctionHost | Promise<DeliveryFunctionHost>;
}).createDeliveryApplication;
if (typeof createDeliveryFunctionHost !== "function") {
  throw new Error("Invalid delivery Function host.");
}
const deliveryCreateHost = createDeliveryFunctionHost;

const deliveryFunctionLifecycle = new AbortController();
let deliveryFunctionHost: Promise<DeliveryFunctionHost> | undefined;
function deliveryHost(): Promise<DeliveryFunctionHost> {
  return deliveryFunctionHost ??= Promise.resolve(
    deliveryCreateHost(createCompiledModules(), { signal: deliveryFunctionLifecycle.signal }),
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    return (await deliveryHost()).fetch(request);
  },
};
`;
}

/** Re-export a standalone Edge Function entrypoint without requiring a compiler app graph. */
export function renderStandaloneFunctionEntry(generatedDirectory: string, entrypointPath: string): string {
  const specifier = relativeImportPath(generatedDirectory, entrypointPath);
  return `
import * as deliveryFunctionEntry from ${JSON.stringify(specifier)};

const deliveryFunctionDefault: unknown = (deliveryFunctionEntry as { default?: unknown }).default
  ?? deliveryFunctionEntry;
export default deliveryFunctionDefault;
`;
}
