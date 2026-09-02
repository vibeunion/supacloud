/**
 * token 名 → services 对象的 key。
 * CASE_REPOSITORY → caseRepository、LOGGER → logger（常量命名转 camelCase），
 * CaseService → caseService（PascalCase 首字母小写）。
 */
export function camelName(token: string): string {
  const isConstantCase = token.includes("_") || !/[a-z]/.test(token);
  if (isConstantCase) {
    return token
      .toLowerCase()
      .split("_")
      .filter((part) => part.length > 0)
      .map((part, index) =>
        index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
      )
      .join("");
  }
  return token.charAt(0).toLowerCase() + token.slice(1);
}

/** 计算 from 目录到 to 文件的相对 import 路径（去扩展名，保证 ./ 或 ../ 前缀）。 */
export function relativeImportPath(fromDir: string, toFile: string): string {
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = toFile.split("/").filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const ups = fromParts.length - common;
  const downs = toParts.slice(common);
  const last = downs[downs.length - 1]?.replace(/\.(ts|tsx|js|mts|cts)$/, "") ?? "";
  const segments = [...Array<string>(ups).fill(".."), ...downs.slice(0, -1), last];
  const joined = segments.join("/");
  return joined.startsWith("..") ? joined : `./${joined}`;
}

/** 内置上下文 token 的字符串 name（与 @supacloud/app 的 REQUEST_CONTEXT/JOB_CONTEXT 对齐）。 */
export const REQUEST_CONTEXT_TOKEN_NAME = "supacloud.request-context";
export const JOB_CONTEXT_TOKEN_NAME = "supacloud.job-context";

/** 判断 token 是否为内置 request 上下文（变量名 REQUEST_CONTEXT 或 token name 匹配）。 */
export function isRequestContextToken(
  token: string,
  tokenNames?: Record<string, string>,
): boolean {
  return token === "REQUEST_CONTEXT" || tokenNames?.[token] === REQUEST_CONTEXT_TOKEN_NAME;
}

/** 判断 token 是否为内置 job 上下文。 */
export function isJobContextToken(
  token: string,
  tokenNames?: Record<string, string>,
): boolean {
  return token === "JOB_CONTEXT" || tokenNames?.[token] === JOB_CONTEXT_TOKEN_NAME;
}
