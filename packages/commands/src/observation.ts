/** Best-effort metadata only; never an audit receipt or a settlement mechanism. */
export type CommandObserver<Event> = (event: Readonly<Event>) => void | Promise<void>;

export function emitCommandObservation<Event extends object>(
  observer: CommandObserver<Event> | undefined,
  event: Event,
): void {
  if (!observer) return;
  try {
    Promise.resolve(observer(Object.freeze(event))).catch(() => {});
  } catch {
    // Telemetry failure must not retry a write or hide a failed acknowledgement.
  }
}
