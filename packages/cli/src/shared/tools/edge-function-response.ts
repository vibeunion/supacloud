const CANONICAL_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SAFE_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIVATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEGACY_ACTIVATION_ID = "legacy";
const FUNCTION_FRAMEWORKS = ["fetch", "elysia", "hono", "sveltekit-function"] as const;
type FunctionFramework = typeof FUNCTION_FRAMEWORKS[number];
const LIST_STRING_FIELDS = [
    "id",
    "name",
    "status",
    "entrypoint_path",
    "created_at",
    "updated_at",
    "framework",
] as const;
const LIST_BOOLEAN_FIELDS = ["verify_jwt", "import_map"] as const;

export type FunctionConfigInput = {
    verify_jwt?: boolean;
    background_routes?: string[];
    framework?: FunctionFramework;
};

export type FunctionIdentityResponse = {
    project_ref: string;
    slug: string;
    active_version: string;
    activation_id: string;
    verify_jwt: boolean;
    background_routes: string[];
    framework?: FunctionFramework;
    version?: string;
    import_map?: string;
    entrypoint?: string;
};

export type FunctionConfigMutationExpectation = {
    projectRef: string;
    slug: string;
    expectedActivationId: string;
    config: FunctionConfigInput;
};

export type FunctionDeleteExpectation = {
    projectRef: string;
    slug: string;
    expectedActivationId: string;
};

function objectRecord(candidate: unknown): Record<string, unknown> | null {
    return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

function canonicalVersion(candidate: unknown): candidate is string {
    return typeof candidate === "string"
        && CANONICAL_VERSION_PATTERN.test(candidate)
        && Number.isSafeInteger(Number(candidate));
}

function stringRoutes(candidate: unknown): candidate is string[] {
    return Array.isArray(candidate) && candidate.every((route) => typeof route === "string");
}

function optionalTypedFields(
    source: Record<string, unknown>,
    fields: readonly string[],
    expectedType: "string" | "boolean",
): boolean {
    return fields.every((field) => source[field] === undefined || typeof source[field] === expectedType);
}

export function validObservedFunctionActivationId(candidate: unknown): candidate is string {
    return candidate === LEGACY_ACTIVATION_ID
        || (typeof candidate === "string" && ACTIVATION_ID_PATTERN.test(candidate));
}

export function validCommittedFunctionActivationId(candidate: unknown): candidate is string {
    return typeof candidate === "string" && ACTIVATION_ID_PATTERN.test(candidate);
}

function projectedFunctionListEntry(candidate: unknown): Record<string, unknown> | null {
    const functionRecord = objectRecord(candidate);
    if (!functionRecord
        || typeof functionRecord.slug !== "string"
        || !SAFE_SLUG_PATTERN.test(functionRecord.slug)
        || typeof functionRecord.version !== "number"
        || !Number.isSafeInteger(functionRecord.version)
        || functionRecord.version < 0
        || !validObservedFunctionActivationId(functionRecord.activation_id)
        || !optionalTypedFields(functionRecord, LIST_STRING_FIELDS, "string")
        || !optionalTypedFields(functionRecord, LIST_BOOLEAN_FIELDS, "boolean")
        || (functionRecord.framework !== undefined
            && !FUNCTION_FRAMEWORKS.includes(functionRecord.framework as FunctionFramework))
        || (functionRecord.background_routes !== undefined
            && !stringRoutes(functionRecord.background_routes))) return null;
    const projected: Record<string, unknown> = {
        slug: functionRecord.slug,
        version: functionRecord.version,
        activation_id: functionRecord.activation_id,
    };
    for (const field of [...LIST_STRING_FIELDS, ...LIST_BOOLEAN_FIELDS]) {
        if (functionRecord[field] !== undefined) projected[field] = functionRecord[field];
    }
    if (functionRecord.background_routes !== undefined) {
        projected.background_routes = functionRecord.background_routes;
    }
    return projected;
}

export function projectedFunctionList(payload: unknown): Array<Record<string, unknown>> | null {
    if (!Array.isArray(payload)) return null;
    const slugs = new Set<string>();
    const projected: Array<Record<string, unknown>> = [];
    for (const candidate of payload) {
        const functionRecord = projectedFunctionListEntry(candidate);
        if (!functionRecord) return null;
        const slug = functionRecord.slug;
        if (typeof slug !== "string" || slugs.has(slug)) return null;
        slugs.add(slug);
        projected.push(functionRecord);
    }
    return projected;
}

function optionalConfigFields(
    response: Record<string, unknown>,
): Pick<FunctionIdentityResponse, "version" | "import_map" | "entrypoint"> | null {
    if (response.version !== undefined && !canonicalVersion(response.version)) return null;
    if (response.import_map !== undefined && typeof response.import_map !== "string") return null;
    if (response.entrypoint !== undefined && typeof response.entrypoint !== "string") return null;
    return {
        ...(response.version === undefined ? {} : { version: response.version }),
        ...(response.import_map === undefined ? {} : { import_map: response.import_map }),
        ...(response.entrypoint === undefined ? {} : { entrypoint: response.entrypoint }),
    };
}

function coherentFunctionVersion(activeVersion: string, version: string | undefined): boolean {
    if (activeVersion === "absent") return version === undefined;
    if (activeVersion === "0") return version === undefined || version === "0";
    return version === activeVersion;
}

export function projectedFunctionIdentity(
    payload: unknown,
    expectedProjectRef: string,
    expectedSlug: string,
): FunctionIdentityResponse | null {
    const response = objectRecord(payload);
    if (!response
        || response.project_ref !== expectedProjectRef
        || response.slug !== expectedSlug
        || (response.active_version !== "absent" && !canonicalVersion(response.active_version))
        || !validObservedFunctionActivationId(response.activation_id)
        || typeof response.verify_jwt !== "boolean"
        || !stringRoutes(response.background_routes)) return null;
    const optionalFields = optionalConfigFields(response);
    if (!optionalFields
        || !coherentFunctionVersion(response.active_version as string, optionalFields.version)) return null;
    const framework = response.framework;
    if (framework !== undefined && !FUNCTION_FRAMEWORKS.includes(framework as FunctionFramework)) return null;
    return {
        project_ref: expectedProjectRef,
        slug: expectedSlug,
        active_version: response.active_version as string,
        verify_jwt: response.verify_jwt,
        background_routes: response.background_routes,
        ...(framework === undefined ? {} : { framework: framework as FunctionFramework }),
        ...optionalFields,
        activation_id: response.activation_id,
    };
}

function mutationIdentityMatches(
    response: Record<string, unknown>,
    expectation: FunctionDeleteExpectation,
): boolean {
    return response.success === true
        && response.project_ref === expectation.projectRef
        && response.slug === expectation.slug
        && response.expected_activation_id === expectation.expectedActivationId
        && validCommittedFunctionActivationId(response.activation_id)
        && response.activation_id !== expectation.expectedActivationId;
}

function configMatchesExpectation(
    response: Record<string, unknown>,
    expected: FunctionConfigInput,
): boolean {
    if (typeof response.verify_jwt !== "boolean" || !stringRoutes(response.background_routes)) {
        return false;
    }
    if (response.framework !== undefined && !FUNCTION_FRAMEWORKS.includes(response.framework as FunctionFramework)) return false;
    if (expected.verify_jwt !== undefined && response.verify_jwt !== expected.verify_jwt) return false;
    if (expected.framework !== undefined && response.framework !== expected.framework) return false;
    return expected.background_routes === undefined
        || JSON.stringify(response.background_routes) === JSON.stringify(expected.background_routes);
}

export function confirmedFunctionConfigMutation(
    payload: unknown,
    expectation: FunctionConfigMutationExpectation,
): Record<string, unknown> | null {
    const response = objectRecord(payload);
    if (!response
        || !mutationIdentityMatches(response, expectation)
        || !configMatchesExpectation(response, expectation.config)) return null;
    const optionalFields = optionalConfigFields(response);
    if (!optionalFields) return null;
    return {
        project_ref: expectation.projectRef,
        slug: expectation.slug,
        expected_activation_id: expectation.expectedActivationId,
        activation_id: response.activation_id,
        verify_jwt: response.verify_jwt,
        background_routes: response.background_routes,
        ...(response.framework === undefined ? {} : { framework: response.framework as FunctionFramework }),
        ...optionalFields,
    };
}

export function confirmedFunctionDeletion(
    payload: unknown,
    expectation: FunctionDeleteExpectation,
): Record<string, unknown> | null {
    const response = objectRecord(payload);
    const config = objectRecord(response?.config);
    if (!response
        || !config
        || !mutationIdentityMatches(response, expectation)
        || (response.previous_active_version !== "absent"
            && !canonicalVersion(response.previous_active_version))
        || response.active_version !== "absent"
        || config.version !== undefined
        || config.activation_id !== response.activation_id
        || typeof config.verify_jwt !== "boolean") return null;
    return {
        project_ref: expectation.projectRef,
        slug: expectation.slug,
        expected_activation_id: expectation.expectedActivationId,
        activation_id: response.activation_id,
        previous_active_version: response.previous_active_version,
        active_version: "absent",
    };
}
