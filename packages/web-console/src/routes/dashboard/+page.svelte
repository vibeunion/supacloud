<script lang="ts">
  import { 
    Database, 
    Users, 
    Zap, 
    Box, 
    Shield, 
    Key,
    Activity,
    Server
  } from "lucide-svelte";
  
  let stats = [
    { name: 'Database Size', value: '124 MB', icon: Database, color: 'text-brand' },
    { name: 'Users', value: '1,234', icon: Users, color: 'text-blue-500' },
    { name: 'API Requests', value: '45.2k', icon: Zap, color: 'text-yellow-500' },
    { name: 'Storage', value: '2.4 GB', icon: Box, color: 'text-purple-500' },
  ];

  const projectModules = [
    { title: 'Database', description: 'Manage your Postgres tables, views and functions.', icon: Database, href: '/projects/tables' },
    { title: 'Authentication', description: 'User management and RLS policy configuration.', icon: Users, href: '/projects/auth' },
    { title: 'Storage', description: 'Scalable file storage with S3 compatibility.', icon: Box, href: '/projects/storage' },
    { title: 'Edge Functions', description: 'Deploy serverless TypeScript functions.', icon: Zap, href: '/projects/functions' },
  ];
</script>

<div class="space-y-8">
  <div>
    <h2 class="text-3xl font-bold tracking-tight">Project Overview</h2>
    <p class="text-muted-foreground">Monitor and manage your project infrastructure.</p>
  </div>

  <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
    {#each stats as stat}
      <div class="rounded-xl border bg-card p-6 shadow-sm">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-muted-foreground">{stat.name}</span>
          <stat.icon class={"w-4 h-4 " + stat.color} />
        </div>
        <div class="mt-2 flex items-baseline gap-2">
          <span class="text-2xl font-bold tracking-tight">{stat.value}</span>
        </div>
      </div>
    {/each}
  </div>

  <div class="grid gap-6 md:grid-cols-2">
    <div class="rounded-xl border bg-card shadow-sm overflow-hidden">
      <div class="p-6 border-b bg-secondary/30">
        <h3 class="font-semibold flex items-center gap-2">
          <Activity class="w-4 h-4" />
          Quick Start Modules
        </h3>
      </div>
      <div class="p-6 grid gap-4">
        {#each projectModules as mod}
          <a 
            href={mod.href}
            class="flex items-start gap-4 p-4 rounded-lg border hover:bg-secondary/50 transition-colors group"
          >
            <div class="mt-1 p-2 rounded-md bg-secondary text-foreground group-hover:text-brand transition-colors">
              <mod.icon class="w-5 h-5" />
            </div>
            <div>
              <h4 class="font-medium">{mod.title}</h4>
              <p class="text-sm text-muted-foreground">{mod.description}</p>
            </div>
          </a>
        {/each}
      </div>
    </div>

    <div class="rounded-xl border bg-card shadow-sm overflow-hidden">
      <div class="p-6 border-b bg-secondary/30">
        <h3 class="font-semibold flex items-center gap-2">
          <Server class="w-4 h-4" />
          Project Configuration
        </h3>
      </div>
      <div class="p-6 space-y-4">
        <div class="space-y-2">
          <label for="project-id" class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Project ID</label>
          <div id="project-id" class="flex items-center justify-between p-3 bg-secondary/50 rounded-md font-mono text-sm border">
            <span>default-project-ref</span>
            <button class="text-brand hover:underline">Copy</button>
          </div>
        </div>
        <div class="space-y-2">
          <label for="api-url" class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">API URL</label>
          <div id="api-url" class="flex items-center justify-between p-3 bg-secondary/50 rounded-md font-mono text-sm border">
            <span>https://api.supacloud.local/v1</span>
            <button class="text-brand hover:underline">Copy</button>
          </div>
        </div>
        <div class="pt-4 flex gap-4">
          <button class="flex-1 bg-brand text-white py-2 rounded-md text-sm font-semibold hover:opacity-90 transition-opacity">
            Restart Project
          </button>
          <button class="flex-1 border border-destructive text-destructive py-2 rounded-md text-sm font-semibold hover:bg-destructive/10 transition-colors">
            Pause Project
          </button>
        </div>
      </div>
    </div>
  </div>
</div>
