const S3_PREFIX_PATTERN = /^\/v1\/storage\/[^/]+\/s3(?:\/|$)/;
const S3_CREDENTIALS_PATTERN = /^\/v1\/storage\/[^/]+\/s3\/credentials\/?$/;

export function isS3DataPlanePath(pathname: string): boolean {
  return S3_PREFIX_PATTERN.test(pathname) && !S3_CREDENTIALS_PATTERN.test(pathname);
}

export function isS3DataPlaneRequest(request: Request): boolean {
  return isS3DataPlanePath(new URL(request.url).pathname);
}
