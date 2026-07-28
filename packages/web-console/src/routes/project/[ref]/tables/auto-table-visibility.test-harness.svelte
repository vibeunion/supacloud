<script lang="ts">
  import type { DataProvider, ResourceDefinition, RouterProvider } from '@svadmin/core';
  import { AdminApp, AutoTable } from '@svadmin/ui';

  const dataProvider = {
    getList: async () => ({
      data: [{ id: 'user-1', name: 'Test User', email: 'user@example.com' }],
      total: 1,
    }),
    getOne: async () => ({ data: { id: 'user-1' } }),
    create: async () => ({ data: { id: 'user-1' } }),
    update: async () => ({ data: { id: 'user-1' } }),
    deleteOne: async () => ({ data: { id: 'user-1' } }),
    getApiUrl: () => 'https://example.test',
  } as DataProvider;

  const resources: ResourceDefinition[] = [{
    name: 'users',
    label: 'Users',
    canCreate: false,
    canEdit: false,
    canDelete: false,
    fields: [
      { key: 'id', label: 'ID', type: 'text' },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
    ],
  }];

  const routerProvider: RouterProvider = {
    go: () => {},
    back: () => {},
    parse: () => ({ pathname: '/', params: {} }),
  };
</script>

{#snippet dashboard()}
  <AutoTable resourceName="users" selectable={false} />
{/snippet}

<AdminApp {dataProvider} {resources} {routerProvider} locale="en" {dashboard} />
