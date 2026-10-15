import * as Schema from "effect/Schema";

export const IdleShutdownStatus = Schema.Struct({
  available: Schema.Boolean,
  enabled: Schema.Boolean,
  phase: Schema.Literals(["disabled", "armed", "waiting", "countdown", "error"]),
  activeTasks: Schema.Number,
  deadline: Schema.NullOr(Schema.Number),
  detail: Schema.NullOr(Schema.String),
});
export type IdleShutdownStatus = typeof IdleShutdownStatus.Type;

export class IdleShutdownError extends Schema.TaggedError<IdleShutdownError>()(
  "IdleShutdownError",
  {
    operation: Schema.Literals(["read-activity", "shutdown", "unsupported"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.operation === "unsupported"
      ? "Automatic shutdown is available on the local Windows desktop environment."
      : this.operation === "read-activity"
        ? "Could not verify that all tasks have finished. Automatic shutdown was cancelled."
        : "Windows could not shut down. Automatic shutdown was cancelled.";
  }
}
