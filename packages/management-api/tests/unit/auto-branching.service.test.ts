import { describe, expect, test } from "bun:test";
import {
  readAutoBranchingConfig,
  shouldAutoBranch,
  type AutoBranchingConfig,
} from "../../src/services/auto-branching.service";

describe("readAutoBranchingConfig", () => {
  test("returns defaults for empty config", () => {
    const cfg = readAutoBranchingConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.git_url).toBe("");
    expect(cfg.base_branch).toBe("main");
    expect(cfg.branch_prefix).toBe("");
    expect(cfg.exclude_patterns).toEqual([]);
  });

  test("reads configured values", () => {
    const cfg = readAutoBranchingConfig({
      auto_branching: {
        enabled: true,
        git_url: "https://github.com/org/repo.git",
        base_branch: "main",
        branch_prefix: "preview-",
        exclude_patterns: ["dependabot/*", "release/*"],
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.git_url).toBe("https://github.com/org/repo.git");
    expect(cfg.base_branch).toBe("main");
    expect(cfg.branch_prefix).toBe("preview-");
    expect(cfg.exclude_patterns).toEqual(["dependabot/*", "release/*"]);
  });

  test("handles null/undefined input", () => {
    expect(readAutoBranchingConfig(null).enabled).toBe(false);
    expect(readAutoBranchingConfig(undefined).enabled).toBe(false);
  });

  test("filters non-string exclude patterns", () => {
    const cfg = readAutoBranchingConfig({
      auto_branching: {
        enabled: true,
        exclude_patterns: ["valid/*", 123, null, "also-valid"],
      },
    });
    expect(cfg.exclude_patterns).toEqual(["valid/*", "also-valid"]);
  });
});

describe("shouldAutoBranch", () => {
  const baseConfig: AutoBranchingConfig = {
    enabled: true,
    git_url: "https://github.com/org/repo.git",
    base_branch: "main",
    branch_prefix: "",
    exclude_patterns: [],
  };

  test("returns true for non-base branch matching git_url", () => {
    expect(shouldAutoBranch(baseConfig, "https://github.com/org/repo.git", "feature/add-auth")).toBe(true);
  });

  test("returns false for base branch", () => {
    expect(shouldAutoBranch(baseConfig, "https://github.com/org/repo.git", "main")).toBe(false);
  });

  test("returns false when disabled", () => {
    expect(shouldAutoBranch({ ...baseConfig, enabled: false }, "https://github.com/org/repo.git", "feature/x")).toBe(false);
  });

  test("returns false when git_url does not match", () => {
    expect(shouldAutoBranch(baseConfig, "https://github.com/other/repo.git", "feature/x")).toBe(false);
  });

  test("returns false for excluded patterns", () => {
    const cfg = { ...baseConfig, exclude_patterns: ["dependabot/*"] };
    expect(shouldAutoBranch(cfg, "https://github.com/org/repo.git", "dependabot/npm/lodash-4.17.21")).toBe(false);
  });

  test("returns false when git_url is not configured", () => {
    expect(shouldAutoBranch({ ...baseConfig, git_url: "" }, "https://github.com/org/repo.git", "feature/x")).toBe(false);
  });
});
