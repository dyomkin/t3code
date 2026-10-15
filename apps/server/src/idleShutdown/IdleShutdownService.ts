import { IdleShutdownError, type IdleShutdownStatus } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { ComputerPower } from "../process/ComputerPower.ts";

export const IDLE_SHUTDOWN_DELAY_MS = 120_000;

export class IdleShutdownService extends Context.Service<
  IdleShutdownService,
  {
    readonly status: Effect.Effect<IdleShutdownStatus>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<IdleShutdownStatus, IdleShutdownError>;
  }
>()("t3/idleShutdown/IdleShutdownService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const power = yield* ComputerPower;
  const mutex = yield* Semaphore.make(1);
  let state: IdleShutdownStatus = {
    available: power.available,
    enabled: false,
    phase: "disabled",
    activeTasks: 0,
    deadline: null,
    detail: null,
  };
  let observedWork = false;
  let completedCount = 0;
  let since = "";

  // Runs include queued follow-ups and delegated agents. A provider session that
  // is merely ready is not work; display-only todo nodes do not keep a run alive.
  const activity = Effect.gen(function* () {
    const rows = yield* sql<{ active: number; failures: number; completed: number }>`
      SELECT
        (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status IN ('preparing','queued','starting','running','waiting')) +
        (SELECT COUNT(*) FROM orchestration_v2_projection_provider_turns WHERE status IN ('pending','running')) +
        (SELECT COUNT(*) FROM orchestration_v2_projection_subagents WHERE status IN ('pending','running','waiting')) +
        (SELECT COUNT(*) FROM orchestration_v2_projection_nodes WHERE status IN ('pending','running','waiting') AND json_extract(payload_json, '$.countsForRun') = 1) +
        (SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending') +
        (SELECT COUNT(*) FROM orchestration_v2_effect_outbox WHERE status IN ('pending','running')) +
        (SELECT COUNT(*) FROM orchestration_v2_thread_launch_workflows WHERE status NOT IN ('completed','failed','cancelled')) AS active,
        (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status IN ('failed','interrupted','cancelled','rolled_back') AND completed_at >= ${since}) +
        (SELECT COUNT(*) FROM orchestration_v2_effect_outbox WHERE status = 'failed' AND updated_at >= ${since}) AS failures,
        (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status = 'completed' AND completed_at >= ${since}) AS completed
    `;
    return rows[0]!;
  }).pipe(Effect.mapError((cause) => new IdleShutdownError({ operation: "read-activity", cause })));

  const cancelWithError = (error: IdleShutdownError) =>
    Effect.sync(() => {
      state = { ...state, enabled: false, phase: "error", deadline: null, detail: error.message };
    });
  const tick = mutex.withPermits(1)(
    Effect.gen(function* () {
      if (!state.enabled) return;
      const sample = yield* activity;
      const now = yield* Clock.currentTimeMillis;
      const newlyCompleted = sample.completed > completedCount;
      completedCount = sample.completed;
      observedWork ||= sample.completed > 0;
      if (sample.failures > 0) {
        state = {
          ...state,
          enabled: false,
          phase: "error",
          deadline: null,
          activeTasks: sample.active,
          detail: "A task failed or was interrupted. Automatic shutdown was cancelled.",
        };
      } else if (sample.active > 0) {
        observedWork = true;
        state = {
          ...state,
          phase: "waiting",
          activeTasks: sample.active,
          deadline: null,
          detail: "Waiting for every task, queued follow-up and agent in this environment.",
        };
      } else if (!observedWork) {
        state = {
          ...state,
          phase: "armed",
          activeTasks: 0,
          detail: "Send a task to begin. Automatic shutdown is armed for this session only.",
        };
      } else if (state.deadline === null || newlyCompleted) {
        state = {
          ...state,
          phase: "countdown",
          activeTasks: 0,
          deadline: now + IDLE_SHUTDOWN_DELAY_MS,
          detail: "All tasks finished. Cancel to keep this computer on.",
        };
      } else if (now >= state.deadline) {
        // Re-read after the countdown, including outbox work committed by a new
        // request. Drop the one-shot intent before invoking the OS, even on error.
        const latest = yield* activity;
        if (latest.completed > completedCount && latest.active === 0 && latest.failures === 0) {
          completedCount = latest.completed;
          state = { ...state, deadline: now + IDLE_SHUTDOWN_DELAY_MS };
          return;
        }
        if (latest.active > 0 || latest.failures > 0) {
          state = { ...state, deadline: null, phase: "waiting", activeTasks: latest.active };
          return;
        }
        state = {
          ...state,
          enabled: false,
          phase: "disabled",
          deadline: null,
          detail: "Windows shutdown requested.",
        };
        yield* power.shutdown;
      }
    }).pipe(Effect.catchTags({ IdleShutdownError: cancelWithError })),
  );

  yield* tick.pipe(Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkScoped);

  return IdleShutdownService.of({
    status: Effect.sync(() => state),
    setEnabled: (enabled) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          if (enabled && !power.available)
            return yield* new IdleShutdownError({ operation: "unsupported" });
          if (enabled === state.enabled) return state;
          since = DateTime.formatIso(yield* DateTime.now);
          observedWork = false;
          completedCount = 0;
          state = {
            available: power.available,
            enabled,
            phase: enabled ? "armed" : "disabled",
            activeTasks: 0,
            deadline: null,
            detail: enabled
              ? "Waiting for tasks. This switch resets after shutdown or restarting T3 Code."
              : "Automatic shutdown is off.",
          };
          return state;
        }),
      ),
  });
});
export const layer = Layer.effect(IdleShutdownService, make);
