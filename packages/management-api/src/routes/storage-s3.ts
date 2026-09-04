/**
 * S3-compatible protocol surface for SupaCloud Storage.
 *
 * Exposes a subset of the Amazon S3 REST API so tools like aws-cli, rclone,
 * boto3, and MinIO client can read and write objects directly. Mounted at
 * `/v1/storage/:ref/s3`.
 *
 * Implemented operations:
 *   GET /                  ListBuckets
 *   PUT /:bucket           CreateBucket
 *   DELETE /:bucket        DeleteBucket
 *   HEAD /:bucket          HeadBucket
 *   PUT /:bucket/:key      PutObject
 *                           (If-None-Match: * and If-Match supported when the
 *                            configured driver exposes conditional writes)
 *   GET /:bucket/:key      GetObject
 *   HEAD /:bucket/:key     HeadObject
 *   DELETE /:bucket/:key   DeleteObject
 *   GET /:bucket           ListObjects (v1)
 *
 * Auth: supports two modes:
 *   1. AWS SigV4 signature (standard S3 SDK clients: aws-cli, boto3, rclone, etc.)
 *      The access_key is the project's S3 access key and the secret is the
 *      project's S3 secret key, both managed under projects.config.s3_credentials.
 *   2. Bearer token / X-Amz-Security-Token containing the project
 *      service_role_key (not anon_key, which is a public value).
 */
import { Elysia, t } from "elysia";
import { StorageService } from "../services/storage.service";
import { verifySigV4Signature, parseSigV4Header, EMPTY_BODY_HASH } from "../utils/sigv4";
import { projectRepository } from "../repositories/project.repository";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import { logger } from "../utils/logger";
import { getAuthContext } from "../middleware/auth";

interface S3Credentials {
  access_key: string;
  secret_key: string;
}

function readS3Credentials(projectConfig: unknown): S3Credentials | null {
  const config = normalizeProjectConfig(projectConfig);
  const credentials = config.s3_credentials as Record<string, unknown> | undefined;
  if (
    typeof credentials?.access_key !== "string" ||
    typeof credentials.secret_key !== "string"
  ) {
    return null;
  }
  return {
    access_key: credentials.access_key,
    secret_key: credentials.secret_key,
  };
}

function generateS3AccessKey(ref: string): string {
  return `supac_${ref}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function generateS3SecretKey(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * Read or lazily provision S3 credentials for a project.
 * Credentials are stored in projects.config.s3_credentials.
 */
async function getOrCreateS3Credentials(ref: string): Promise<S3Credentials | null> {
  const project = await projectRepository.findByRef(ref);
  if (!project) return null;

  const existingCredentials = readS3Credentials(project.config);
  if (existingCredentials) return existingCredentials;

  // Auto-provision on first use.
  const credentials: S3Credentials = {
    access_key: generateS3AccessKey(ref),
    secret_key: generateS3SecretKey(),
  };
  await projectRepository.updateConfig(
    ref,
    mergeProjectConfig(project.config, { s3_credentials: credentials }),
  );
  logger.info(`[storage-s3] provisioned S3 credentials for ${ref}`);
  return credentials;
}

async function getS3Credentials(ref: string): Promise<S3Credentials | null> {
  const project = await projectRepository.findByRef(ref);
  return project ? readS3Credentials(project.config) : null;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isoNow(): string {
  return new Date().toISOString();
}

function buildListBucketsXml(ref: string, buckets: Record<string, unknown>[]): string {
  const bucketsXml = buckets
    .map(
      (b) =>
        `      <Bucket>\n        <Name>${xmlEscape(String(b.name || b.id || ""))}</Name>\n        <CreationDate>${isoNow()}</CreationDate>\n      </Bucket>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n  <Owner>\n    <ID>${xmlEscape(ref)}</ID>\n    <DisplayName>supacloud</DisplayName>\n  </Owner>\n  <Buckets>\n${bucketsXml}\n  </Buckets>\n</ListAllMyBucketsResult>`;
}

function buildListObjectsXml(bucket: string, objects: Record<string, unknown>[]): string {
  const contentsXml = objects
    .map((o) => {
      const name = String(o.name || o.key || "");
      const meta = (o.metadata as Record<string, unknown>) || {};
      const size = Number(o.size || meta.size || 0);
      const lastModified = String(o.updated_at || o.last_modified || isoNow());
      return `    <Contents>\n      <Key>${xmlEscape(name)}</Key>\n      <LastModified>${lastModified}</LastModified>\n      <Size>${size}</Size>\n      <StorageClass>STANDARD</StorageClass>\n    </Contents>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n  <Name>${xmlEscape(bucket)}</Name>\n  <Prefix></Prefix>\n  <MaxKeys>1000</MaxKeys>\n  <IsTruncated>false</IsTruncated>\n${contentsXml}\n</ListBucketResult>`;
}

function s3Error(code: string, message: string, httpStatus: number) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message><RequestId>${crypto.randomUUID()}</RequestId></Error>`;
  return new Response(body, {
    status: httpStatus,
    headers: { "Content-Type": "application/xml" },
  });
}

/**
 * Authenticate the S3 request. Returns the resolved project ref, or null if
 * authentication fails. Supports SigV4 and Bearer token modes.
 *
 * For SigV4, we need to read the body to compute its hash. The caller must
 * provide the request clone with body already consumed for hashing.
 */
async function authenticate(request: Request, ref: string): Promise<boolean> {
  const authHeader = request.headers.get("authorization") || "";

  // Mode 1: AWS SigV4 signature.
  if (authHeader.startsWith("AWS4-HMAC-SHA256")) {
    const parsed = parseSigV4Header(authHeader);
    if (!parsed) return false;

    const credentials = await getS3Credentials(ref);
    if (!credentials) return false;

    // The access key in the credential scope must match the project's S3 access key.
    if (parsed.credential.accessKeyId !== credentials.access_key) {
      // Also accept the project service_role_key as a fallback access key
      // mapped to the same secret, for ease of bootstrap.
      const project = await projectRepository.findByRef(ref);
      if (!project || parsed.credential.accessKeyId !== project.service_role_key) {
        return false;
      }
    }

    // For SigV4 we need the body hash from x-amz-content-sha256 or compute it.
    // S3 clients send x-amz-content-sha256 for non-streaming uploads; for
    // UNSIGNED-PAYLOAD we skip body verification.
    const contentHash = request.headers.get("x-amz-content-sha256") || EMPTY_BODY_HASH;

    return verifySigV4Signature(request, contentHash, credentials.secret_key);
  }

  // Mode 2: Bearer token or X-Amz-Security-Token.
  // Only the project service_role_key is accepted for raw S3 operations.
  // anon_key is explicitly rejected because it is a public client-side value.
  const token =
    request.headers.get("x-amz-security-token") ||
    (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "") ||
    "";
  if (!token) return false;

  const project = await projectRepository.findByRef(ref);
  if (!project) return false;
  return project.service_role_key === token;
}

export const storageS3Routes = new Elysia({ prefix: "/v1/storage/:ref/s3" })
  .onBeforeHandle(async ({ params, request, set }) => {
    if (new URL(request.url).pathname.endsWith("/credentials")) {
      const authResult = await getAuthContext(request);
      if ("status" in authResult) {
        set.status = authResult.status;
        return authResult.body;
      }
      if (authResult.role === "master" || authResult.role === "admin") return;
      if (authResult.role === "project" && authResult.ref === params.ref) return;
      set.status = 403;
      return { error: "Admin or service_role auth required to retrieve S3 credentials" };
    }

    const ok = await authenticate(request, params.ref);
    if (!ok) {
      set.status = 403;
      return s3Error("AccessDenied", "Invalid credentials or project mismatch", 403);
    }
  })

  // GET /credentials -> Return S3 credentials for the project.
  // This returns long-lived secrets, so it requires admin or service_role auth
  // (not the lightweight S3 bearer auth that the onBeforeHandle gate applies).
  .get("/credentials", async ({ params, request, set }) => {
    const authResult = await getAuthContext(request);
    if ("status" in authResult) {
      set.status = authResult.status;
      return authResult.body;
    }
    // Only master/admin or project service_role can retrieve credentials.
    if (authResult.role !== "master" && authResult.role !== "admin") {
      // project role is ok only if it matches this ref
      if (authResult.role !== "project" || authResult.ref !== params.ref) {
        set.status = 403;
        return { error: "Admin or service_role auth required to retrieve S3 credentials" };
      }
    }

    const credentials = await getOrCreateS3Credentials(params.ref);
    if (!credentials) {
      set.status = 404;
      return { error: "Project not found" };
    }
    return { project_ref: params.ref, ...credentials };
  }, {
    detail: { tags: ["storage-s3"], summary: "Get or provision S3 credentials" },
  })

  // GET / -> ListBuckets
  .get("/", async ({ params }) => {
    const buckets = await StorageService.listBuckets(params.ref);
    return new Response(buildListBucketsXml(params.ref, buckets), {
      headers: { "Content-Type": "application/xml" },
    });
  }, {
    detail: { tags: ["storage-s3"], summary: "S3 ListBuckets" },
  })

  // GET /:bucket -> ListObjects
  .get("/:bucket", async ({ params, set }) => {
    try {
      const objects = await StorageService.listFiles(params.ref, params.bucket);
      return new Response(buildListObjectsXml(params.bucket, objects), {
        headers: { "Content-Type": "application/xml" },
      });
    } catch {
      return s3Error("NoSuchBucket", "The specified bucket does not exist", 404);
    }
  }, {
    params: t.Object({ ref: t.String(), bucket: t.String() }),
    detail: { tags: ["storage-s3"], summary: "S3 ListObjects" },
  })

  // PUT /:bucket -> CreateBucket
  .put("/:bucket", async ({ params, set }) => {
    const result = await StorageService.createBucket(params.ref, params.bucket);
    if (!result.success) {
      return s3Error("BucketAlreadyExists", result.error || "Bucket creation failed", 409);
    }
    set.status = 200;
    return "";
  }, {
    params: t.Object({ ref: t.String(), bucket: t.String() }),
    detail: { tags: ["storage-s3"], summary: "S3 CreateBucket" },
  })

  // DELETE /:bucket -> DeleteBucket (only when empty)
  .delete("/:bucket", async ({ params, set }) => {
    const result = await StorageService.deleteBucket(params.ref, params.bucket);
    if (!result.success) {
      if (result.error === "Bucket is not empty") {
        return s3Error("BucketNotEmpty", "The bucket you tried to delete is not empty", 409);
      }
      return s3Error("InternalError", result.error || "Failed to delete bucket", 500);
    }
    set.status = 204;
    return "";
  }, {
    params: t.Object({ ref: t.String(), bucket: t.String() }),
    detail: { tags: ["storage-s3"], summary: "S3 DeleteBucket" },
  })

  // HEAD /:bucket -> HeadBucket
  .route("HEAD", "/:bucket", async ({ params, set }) => {
    const buckets = await StorageService.listBuckets(params.ref);
    const exists = buckets.some((b) => String(b.name || b.id) === params.bucket);
    if (!exists) {
      set.status = 404;
      return "";
    }
    set.status = 200;
    return "";
  }, {
    params: t.Object({ ref: t.String(), bucket: t.String() }),
    detail: { tags: ["storage-s3"], summary: "S3 HeadBucket" },
  })

  // PUT /:bucket/* -> PutObject
  .put("/:bucket/*", async ({ params, request, set }) => {
    const key = params["*"];
    if (!key) return s3Error("InvalidRequest", "Missing object key", 400);
    const body = request.body;
    if (!body) return s3Error("IncompleteBody", "Missing request body", 400);

    const contentType = request.headers.get("content-type") || "application/octet-stream";
    const ifNoneMatch = request.headers.get("if-none-match");
    const ifMatch = request.headers.get("if-match");
    if (ifNoneMatch !== null && ifMatch !== null) {
      return s3Error("InvalidRequest", "If-None-Match and If-Match cannot be combined", 400);
    }
    if (ifNoneMatch !== null && ifNoneMatch.trim() !== "*") {
      return s3Error("InvalidRequest", "Only If-None-Match: * is supported", 400);
    }
    const expectedEtag = ifMatch === null ? null : ifMatch.trim();
    if (ifMatch !== null && (!expectedEtag || expectedEtag === "*")) {
      return s3Error("InvalidRequest", "If-Match requires an object ETag", 400);
    }

    if (ifNoneMatch !== null || ifMatch !== null) {
      const conditionalResult = await StorageService.uploadFileConditional(
        params.ref,
        params.bucket,
        key,
        await request.arrayBuffer(),
        contentType,
        ifNoneMatch !== null ? null : expectedEtag,
      );
      if (!conditionalResult) {
        return s3Error("NotImplemented", "Conditional writes are not supported by this storage backend", 501);
      }
      if (conditionalResult.outcome === "exists" || conditionalResult.outcome === "etag_mismatch") {
        return s3Error("PreconditionFailed", "The object precondition was not met", 412);
      }
      if (!("etag" in conditionalResult)) {
        return s3Error("InternalError", "Conditional write returned an invalid result", 500);
      }
      set.headers["ETag"] = `"${conditionalResult.etag}"`;
      set.status = 200;
      return "";
    }

    const ok = await StorageService.uploadFile(params.ref, params.bucket, key, body as ReadableStream, contentType);
    if (!ok) return s3Error("InternalError", "Failed to store object", 500);

    set.headers["ETag"] = `"${crypto.randomUUID()}"`;
    set.status = 200;
    return "";
  }, {
    params: t.Object({ ref: t.String(), bucket: t.String(), ["*"]: t.String() }),
    detail: { tags: ["storage-s3"], summary: "S3 PutObject" },
  })

  // GET /:bucket/* -> GetObject
  .get("/:bucket/*", async ({ params }) => {
    const key = params["*"];
    if (!key) return s3Error("InvalidRequest", "Missing object key", 400);

    const res = await StorageService.getDownloadResponse(params.ref, params.bucket, key);
    if (!res || !res.ok) {
      return s3Error("NoSuchKey", "The specified key does not exist", 404);
    }
    return res;
  }, {
    params: t.Object({ ref: t.String(), bucket: t.String(), ["*"]: t.String() }),
    detail: { tags: ["storage-s3"], summary: "S3 GetObject" },
  })

  // HEAD /:bucket/* -> HeadObject
  .route("HEAD", "/:bucket/*", async ({ params, set }) => {
    const key = params["*"];
    if (!key) {
      set.status = 400;
      return "";
    }
    const res = await StorageService.getDownloadResponse(params.ref, params.bucket, key);
    if (!res || !res.ok) {
      set.status = 404;
      return "";
    }
    set.headers["Content-Type"] = res.headers.get("content-type") || "application/octet-stream";
    set.headers["Content-Length"] = res.headers.get("content-length") || "0";
    set.status = 200;
    return "";
  }, {
    params: t.Object({ ref: t.String(), bucket: t.String(), ["*"]: t.String() }),
    detail: { tags: ["storage-s3"], summary: "S3 HeadObject" },
  })

  // DELETE /:bucket/* -> DeleteObject
  .delete("/:bucket/*", async ({ params, set }) => {
    const key = params["*"];
    if (!key) return s3Error("InvalidRequest", "Missing object key", 400);
    const ok = await StorageService.deleteFile(params.ref, params.bucket, key);
    if (!ok) return s3Error("InternalError", "Failed to delete object", 500);
    set.status = 204;
    return "";
  }, {
    params: t.Object({ ref: t.String(), bucket: t.String(), ["*"]: t.String() }),
    detail: { tags: ["storage-s3"], summary: "S3 DeleteObject" },
  });
