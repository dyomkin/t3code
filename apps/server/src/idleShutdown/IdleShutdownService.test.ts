import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { ComputerPower } from "../process/ComputerPower.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { IdleShutdownService, layer } from "./IdleShutdownService.ts";

const testLayer = (shutdown: () => void, available = true) =>
  layer.pipe(
    Layer.provideMerge(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer))),
    Layer.provide(
      Layer.succeed(
        ComputerPower,
        ComputerPower.of({ available, shutdown: Effect.sync(shutdown) }),
      ),
    ),
  );
const insertRun = (id: string, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runs
    (run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json)
    VALUES (${id},${id},1,'codex',${status},'1970-01-01T00:00:00.000Z',${status === "completed" ? "1970-01-01T00:00:00.001Z" : null},'{}')`;
  });

describe("one-shot shutdown after every task", () => {
  it.effect("starts off, waits for work, catches a fast completed run and fires only once", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const service = yield* IdleShutdownService;
      expect((yield* service.status).enabled).toBe(false);
      yield* service.setEnabled(true);
      yield* TestClock.adjust("5 minutes");
      expect(calls).toBe(0);
      expect((yield* service.status).phase).toBe("armed");
      // This entire run finished between two monitor samples.
      yield* insertRun("fast", "completed");
      yield* TestClock.adjust("2 seconds");
      expect((yield* service.status).phase).toBe("countdown");
      yield* TestClock.adjust("118 seconds");
      expect(calls).toBe(0);
      yield* TestClock.adjust("4 seconds");
      expect(calls).toBe(1);
      expect((yield* service.status).enabled).toBe(false);
      yield* TestClock.adjust("10 minutes");
      expect(calls).toBe(1);
    }).pipe(Effect.provide(testLayer(() => calls++)));
  });

  it.effect(
    "waits for other agents, queued work and outbox completion; new work resets the countdown",
    () => {
      let calls = 0;
      return Effect.gen(function* () {
        const service = yield* IdleShutdownService;
        const sql = yield* SqlClient.SqlClient;
        yield* insertRun("parent", "running");
        yield* insertRun("child", "queued");
        yield* service.setEnabled(true);
        yield* TestClock.adjust("2 seconds");
        yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed' WHERE run_id='parent'`;
        yield* TestClock.adjust("3 minutes");
        expect((yield* service.status).phase).toBe("waiting");
        expect(calls).toBe(0);
        yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed'`;
        yield* sql`INSERT INTO orchestration_v2_projection_subagents
          (subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json)
          VALUES ('native-agent','parent','node','claudeAgent','provider','running','1970-01-01','{}')`;
        yield* TestClock.adjust("2 seconds");
        expect((yield* service.status).phase).toBe("waiting");
        yield* sql`UPDATE orchestration_v2_projection_subagents SET status='completed'`;
        yield* sql`INSERT INTO orchestration_v2_effect_outbox
        (effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,created_at,updated_at)
        VALUES ('checkpoint','command','parent','checkpoint','{}','running',1,'1970-01-01','1970-01-01','1970-01-01')`;
        yield* TestClock.adjust("2 seconds");
        expect((yield* service.status).phase).toBe("waiting");
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status='succeeded'`;
        yield* TestClock.adjust("2 seconds");
        expect((yield* service.status).phase).toBe("countdown");
        yield* TestClock.adjust("118 seconds");
        yield* insertRun("new-request", "preparing");
        yield* TestClock.adjust("4 seconds");
        expect(calls).toBe(0);
        expect((yield* service.status).deadline).toBeNull();
        yield* service.setEnabled(false);
        yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed'`;
        yield* TestClock.adjust("5 minutes");
        expect(calls).toBe(0);
      }).pipe(Effect.provide(testLayer(() => calls++)));
    },
  );

  it.effect("cancels on failed or interrupted tasks instead of treating them as success", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const service = yield* IdleShutdownService;
      const sql = yield* SqlClient.SqlClient;
      yield* insertRun("work", "running");
      yield* service.setEnabled(true);
      yield* TestClock.adjust("2 seconds");
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='interrupted',completed_at='1970-01-01T00:00:02.000Z'`;
      yield* TestClock.adjust("2 seconds");
      expect((yield* service.status).phase).toBe("error");
      expect((yield* service.status).enabled).toBe(false);
      yield* TestClock.adjust("5 minutes");
      expect(calls).toBe(0);
    }).pipe(Effect.provide(testLayer(() => calls++)));
  });

  it.effect("cancels if activity cannot be verified", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const service = yield* IdleShutdownService;
      const sql = yield* SqlClient.SqlClient;
      yield* service.setEnabled(true);
      yield* sql`DROP TABLE orchestration_v2_projection_runtime_requests`;
      yield* TestClock.adjust("2 seconds");
      expect((yield* service.status).phase).toBe("error");
      expect((yield* service.status).enabled).toBe(false);
      expect(calls).toBe(0);
    }).pipe(Effect.provide(testLayer(() => calls++)));
  });

  it.effect("restarts the countdown when a second fast task finishes between samples", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const service = yield* IdleShutdownService;
      yield* service.setEnabled(true);
      yield* insertRun("first-fast", "completed");
      yield* TestClock.adjust("2 seconds");
      const firstDeadline = (yield* service.status).deadline!;
      yield* TestClock.adjust(firstDeadline - (yield* Clock.currentTimeMillis) - 2_000);
      yield* insertRun("second-fast", "completed");
      yield* TestClock.adjust("2 seconds");
      expect(calls).toBe(0);
      expect((yield* service.status).deadline).toBeGreaterThan(firstDeadline);
      yield* service.setEnabled(false);
    }).pipe(Effect.provide(testLayer(() => calls++)));
  });

  it.effect("cancels if a checkpoint or another post-turn effect fails", () =>
    Effect.gen(function* () {
      const service = yield* IdleShutdownService;
      const sql = yield* SqlClient.SqlClient;
      yield* service.setEnabled(true);
      yield* sql`INSERT INTO orchestration_v2_effect_outbox
      (effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,created_at,updated_at)
      VALUES ('failed-checkpoint','command','thread','checkpoint','{}','failed',1,'1970-01-01T00:00:01.000Z','1970-01-01T00:00:01.000Z','1970-01-01T00:00:01.000Z')`;
      yield* TestClock.adjust("2 seconds");
      expect((yield* service.status).phase).toBe("error");
      expect((yield* service.status).enabled).toBe(false);
    }).pipe(
      Effect.provide(
        testLayer(() => {
          throw new Error("must not shut down");
        }),
      ),
    ),
  );

  it.effect("refuses to arm unsupported hosts", () =>
    Effect.gen(function* () {
      const service = yield* IdleShutdownService;
      expect(Exit.isFailure(yield* Effect.exit(service.setEnabled(true)))).toBe(true);
      expect((yield* service.status).enabled).toBe(false);
    }).pipe(
      Effect.provide(
        testLayer(() => {
          throw new Error("must not run");
        }, false),
      ),
    ),
  );
});
