# @supacloud/query

TanStack Query adapter for SupaCloud procedure clients, providing deterministic query keys, `queryOptions`, `mutationOptions`, and explicit tag-based cache invalidation.

## Usage

```ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createApiClient } from "./generated/client";
import { createQueryAdapter } from "@supacloud/query";

const client = createApiClient({ baseUrl: "/api" });
const api = createQueryAdapter(client);

// 1. Query options with deterministic sorted queryKey
const { data, isLoading } = useQuery(
  api.items.get.queryOptions({ tenantId: "t1", id: 1 })
);

// 2. Mutation options with explicit tag invalidation
const queryClient = useQueryClient();
const acceptCase = useMutation(
  api.cases.accept.mutationOptions({
    queryClient,
    invalidateTags: ["cases"],
  })
);
```
