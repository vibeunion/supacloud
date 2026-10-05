import type { QueryClientLike, QueryKey } from "./types.js";

/**
 * Invalidate cached queries matching explicit tags.
 * Checks query.meta.tags for intersection with the provided tags.
 * Explicitly declarative: never guesses or infers tags from procedure names.
 */
export async function invalidateByTags(
  queryClient: QueryClientLike,
  tags: string | readonly string[],
  keyPrefix?: QueryKey,
): Promise<void> {
  const targetTags = Array.isArray(tags) ? tags : [tags];
  if (targetTags.length === 0) return;
  await queryClient.invalidateQueries({
    ...(keyPrefix ? { queryKey: keyPrefix } : {}),
    predicate: (query) => {
      const queryTags = query.meta?.tags as readonly string[] | undefined;
      if (!Array.isArray(queryTags)) return false;
      return targetTags.some((tag) => queryTags.includes(tag));
    },
  });
}
