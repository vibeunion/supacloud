export function assertSafeGitUrl(gitUrl: unknown): asserts gitUrl is string {
  if (typeof gitUrl !== "string" || gitUrl.length > 16_384 || /[\u0000-\u0020\u007f]/.test(gitUrl)) {
    throw new Error("Invalid git URL");
  }
  const ssh = /^git@([A-Za-z0-9.-]+):[A-Za-z0-9._~/-]+\.git$/.exec(gitUrl);
  let host: string;
  if (ssh?.[1]) {
    host = ssh[1];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(gitUrl);
    } catch {
      throw new Error("Invalid git URL");
    }
    if (!["https:", "http:", "ssh:"].includes(parsed.protocol)) {
      throw new Error("Unsupported git URL protocol");
    }
    host = parsed.hostname;
  }
  host = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new Error("Git URL host is not allowed");
  }
  if (/^(169\.254\.169\.254|metadata\.google\.internal)$/i.test(host)) {
    throw new Error("Git URL metadata service targets are not allowed");
  }
  if (process.env.SUPACLOUD_RESTRICT_GIT_PRIVATE_NETWORKS === "true"
    && /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) {
    throw new Error("Git URL private network targets are not allowed");
  }
}

export function assertSafeGitBranch(branch: unknown): asserts branch is string {
  if (typeof branch !== "string" || !/^[A-Za-z0-9._/-]{1,128}$/.test(branch)
    || branch.includes("..") || branch.startsWith("-")) {
    throw new Error("Invalid git branch");
  }
}

export function sameGitTarget(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    if (b.username || b.password) return false;
    a.username = "";
    a.password = "";
    b.username = "";
    b.password = "";
    return a.toString() === b.toString();
  } catch {
    return left === right;
  }
}
