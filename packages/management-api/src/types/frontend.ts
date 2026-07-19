export type FrontendFramework = "static" | "react" | "vue" | "svelte" | "nextjs" | "nuxt" | "sveltekit" | "sveltekit-static" | "astro" | "remix";

export type BuildStatus = "pending" | "building" | "success" | "failed";

export interface FrontendDeployment {
  id: string;
  project_ref: string;
  name: string;
  framework: FrontendFramework;
  domain: string;
  custom_domains: string[];
  build_command: string;
  output_dir: string;
  install_command: string;
  node_version: string;
  health_check_path?: string;
  env_vars: Record<string, string>;
  status: BuildStatus;
  created_at: string;
  updated_at: string;
  last_deployed_at?: string;
  deployment_url: string;
  build_log?: string;
  git_url?: string;
  git_branch?: string;
  deploy_tokens?: DeployToken[];
}

export interface DeployToken {
  id: string;
  name: string;
  token: string;
  created_at: string;
  last_used_at?: string;
}

export interface DeploymentRecord {
  id: string;
  deployment_id: string;
  project_ref: string;
  status: BuildStatus;
  commit_sha?: string;
  commit_message?: string;
  branch?: string;
  triggered_by: "manual" | "webhook" | "ci";
  build_log?: string;
  started_at: string;
  finished_at?: string;
  duration?: number;
}

export type FrontendDnsRecordType = "A" | "CNAME";

export type FrontendDnsRecordStatus = "managed" | "expected";

export interface FrontendDnsRecord {
  id: string;
  deployment_id: string;
  project_ref: string;
  hostname: string;
  type: FrontendDnsRecordType;
  name: string;
  value: string;
  status: FrontendDnsRecordStatus;
  source: "temporary_domain" | "custom_domain";
}

export interface GitHubWebhookConfig {
  deployment_id: string;
  project_ref: string;
  github_repo: string;
  branch: string;
  secret: string;
  enabled: boolean;
}

export interface FrontendDeploymentConfig {
  name: string;
  framework: FrontendFramework;
  domain?: string;
  custom_domains?: string[];
  build_command?: string;
  output_dir?: string;
  install_command?: string;
  node_version?: string;
  health_check_path?: string;
  env_vars?: Record<string, string>;
}

export interface FrontendBuildResult {
  success: boolean;
  deployment_id: string;
  url: string;
  build_log: string;
  error?: string;
}

export const FRAMEWORK_DEFAULTS: Record<FrontendFramework, {
  build_command: string;
  output_dir: string;
  install_command: string;
  node_version: string;
  health_check_path: string;
  is_ssr: boolean;
}> = {
  static: {
    build_command: "",
    output_dir: ".",
    install_command: "",
    node_version: "20",
    health_check_path: "/",
    is_ssr: false,
  },
  react: {
    build_command: "npm run build",
    output_dir: "dist",
    install_command: "npm install",
    node_version: "20",
    health_check_path: "/",
    is_ssr: false,
  },
  vue: {
    build_command: "npm run build",
    output_dir: "dist",
    install_command: "npm install",
    node_version: "20",
    health_check_path: "/",
    is_ssr: false,
  },
  svelte: {
    build_command: "npm run build",
    output_dir: "dist",
    install_command: "npm install",
    node_version: "20",
    health_check_path: "/",
    is_ssr: false,
  },
  nextjs: {
    build_command: "npm run build",
    output_dir: ".next",
    install_command: "npm install",
    node_version: "20",
    health_check_path: "/",
    is_ssr: true,
  },
  nuxt: {
    build_command: "npm run build",
    output_dir: ".output",
    install_command: "npm install",
    node_version: "20",
    health_check_path: "/",
    is_ssr: true,
  },
  sveltekit: {
    build_command: "npm run build",
    output_dir: "build",
    install_command: "npm install",
    node_version: "20",
    health_check_path: "/",
    is_ssr: true,
  },
  "sveltekit-static": {
    build_command: "npm run build",
    output_dir: "build",
    install_command: "npm install",
    node_version: "20",
    health_check_path: "/",
    is_ssr: false,
  },
  astro: {
    build_command: "npm run build",
    output_dir: "dist",
    install_command: "npm install",
    node_version: "20",
    health_check_path: "/",
    is_ssr: false,
  },
  remix: {
    build_command: "npm run build",
    output_dir: "build",
    install_command: "npm install",
    node_version: "20",
    health_check_path: "/",
    is_ssr: true,
  },
};
