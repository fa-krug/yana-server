/**
 * Thrown by a job handler that notices `isCancelRequested()` (`./queue`) at
 * one of its cooperative-cancellation checkpoints. `worker.ts` catches this
 * specifically and calls `cancelled()` instead of `fail()` -- no retry, no
 * stderr spam from a stack trace that isn't a bug.
 */
export class JobCancelledError extends Error {
  constructor() {
    super("job cancelled");
    this.name = "JobCancelledError";
  }
}
