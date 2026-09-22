export function resolve(path: string, params?: { ref: string }): string {
  return params ? path.replace("[ref]", encodeURIComponent(params.ref)) : path;
}
