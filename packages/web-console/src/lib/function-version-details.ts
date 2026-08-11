const POSITIVE_FUNCTION_VERSION_PATTERN = /^[1-9][0-9]*$/;

interface FunctionVersionDetailRequest {
  projectRef: string | undefined;
  slug: string;
  version: string;
}

export async function requestImmutableFunctionVersion(
  requester: (path: string) => Promise<Response>,
  request: FunctionVersionDetailRequest,
): Promise<Response | null> {
  if (request.version === "0") return null;
  if (!POSITIVE_FUNCTION_VERSION_PATTERN.test(request.version)
    || !Number.isSafeInteger(Number(request.version))) {
    throw new Error("函数版本详情请求无效，请刷新后重试");
  }
  if (typeof request.projectRef !== "string" || request.projectRef.length === 0
    || request.slug.length === 0) {
    throw new Error("函数版本详情上下文缺失，请刷新后重试");
  }
  const projectRef = encodeURIComponent(request.projectRef);
  const slug = encodeURIComponent(request.slug);
  return requester(`/v1/projects/${projectRef}/functions/${slug}/versions/${request.version}`);
}
