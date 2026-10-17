export const STARTER_REVIEW_RECEIPTS = `import { Effect } from "effect";
import { Controller, DB_CLIENT, Get, Inject, Injectable, Param, Query, REQUEST_CONTEXT } from "@supacloud/app";
import { ApplicationError, createSchemaDecoder } from "@supacloud/elysia";
import { ReceiptOperation, ReceiptParams, ReceiptQuery, ReceiptResult,
  type ReviewOperation, type ReviewReceipt } from "./contracts";
export type { ReviewOperation, ReviewReceipt } from "./contracts";

const decodeOperation = createSchemaDecoder(ReceiptOperation, { normalize: false });
export interface ReviewReceiptPort {
  lookupOperation(context: unknown, operation: ReviewOperation): Promise<ReviewReceipt>;
}
type ReceiptError =
  | { readonly _tag: "AUTHENTICATION_REQUIRED" }
  | { readonly _tag: "REVIEW_PERMISSION_DENIED" }
  | { readonly _tag: "UPLOAD_DENIED" }
  | { readonly _tag: "COMMAND_REJECTED" }
  | { readonly _tag: "COMMAND_IDEMPOTENCY_CONFLICT" }
  | { readonly _tag: "RECEIPT_INPUT_INVALID" }
  | { readonly _tag: "RECEIPTS_UNAVAILABLE" };

@Injectable({ scope: "request" })
export class ReviewReceipts {
  constructor(@Inject(DB_CLIENT) private readonly store: Partial<ReviewReceiptPort>,
    @Inject(REQUEST_CONTEXT) private readonly context: unknown) {}
  lookup(operation: ReviewOperation): Promise<ReviewReceipt> {
    let input: ReviewOperation;
    try { input = decodeOperation(operation); }
    catch {
      throw new ApplicationError("Invalid receipt input", { status: 400, code: "RECEIPT_INPUT_INVALID" });
    }
    if (!this.store.lookupOperation) {
      throw new ApplicationError("Receipt lookup is unavailable", { status: 503, code: "RECEIPTS_UNAVAILABLE" });
    }
    return this.store.lookupOperation(this.context, input);
  }
}

@Controller("/reviews")
export class ReviewReceiptsController {
  constructor(@Inject(ReviewReceipts) private readonly receipts: ReviewReceipts) {}
  @Get("/:id/operations/:operationId", {
    params: ReceiptParams, query: ReceiptQuery, responses: { 200: ReceiptResult },
    effect: {
      required: true, dependencies: [], retry: "none",
      errors: [
        { tag: "AUTHENTICATION_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
        { tag: "REVIEW_PERMISSION_DENIED", status: 403, code: "REVIEW_PERMISSION_DENIED" },
        { tag: "UPLOAD_DENIED", status: 403, code: "UPLOAD_DENIED" },
        { tag: "COMMAND_REJECTED", status: 403, code: "COMMAND_REJECTED" },
        { tag: "COMMAND_IDEMPOTENCY_CONFLICT", status: 409, code: "COMMAND_IDEMPOTENCY_CONFLICT" },
        { tag: "RECEIPT_INPUT_INVALID", status: 400, code: "RECEIPT_INPUT_INVALID" },
        { tag: "RECEIPTS_UNAVAILABLE", status: 503, code: "RECEIPTS_UNAVAILABLE" },
      ],
    },
  })
  lookup(@Param("id") reviewId: string, @Param("operationId") operationId: string,
    @Query("kind") kind: ReviewOperation["kind"], @Query("expectedVersion") expectedVersion: string): Effect.Effect<ReviewReceipt, ReceiptError, never> {
    return Effect.promise(() => this.receipts.lookup({ reviewId, operationId, kind, expectedVersion: Number(expectedVersion) }));
  }
}
`;
