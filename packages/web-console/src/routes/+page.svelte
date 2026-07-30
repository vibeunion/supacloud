<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { apiClient } from "$lib/api";
  import {
    Activity,
    ArrowRight,
    ArrowUpRight,
    Boxes,
    CheckCircle2,
    Clock3,
    Cpu,
    Database,
    FolderKanban,
    Gauge,
    HardDrive,
    LayoutDashboard,
    Loader2,
    PauseCircle,
    Plus,
    RefreshCw,
    Search,
    Server,
    Settings,
    ShieldCheck,
    XCircle,
  } from "lucide-svelte";
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";

  interface ProjectItem {
    ref: string;
    name: string;
    status: string;
    region: string;
    db_name: string;
    created_at: string;
  }

  interface SystemInfo {
    cpu?: string;
    memory?: string;
    uptime?: string;
    version?: string;
  }

  const navigation = [
    { titleKey: "Dashboard.nav_overview", href: "/", icon: LayoutDashboard },
    { titleKey: "Dashboard.nav_projects", href: "/projects", icon: FolderKanban },
    { titleKey: "Dashboard.nav_platform", href: "/platform", icon: Server },
    { titleKey: "Dashboard.nav_operations", href: "/platform/operations", icon: Activity },
    { titleKey: "Dashboard.nav_monitoring", href: "/platform/monitoring", icon: Gauge },
    { titleKey: "Platform.backups_pitr", href: "/platform/backups", icon: Database },
    { titleKey: "Platform.settings", href: "/platform/settings", icon: Settings },
  ] as const;

  let projects = $state<ProjectItem[]>([]);
  let systemInfo = $state<SystemInfo>({});
  let searchQuery = $state("");
  let loading = $state(true);
  let loadError = $state(false);

  let activeCount = $derived(projects.filter((project) => projectStatusKind(project.status) === "active").length);
  let pausedCount = $derived(projects.filter((project) => projectStatusKind(project.status) === "paused").length);
  let otherCount = $derived(projects.length - activeCount - pausedCount);
  let activePercent = $derived(projects.length ? Math.round((activeCount / projects.length) * 100) : 0);
  let connectionLabel = $derived(
    loading
      ? $t("Dashboard.management_api_connecting")
      : loadError
        ? $t("Dashboard.management_api_unavailable")
        : $t("Dashboard.management_api_connected"),
  );
  let filteredProjects = $derived(
    projects.filter((project) => {
      const term = searchQuery.trim().toLowerCase();
      return !term || [project.name, project.ref, project.region, project.status].join(" ").toLowerCase().includes(term);
    }),
  );

  async function fetchProjects(): Promise<ProjectItem[]> {
    const response = await apiClient("/v1/projects");
    if (!response.ok) throw new Error(`Projects request failed: ${response.status}`);
    return response.json() as Promise<ProjectItem[]>;
  }

  async function fetchSystemInfo(): Promise<SystemInfo> {
    const response = await apiClient("/v1/system/info");
    if (!response.ok) throw new Error(`System info request failed: ${response.status}`);
    return response.json() as Promise<SystemInfo>;
  }

  async function loadDashboard(): Promise<void> {
    loading = true;
    loadError = false;
    const [projectResult, systemResult] = await Promise.allSettled([fetchProjects(), fetchSystemInfo()]);

    if (projectResult.status === "fulfilled") projects = projectResult.value;
    else loadError = true;
    if (systemResult.status === "fulfilled") systemInfo = systemResult.value;

    loading = false;
  }

  function projectStatusKind(status: string): "active" | "paused" | "other" {
    const normalizedStatus = status.toLowerCase();
    if (["active", "active_healthy", "healthy", "running"].includes(normalizedStatus)) return "active";
    if (["paused", "suspended", "stopped"].includes(normalizedStatus)) return "paused";
    return "other";
  }

  function statusClass(status: string): string {
    const kind = projectStatusKind(status);
    if (kind === "active") return "status-active";
    if (kind === "paused") return "status-paused";
    return "status-other";
  }

  function projectStatusLabel(status: string): string {
    const kind = projectStatusKind(status);
    if (kind === "active") return $t("Dashboard.status_active");
    if (kind === "paused") return $t("Dashboard.status_paused");
    return $t("Dashboard.status_other");
  }

  function timeAgo(dateTime: string): string {
    const elapsed = Date.now() - new Date(dateTime).getTime();
    const days = Math.floor(elapsed / 86_400_000);
    if (days > 30) return `${Math.floor(days / 30)} ${$t("Dashboard.months_ago")}`;
    if (days > 0) return `${days} ${$t("Common.ago_days")}`;
    const hours = Math.floor(elapsed / 3_600_000);
    return hours > 0 ? `${hours} ${$t("Common.ago_hours")}` : $t("Dashboard.just_now");
  }

  onMount(() => {
    void loadDashboard();
  });
</script>

<svelte:head>
  <title>SupaCloud · {$t("Dashboard.platform_overview")}</title>
  <meta name="description" content={$t("Dashboard.platform_overview_description")} />
</svelte:head>

<div class="console-shell">
  <aside class="console-sidebar" aria-label={$t("Dashboard.main_navigation")}>
    <div class="brand-lockup">
      <span class="brand-symbol" aria-hidden="true"><Database size={20} strokeWidth={1.9} /></span>
      <span>
        <strong>SupaCloud</strong>
        <small>{$t("Dashboard.console_subtitle")}</small>
      </span>
    </div>

    <nav class="sidebar-nav" aria-label={$t("Dashboard.console_navigation")}>
      {#each navigation as entry (entry.href)}
        <a class:active={entry.href === "/"} href={resolve(entry.href)} aria-current={entry.href === "/" ? "page" : undefined}>
          <entry.icon size={16} strokeWidth={1.8} />
          <span>{$t(entry.titleKey)}</span>
        </a>
      {/each}
    </nav>

    <div class="sidebar-spacer"></div>

    <div class="workspace-strip">
      <span class="workspace-avatar">SC</span>
      <span><strong>{$t("Dashboard.local_workspace")}</strong><small>{$t("Dashboard.console_subtitle")}</small></span>
      <CheckCircle2 size={14} aria-label={$t("Dashboard.instance_online")} />
    </div>
  </aside>

  <main class="console-main">
    <header class="topbar">
      <div class="topbar-context">
        <span class="context-icon"><Boxes size={17} /></span>
        <span><strong>{$t("Dashboard.console_name")}</strong><small>{$t("Dashboard.platform_overview")}</small></span>
      </div>

      <div class="topbar-actions">
        <label class="search-field">
          <Search size={15} aria-hidden="true" />
          <span class="sr-only">{$t("Dashboard.search_projects")}</span>
          <input bind:value={searchQuery} placeholder={$t("Dashboard.search_projects")} />
          <kbd>⌘ K</kbd>
        </label>
        <button class="refresh-button" type="button" title={$t("Common.refresh")} aria-label={$t("Dashboard.refresh_platform_data")} onclick={() => void loadDashboard()}>
          <span class:spin={loading}><RefreshCw size={15} /></span>
        </button>
        <button class="primary-button" type="button" onclick={() => goto(resolve("/projects"))}>
          <Plus size={15} /> {$t("Dashboard.create_project")}
        </button>
      </div>
    </header>

    <div class="console-canvas">
      <section class="page-intro" aria-labelledby="overview-title">
        <div>
          <p class:disconnected={loadError} class="eyebrow"><span></span> {connectionLabel}</p>
          <h1 id="overview-title">{$t("Dashboard.platform_overview")}</h1>
          <p>{$t("Dashboard.platform_overview_description")}</p>
        </div>
        <div class="runtime-badge">
          <span>{$t("Dashboard.runtime")}</span>
          <strong>{systemInfo.version || "—"}</strong>
        </div>
      </section>

      {#if loading && projects.length === 0}
        <div class="loading-state"><Loader2 size={24} class="spin" /><span>{$t("Dashboard.connecting_supacloud")}</span></div>
      {:else}
        {#if loadError}
          <div class="error-banner" role="alert">
            <XCircle size={16} /> {$t("Dashboard.project_data_unavailable")}
            <button type="button" onclick={() => void loadDashboard()}>{$t("Common.retry")}</button>
          </div>
        {/if}

        <section class="stats-grid" aria-label={$t("Dashboard.platform_metrics")}>
          <article class="stat-card">
            <div class="stat-heading"><span>{$t("Dashboard.project_total")}</span><FolderKanban size={18} /></div>
            <strong>{projects.length}</strong>
            <p>{$t("Dashboard.project_total_description")}</p>
          </article>
          <article class="stat-card">
            <div class="stat-heading green"><span>{$t("Dashboard.running")}</span><CheckCircle2 size={18} /></div>
            <strong>{activeCount}</strong>
            <p>{activePercent}% {$t("Dashboard.projects_healthy")}</p>
          </article>
          <article class="stat-card">
            <div class="stat-heading amber"><span>{$t("Dashboard.paused")}</span><PauseCircle size={18} /></div>
            <strong>{pausedCount}</strong>
            <p>{otherCount > 0 ? `${otherCount} ${$t("Dashboard.projects_in_other_states")}` : $t("Dashboard.no_abnormal_status")}</p>
          </article>
          <article class="stat-card">
            <div class="stat-heading blue"><span>{$t("Dashboard.cpu_usage")}</span><Cpu size={18} /></div>
            <strong>{systemInfo.cpu || "—"}</strong>
            <p>{$t("Dashboard.cpu_usage_description")}</p>
          </article>
        </section>

        <section class="overview-grid">
          <article class="panel project-health-panel">
            <div class="panel-heading">
              <div><p class="panel-kicker">{$t("Dashboard.workspace_health")}</p><h2>{$t("Dashboard.project_runtime_status")}</h2></div>
              <a href={resolve("/projects")}>{$t("Dashboard.view_all")} <ArrowUpRight size={13} /></a>
            </div>

            <div class="health-summary">
              <div class="health-score">
                <strong>{activePercent}%</strong>
                <span>{$t("Dashboard.projects_online")}</span>
              </div>
              <div class="health-visual">
                <div class="health-track" aria-label={`${activePercent}% ${$t("Dashboard.projects_healthy")}`}>
                  <span class="health-active" style:width={`${activePercent}%`}></span>
                  <span class="health-paused" style:width={`${projects.length ? Math.round((pausedCount / projects.length) * 100) : 0}%`}></span>
                </div>
                <div class="health-legend">
                  <span><i class="dot-active"></i>{$t("Dashboard.running")} <b>{activeCount}</b></span>
                  <span><i class="dot-paused"></i>{$t("Dashboard.paused")} <b>{pausedCount}</b></span>
                  <span><i class="dot-other"></i>{$t("Dashboard.other")} <b>{otherCount}</b></span>
                </div>
              </div>
            </div>

            <div class="health-footnote">
              <ShieldCheck size={15} />
              <span>{$t("Dashboard.management_api_reading")}</span>
            </div>
          </article>

          <article class="panel system-panel">
            <div class="panel-heading">
              <div><p class="panel-kicker">{$t("Dashboard.infrastructure")}</p><h2>{$t("Dashboard.system_runtime")}</h2></div>
              <Activity size={17} />
            </div>
            <dl>
              <div><dt><Clock3 size={14} />{$t("Dashboard.uptime")}</dt><dd>{systemInfo.uptime || "—"}</dd></div>
              <div><dt><Cpu size={14} />CPU</dt><dd>{systemInfo.cpu || "—"}</dd></div>
              <div><dt><HardDrive size={14} />{$t("Dashboard.memory")}</dt><dd>{systemInfo.memory || "—"}</dd></div>
              <div><dt><Server size={14} />{$t("Dashboard.version")}</dt><dd>{systemInfo.version || "—"}</dd></div>
            </dl>
            <a class="system-link" href={resolve("/platform/monitoring")}>{$t("Dashboard.open_monitoring")} <ArrowRight size={13} /></a>
          </article>
        </section>

        <section class="panel projects-panel">
          <div class="panel-heading projects-heading">
            <div><p class="panel-kicker">{$t("Dashboard.projects")}</p><h2>{$t("Dashboard.recent_projects")}</h2></div>
            <span>{filteredProjects.length} {$t("Dashboard.projects")}</span>
          </div>

          {#if filteredProjects.length === 0}
            <div class="empty-state">
              <FolderKanban size={30} />
              <strong>{projects.length === 0 ? $t("Dashboard.no_projects") : $t("Dashboard.no_matching_projects")}</strong>
              <p>{projects.length === 0 ? $t("Dashboard.no_projects_description") : $t("Dashboard.no_matching_projects_description")}</p>
              {#if projects.length === 0}
                <button class="primary-button" type="button" onclick={() => goto(resolve("/projects"))}><Plus size={14} /> {$t("Dashboard.create_first_project")}</button>
              {:else}
                <button class="text-button" type="button" onclick={() => (searchQuery = "")}>{$t("Dashboard.clear_search")}</button>
              {/if}
            </div>
          {:else}
            <div class="table-wrap">
              <table>
              <thead><tr><th>{$t("Dashboard.project")}</th><th>{$t("Dashboard.region")}</th><th>{$t("Dashboard.database")}</th><th>{$t("Dashboard.status")}</th><th>{$t("Dashboard.created_at")}</th><th><span class="sr-only">{$t("Dashboard.open_project")}</span></th></tr></thead>
                <tbody>
                  {#each filteredProjects.slice(0, 6) as project (project.ref)}
                    <tr>
                      <td data-label={$t("Dashboard.project")}>
                        <a class="project-identity" href={resolve("/project/[ref]", { ref: project.ref })}>
                          <span class="project-mark">{project.name.charAt(0).toUpperCase()}</span>
                          <span><strong>{project.name}</strong><small>{project.ref}</small></span>
                        </a>
                      </td>
                      <td data-label={$t("Dashboard.region")}>{project.region || $t("Dashboard.local_region")}</td>
                      <td data-label={$t("Dashboard.database")}><code>{project.db_name || "postgres"}</code></td>
                      <td data-label={$t("Dashboard.status")}><span class="status-pill {statusClass(project.status)}" title={project.status}>{projectStatusLabel(project.status)}</span></td>
                      <td data-label={$t("Dashboard.created_at")}>{timeAgo(project.created_at)}</td>
                      <td class="open-cell"><a title={`${$t("Dashboard.open_project")} ${project.name}`} aria-label={`${$t("Dashboard.open_project")} ${project.name}`} href={resolve("/project/[ref]", { ref: project.ref })}><ArrowUpRight size={15} /></a></td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>

      {/if}
    </div>
  </main>
</div>

<style>
  :global(body) {
    margin: 0;
    min-width: 320px;
    background: #f7f7f6;
  }

  :global(button),
  :global(input) {
    font: inherit;
  }

  .console-shell {
    --ink: #1c1c1c;
    --muted: #6f6f6b;
    --border: #dededb;
    --soft-border: #e9e9e6;
    --panel: #ffffff;
    --canvas: #f7f7f6;
    --sidebar: #171717;
    --sidebar-muted: #a5a5a1;
    --green: #2e7d5b;
    --green-bright: #3ecf8e;
    display: flex;
    min-height: 100vh;
    color: var(--ink);
    background: var(--canvas);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  a,
  button,
  input {
    outline-color: #3a9f72;
    outline-offset: 2px;
  }

  button {
    cursor: pointer;
  }

  .console-sidebar {
    position: sticky;
    top: 0;
    display: flex;
    flex: 0 0 236px;
    flex-direction: column;
    height: 100vh;
    padding: 18px 12px 12px;
    color: #eeeeec;
    background: var(--sidebar);
    border-right: 1px solid #2a2a29;
  }

  .brand-lockup,
  .topbar-context {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .brand-lockup {
    padding: 4px 8px 22px;
  }

  .brand-symbol,
  .context-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    color: #c8f7df;
    background: #203a30;
    border: 1px solid #315344;
    border-radius: 5px;
  }

  .brand-lockup > span:last-child,
  .topbar-context > span:last-child {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .brand-lockup strong {
    font-size: 15px;
    letter-spacing: -0.02em;
  }

  .brand-lockup small {
    margin-top: 2px;
    color: #858581;
    font-size: 9px;
  }

  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sidebar-nav a {
    display: flex;
    align-items: center;
    min-height: 36px;
    gap: 10px;
    padding: 0 10px;
    color: var(--sidebar-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 560;
    text-decoration: none;
  }

  .sidebar-nav a:hover {
    color: #ffffff;
    background: #222222;
  }

  .sidebar-nav a.active {
    color: #ffffff;
    background: #2a2a29;
    border-color: #393938;
  }

  .sidebar-nav a.active::before {
    position: absolute;
    left: 0;
    width: 2px;
    height: 20px;
    content: "";
    background: var(--green-bright);
  }

  .sidebar-spacer {
    flex: 1;
  }

  .workspace-strip {
    display: grid;
    grid-template-columns: 30px 1fr auto;
    align-items: center;
    gap: 9px;
    padding: 8px;
    color: #dfdfdc;
    background: #202020;
    border: 1px solid #343433;
    border-radius: 5px;
  }

  .workspace-avatar {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    color: #bff1d7;
    background: #244437;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 800;
  }

  .workspace-strip > span:nth-child(2) {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .workspace-strip strong {
    overflow: hidden;
    font-size: 9px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-strip small {
    margin-top: 2px;
    color: #858581;
    font-size: 8px;
  }

  .workspace-strip > :global(svg) {
    color: var(--green-bright);
  }

  .console-main {
    min-width: 0;
    flex: 1;
  }

  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 62px;
    padding: 9px 28px;
    background: rgba(255, 255, 255, 0.96);
    border-bottom: 1px solid var(--border);
    backdrop-filter: blur(12px);
  }

  .context-icon {
    width: 30px;
    height: 30px;
    color: #256c4d;
    background: #ebf6f0;
    border-color: #cde6d9;
  }

  .topbar-context strong {
    font-size: 11px;
  }

  .topbar-context small {
    margin-top: 2px;
    color: var(--muted);
    font-size: 9px;
  }

  .topbar-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .search-field {
    display: grid;
    grid-template-columns: auto minmax(120px, 230px) auto;
    align-items: center;
    gap: 7px;
    height: 34px;
    padding: 0 7px 0 10px;
    color: #787874;
    background: #f9f9f8;
    border: 1px solid #d9d9d6;
    border-radius: 4px;
  }

  .search-field:focus-within {
    background: #ffffff;
    border-color: #479f78;
    box-shadow: 0 0 0 2px #dbefe5;
  }

  .search-field input {
    width: 100%;
    color: var(--ink);
    background: transparent;
    border: 0;
    outline: none;
    font-size: 11px;
  }

  .search-field kbd {
    padding: 2px 5px;
    color: #858581;
    background: #ffffff;
    border: 1px solid #d9d9d6;
    border-bottom-width: 2px;
    border-radius: 3px;
    font-size: 8px;
  }

  .primary-button,
  .refresh-button,
  .text-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    gap: 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 650;
  }

  .primary-button {
    padding: 0 13px;
    color: #ffffff;
    background: #24704f;
    border: 1px solid #1d6144;
    box-shadow: 0 1px 2px rgba(25, 72, 52, 0.18);
  }

  .primary-button:hover {
    background: #1f6247;
  }

  .refresh-button {
    width: 34px;
    color: #646460;
    background: #ffffff;
    border: 1px solid #d9d9d6;
  }

  .refresh-button:hover {
    color: #1f6247;
    background: #f4f8f5;
  }

  .console-canvas {
    width: min(1440px, 100%);
    margin: 0 auto;
    padding: 36px clamp(20px, 3.2vw, 48px) 52px;
  }

  .page-intro {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 24px;
  }

  .eyebrow,
  .panel-kicker {
    margin: 0 0 7px;
    color: #777772;
    font-size: 8px;
    font-weight: 750;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .eyebrow {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .eyebrow span {
    width: 6px;
    height: 6px;
    background: var(--green-bright);
    border-radius: 50%;
    box-shadow: 0 0 0 3px #dff3e9;
  }

  .eyebrow.disconnected span {
    background: #bf554d;
    box-shadow: 0 0 0 3px #f7dedb;
  }

  .page-intro h1 {
    margin: 0;
    font-size: clamp(30px, 3.4vw, 46px);
    font-weight: 620;
    line-height: 1.05;
    letter-spacing: -0.045em;
  }

  .page-intro > div:first-child > p:last-child {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 11px;
  }

  .runtime-badge {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    color: #656560;
    background: #ffffff;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 9px;
  }

  .runtime-badge strong {
    color: #245f46;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 9px;
  }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 360px;
    gap: 9px;
    color: var(--muted);
    font-size: 11px;
  }

  .spin {
    animation: spin 0.8s linear infinite;
  }

  .error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    padding: 10px 12px;
    color: #8f3e39;
    background: #fff5f3;
    border: 1px solid #edcfca;
    border-radius: 4px;
    font-size: 10px;
  }

  .error-banner button {
    margin-left: auto;
    color: inherit;
    background: transparent;
    border: 0;
    font-weight: 700;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 10px;
  }

  .stat-card,
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 5px;
    box-shadow: 0 1px 1px rgba(20, 30, 25, 0.025);
  }

  .stat-card {
    min-height: 126px;
    padding: 16px;
  }

  .stat-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: #646460;
    font-size: 9px;
    font-weight: 650;
  }

  .stat-heading :global(svg) {
    color: #565652;
  }

  .stat-heading.green :global(svg) { color: #2d7c58; }
  .stat-heading.amber :global(svg) { color: #9a6a23; }
  .stat-heading.blue :global(svg) { color: #42748b; }

  .stat-card > strong {
    display: block;
    margin-top: 17px;
    font-size: 27px;
    font-weight: 610;
    letter-spacing: -0.04em;
  }

  .stat-card p {
    margin: 7px 0 0;
    color: #83837e;
    font-size: 9px;
  }

  .overview-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.55fr) minmax(310px, 0.75fr);
    gap: 10px;
    margin-bottom: 10px;
  }

  .project-health-panel,
  .system-panel {
    min-height: 280px;
    padding: 18px;
  }

  .panel-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
  }

  .panel-heading h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.02em;
  }

  .panel-heading > a {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    gap: 5px;
    padding: 0 8px;
    color: #575752;
    background: #ffffff;
    border: 1px solid #dededb;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 650;
    text-decoration: none;
  }

  .panel-heading > a:hover {
    color: #246b4c;
    background: #f2f8f4;
    border-color: #bedbc9;
  }

  .health-summary {
    display: grid;
    grid-template-columns: 110px 1fr;
    align-items: center;
    gap: 28px;
    margin-top: 34px;
  }

  .health-score {
    display: flex;
    flex-direction: column;
    padding-right: 22px;
    border-right: 1px solid var(--soft-border);
  }

  .health-score strong {
    font-size: 35px;
    font-weight: 620;
    line-height: 1;
    letter-spacing: -0.055em;
  }

  .health-score span {
    margin-top: 7px;
    color: var(--muted);
    font-size: 9px;
  }

  .health-track {
    display: flex;
    height: 8px;
    overflow: hidden;
    background: #eeeeeb;
    border-radius: 2px;
  }

  .health-track span {
    display: block;
    height: 100%;
  }

  .health-active { background: #36b77b; }
  .health-paused { background: #d8a24d; }

  .health-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-top: 13px;
    color: #777772;
    font-size: 9px;
  }

  .health-legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .health-legend i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .dot-active { background: #36b77b; }
  .dot-paused { background: #d8a24d; }
  .dot-other { background: #aaa9a4; }

  .health-legend b {
    color: #343431;
  }

  .health-footnote {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 32px;
    padding: 9px 10px;
    color: #617069;
    background: #f5f8f5;
    border-left: 2px solid #47a476;
    font-size: 9px;
  }

  .system-panel dl {
    margin: 18px 0 0;
  }

  .system-panel dl > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 39px;
    gap: 12px;
    border-bottom: 1px solid var(--soft-border);
  }

  .system-panel dt {
    display: flex;
    align-items: center;
    gap: 7px;
    color: #6e6e69;
    font-size: 9px;
  }

  .system-panel dd {
    margin: 0;
    color: #31312e;
    font-size: 9px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }

  .system-link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 13px;
    color: #286c4e;
    font-size: 9px;
    font-weight: 700;
    text-decoration: none;
  }

  .projects-heading {
    align-items: center;
    padding: 16px 18px 13px;
    border-bottom: 1px solid var(--border);
  }

  .projects-heading > span {
    color: #80807b;
    font-size: 8px;
  }

  .table-wrap {
    width: 100%;
    overflow: hidden;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  th {
    height: 36px;
    padding: 0 13px;
    color: #7b7b76;
    background: #f8f8f7;
    border-bottom: 1px solid var(--border);
    font-size: 8px;
    font-weight: 750;
    letter-spacing: 0.08em;
    text-align: left;
    text-transform: uppercase;
  }

  th:nth-child(1) { width: 27%; }
  th:nth-child(2) { width: 13%; }
  th:nth-child(3) { width: 18%; }
  th:nth-child(4) { width: 15%; }
  th:nth-child(5) { width: 18%; }
  th:nth-child(6) { width: 44px; }

  td {
    height: 62px;
    padding: 8px 13px;
    color: #555550;
    border-bottom: 1px solid var(--soft-border);
    font-size: 9px;
  }

  tbody tr:last-child td {
    border-bottom: 0;
  }

  tbody tr:hover {
    background: #fafbf9;
  }

  .project-identity {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 9px;
    color: inherit;
    text-decoration: none;
  }

  .project-mark {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: 0 0 34px;
    color: #286c4e;
    background: #ebf5ef;
    border: 1px solid #cae3d5;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 750;
  }

  .project-identity > span:last-child {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .project-identity strong {
    overflow: hidden;
    color: #292926;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-identity small {
    margin-top: 3px;
    overflow: hidden;
    color: #888883;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 9px;
    line-height: 1.3;
    letter-spacing: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  td code {
    padding: 2px 4px;
    color: #555550;
    background: #f4f4f2;
    border: 1px solid #e3e3df;
    border-radius: 3px;
    font-size: 8px;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 0 7px;
    border: 1px solid;
    border-radius: 999px;
    font-size: 8px;
    font-weight: 680;
    text-transform: capitalize;
  }

  .status-active { color: #226846; background: #eaf6ef; border-color: #c6e5d3; }
  .status-paused { color: #8b6324; background: #fbf4e6; border-color: #ead8b7; }
  .status-other { color: #666661; background: #f2f2f0; border-color: #d9d9d5; }

  .open-cell {
    text-align: right;
  }

  .open-cell a {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    color: #777772;
    border-radius: 3px;
  }

  .open-cell a:hover {
    color: #246b4c;
    background: #eef6f1;
  }

  .empty-state {
    display: flex;
    align-items: center;
    flex-direction: column;
    padding: 44px 20px;
    color: #777772;
    text-align: center;
  }

  .empty-state :global(svg) {
    margin-bottom: 10px;
    color: #a2a29d;
  }

  .empty-state strong {
    color: #343431;
    font-size: 11px;
  }

  .empty-state p {
    margin: 5px 0 14px;
    font-size: 9px;
  }

  .text-button {
    padding: 0 10px;
    color: #246b4c;
    background: #f4f8f5;
    border: 1px solid #c8dfd2;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 1080px) {
    .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .overview-grid { grid-template-columns: 1fr; }
    .system-panel { min-height: auto; }
  }

  @media (max-width: 800px) {
    .console-shell { display: block; }

    .console-sidebar {
      position: relative;
      z-index: 30;
      width: 100%;
      height: auto;
      min-height: 0;
      padding: 10px 12px;
      border-right: 0;
      border-bottom: 1px solid #30302f;
    }

    .brand-lockup { padding: 1px 3px 9px; }
    .brand-symbol { width: 29px; height: 29px; }
    .brand-lockup small { display: none; }

    .sidebar-nav {
      flex-direction: row;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .sidebar-nav::-webkit-scrollbar { display: none; }
    .sidebar-nav a { width: auto; flex: 0 0 auto; min-height: 32px; padding: 0 9px; }
    .sidebar-nav a.active::before { display: none; }
    .sidebar-spacer, .workspace-strip { display: none; }

    .topbar {
      position: relative;
      align-items: stretch;
      flex-direction: column;
      gap: 9px;
      padding: 11px 15px;
    }

    .topbar-actions { width: 100%; }
    .search-field { grid-template-columns: auto minmax(0, 1fr); flex: 1; }
    .search-field kbd { display: none; }
    .console-canvas { padding: 28px 15px 42px; }
  }

  @media (max-width: 620px) {
    .stats-grid { grid-template-columns: 1fr; }

    .page-intro { align-items: flex-start; flex-direction: column; gap: 12px; }
    .runtime-badge { align-self: flex-start; }
    .health-summary { grid-template-columns: 1fr; gap: 17px; }
    .health-score { padding: 0 0 15px; border-right: 0; border-bottom: 1px solid var(--soft-border); }
    .health-footnote { margin-top: 20px; }

    table,
    tbody,
    tr,
    td {
      display: block;
      width: 100%;
    }

    thead { display: none; }

    tr {
      padding: 13px;
      border-bottom: 1px solid var(--border);
    }

    td {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: auto;
      min-height: 32px;
      padding: 4px 0;
      border: 0;
      text-align: right;
    }

    td::before {
      content: attr(data-label);
      margin-right: 14px;
      color: #80807b;
      font-size: 8px;
      font-weight: 750;
      letter-spacing: 0.07em;
      text-transform: uppercase;
    }

    td:first-child { padding: 0 0 8px; }
    td:first-child::before, .open-cell::before { display: none; }
    .project-identity { width: 100%; text-align: left; }
    .open-cell { justify-content: flex-end; }
  }

  @media (max-width: 420px) {
    .topbar-context small { display: none; }
    .primary-button { padding: 0 10px; }
    .page-intro h1 { font-size: 34px; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
