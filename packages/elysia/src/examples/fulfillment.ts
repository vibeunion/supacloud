import type { DurableCommandReceipt } from "@supacloud/contracts";
import type { CompiledCommandBinding, CompiledCommandCallContext } from "../command-binding";

export interface OrderInput { orderId: string }
export interface ReservationInput extends OrderInput { reservationId: string }
export interface ReservationResult { reservationId: string }
export interface PaymentResult { outcome: "paid" | "declined" }
export interface OrderResult { orderId: string }

export interface FulfillmentSteps {
  reserve: CompiledCommandBinding<OrderInput, DurableCommandReceipt<ReservationResult>>;
  charge: CompiledCommandBinding<ReservationInput, DurableCommandReceipt<PaymentResult>>;
  confirm: CompiledCommandBinding<ReservationInput, DurableCommandReceipt<OrderResult>>;
  release: CompiledCommandBinding<ReservationInput, DurableCommandReceipt<OrderResult>>;
}

export type FulfillmentOutcome =
  | { status: "completed" | "declined"; orderId: string }
  | { status: "pending"; step: keyof FulfillmentSteps; operationId: string };

function hasCompletedReceipt<Result>(
  receipt: DurableCommandReceipt<Result>,
): receipt is Extract<DurableCommandReceipt<Result>, { status: "confirmed" }> {
  return receipt.status === "confirmed" && receipt.audit === "complete";
}

/**
 * Application-owned composition, not a scheduler or a distributed transaction.
 * Each bound step owns authorization, durable receipts and its local transaction.
 */
export function createFulfillment(steps: FulfillmentSteps) {
  const { reserve, charge, confirm, release } = steps;
  return {
    async execute(input: OrderInput, context: CompiledCommandCallContext): Promise<FulfillmentOutcome> {
      const reservation = await reserve.execute(input, context);
      if (!hasCompletedReceipt(reservation)) {
        return { status: "pending", step: "reserve", operationId: reservation.operationId };
      }
      const reserved = { orderId: input.orderId, reservationId: reservation.result.reservationId };
      const payment = await charge.execute(reserved, context);
      if (!hasCompletedReceipt(payment)) {
        return { status: "pending", step: "charge", operationId: payment.operationId };
      }

      // Compensation needs definitive domain rejection, never a timeout or unknown receipt.
      if (payment.result.outcome === "declined") {
        const released = await release.execute(reserved, context);
        if (!hasCompletedReceipt(released)) {
          return { status: "pending", step: "release", operationId: released.operationId };
        }
        return { status: "declined", orderId: released.result.orderId };
      }
      const confirmed = await confirm.execute(reserved, context);
      if (!hasCompletedReceipt(confirmed)) {
        return { status: "pending", step: "confirm", operationId: confirmed.operationId };
      }
      return { status: "completed", orderId: confirmed.result.orderId };
    },
  };
}
