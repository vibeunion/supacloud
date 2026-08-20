import { setup } from "xstate";

type ReviewContext = {
  actorId: string;
  actorRole: "maker" | "checker";
  makerId: string;
  payloadChecksum: string;
  submittedPayloadChecksum: string | null;
};

type ReviewEvent =
  | { type: "SUBMIT" }
  | { type: "RETURN"; reason: string }
  | { type: "APPROVE" }
  | { type: "COMPLETE" };

export const reviewDocumentMachine = setup({
  types: {
    context: {} as ReviewContext,
    events: {} as ReviewEvent,
    input: {} as ReviewContext,
  },
  guards: {
    isMaker: ({ context }) =>
      context.actorRole === "maker" && context.actorId === context.makerId,
    isSeparatedChecker: ({ context }) =>
      context.actorRole === "checker" && context.actorId !== context.makerId,
  },
}).createMachine({
  id: "review-document-v1",
  initial: "draft",
  context: ({ input }) => input,
  states: {
    draft: {
      on: { SUBMIT: { target: "submitted", guard: "isMaker" } },
    },
    returned: {
      on: { SUBMIT: { target: "submitted", guard: "isMaker" } },
    },
    submitted: {
      on: {
        RETURN: {
          target: "returned",
          guard: ({ context, event }) =>
            context.actorRole === "checker"
            && context.actorId !== context.makerId
            && event.reason.trim().length > 0,
        },
        APPROVE: {
          target: "approved",
          guard: ({ context }) =>
            context.actorRole === "checker"
            && context.actorId !== context.makerId
            && context.submittedPayloadChecksum !== null
            && context.submittedPayloadChecksum === context.payloadChecksum,
        },
      },
    },
    approved: {
      on: { COMPLETE: { target: "completed", guard: "isSeparatedChecker" } },
    },
    completed: { type: "final" },
  },
});

// This machine controls UI affordances only. Always submit the event to
// transition_review_document(), which rechecks state, actor, version, and checksum.
