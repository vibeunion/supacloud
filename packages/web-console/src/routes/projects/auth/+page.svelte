<script lang="ts">
  import { 
    Users, 
    UserPlus, 
    Mail, 
    Search, 
    Filter, 
    MoreHorizontal, 
    ShieldCheck, 
    Clock,
    RefreshCcw,
    Trash2,
    Lock
  } from "lucide-svelte";
  import { cn } from "$lib/utils";

  let { data } = $props();

  let searchTerm = $state("");
  let filteredUsers = $derived(
    data.users.filter((u: any) => 
      u.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.id.toLowerCase().includes(searchTerm.toLowerCase())
    )
  );

  function formatDate(dateStr: string) {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString();
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-2xl font-bold tracking-tight">Authentication</h2>
      <p class="text-muted-foreground text-sm">Manage your users and their security settings.</p>
    </div>
    <div class="flex items-center gap-3">
      <button class="flex items-center gap-2 px-4 py-2 border rounded-md text-sm font-medium hover:bg-secondary/50">
        <Mail class="w-4 h-4" />
        Templates
      </button>
      <button class="flex items-center gap-2 px-4 py-2 bg-brand text-white rounded-md text-sm font-medium hover:opacity-90">
        <UserPlus class="w-4 h-4" />
        Invite User
      </button>
    </div>
  </div>

  <div class="flex items-center gap-4">
    <div class="relative flex-1 max-w-sm">
      <Search class="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
      <input
        type="text"
        placeholder="Search by email or ID..."
        bind:value={searchTerm}
        class="w-full bg-card border rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand"
      />
    </div>
    <div class="flex items-center gap-2 ml-auto">
      <button class="p-2 border rounded-md hover:bg-secondary/50">
        <Filter class="w-4 h-4" />
      </button>
      <button class="p-2 border rounded-md hover:bg-secondary/50">
        <RefreshCcw class="w-4 h-4" />
      </button>
    </div>
  </div>

  <!-- User List Table -->
  <div class="border rounded-lg bg-card overflow-hidden">
    <table class="w-full text-sm text-left">
      <thead class="bg-secondary/30 border-b">
        <tr>
          <th class="px-6 py-3 font-semibold text-muted-foreground">User</th>
          <th class="px-6 py-3 font-semibold text-muted-foreground">Provider</th>
          <th class="px-6 py-3 font-semibold text-muted-foreground">Created</th>
          <th class="px-6 py-3 font-semibold text-muted-foreground">Last Sign In</th>
          <th class="px-6 py-3"></th>
        </tr>
      </thead>
      <tbody class="divide-y">
        {#each filteredUsers as user}
          <tr class="hover:bg-secondary/10 transition-colors">
            <td class="px-6 py-4">
              <div class="flex flex-col">
                <span class="font-medium text-foreground">{user.email}</span>
                <span class="text-xs text-muted-foreground font-mono truncate max-w-[200px]">{user.id}</span>
              </div>
            </td>
            <td class="px-6 py-4">
              <div class="flex items-center gap-1.5 px-2 py-0.5 bg-secondary rounded-full w-fit">
                <span class="text-[10px] font-bold text-muted-foreground uppercase">Email</span>
              </div>
            </td>
            <td class="px-6 py-4 text-muted-foreground tabular-nums">
              <div class="flex items-center gap-2">
                <Clock class="w-3.5 h-3.5" />
                {formatDate(user.created_at)}
              </div>
            </td>
            <td class="px-6 py-4 text-muted-foreground tabular-nums">
              {formatDate(user.last_sign_in_at)}
            </td>
            <td class="px-6 py-4 text-right">
              <button class="p-1.5 hover:bg-secondary rounded-md">
                <MoreHorizontal class="w-4 h-4 text-muted-foreground" />
              </button>
            </td>
          </tr>
        {/each}
        {#if filteredUsers.length === 0}
           <tr>
             <td colspan="5" class="px-6 py-12 text-center text-muted-foreground">
               <div class="flex flex-col items-center space-y-2">
                 <Users class="w-12 h-12 opacity-10" />
                 <p>No users found matching your criteria</p>
               </div>
             </td>
           </tr>
        {/if}
      </tbody>
    </table>
    
    <div class="px-6 py-3 border-t bg-secondary/10 flex items-center justify-between text-xs text-muted-foreground">
      <span>Total Users: <span class="text-foreground font-medium">{data.count}</span></span>
      <div class="flex items-center gap-2">
         <span class="hover:text-brand cursor-pointer">Previous</span>
         <span class="hover:text-brand cursor-pointer">Next</span>
      </div>
    </div>
  </div>
</div>
