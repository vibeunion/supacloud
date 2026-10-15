export const STARTER_REVIEW_QUERY = `import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReviewRow } from "../../db/schema";

// This read projection uses SQL column names shared with the Drizzle source.
// Do not expose camelCase Drizzle property names as PostgREST column names.
export type ReviewSummary = Pick<ReviewRow, "id" | "state" | "version">;
export type ReviewReadDatabase = {
  public: {
    Tables: {
      starter_reviews: {
        Row: ReviewSummary;
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
  };
};

export interface ReviewPageOptions {
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

// Reuse the application's user-scoped client. Identity verification and row
// authorization belong to the gateway and database, never a caller-supplied owner.
export async function listReviews(
  client: SupabaseClient<ReviewReadDatabase>,
  { page = 1, pageSize = 25, signal }: ReviewPageOptions = {},
) {
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    || !Number.isSafeInteger(page * pageSize)) {
    throw new RangeError("Invalid review page: page >= 1 and pageSize between 1 and 100 are required");
  }
  signal?.throwIfAborted();
  const start = (page - 1) * pageSize;
  const query = client.from("starter_reviews")
    .select("id,state,version", { count: "exact" })
    .order("id", { ascending: true })
    .range(start, start + pageSize - 1);
  const { data, error, count } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw error;
  if (data === null || count === null) throw new Error("Incomplete review page response");
  return { data, total: count, page, pageSize, hasNextPage: start + data.length < count };
}
`;
