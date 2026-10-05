import type { QueryClientLike } from "./types";

/**
 * Invalidate cached queries matching explicit tags.
 * Checks query.meta.tags for intersection with the provided tags.
 * Explicitly declarative: never guesses or infers tags from procedure names.
 */
export async function invalidateByTags(
  queryClient: QueryClientLike,
  tags: string | readonly string[],
): Promise<void> {
  const targetTags = Array.isArray(tags) ? tags : [tags];
  if (targetTags.length === 0) return;
  await queryClient.invalidateQueries({
    predicate: (query) => {
      const queryTags = query.meta?.tags as readonly string[] | undefined;
      if (!Array.isArray(queryTags)) return false;
      return targetTags.some((tag) => queryTags.includes(tag));
    },
  });
}
