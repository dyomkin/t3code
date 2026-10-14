import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { QoderSettings } from "../qoderSettings.ts";
import { makeQoderTextGeneration } from "./qoderTextGeneration.ts";

const decodeSettings = Schema.decodeSync(QoderSettings);
const layerTest = TestProviderHost.layer().pipe(Layer.provideMerge(NodeServices.layer));
const modelSelection = { instanceId: ProviderInstanceId.make("qoder_work"), model: "efficient" };

function fakeCli(output: string, exitCode = 0, started?: Deferred.Deferred<void>) {
  let released = false;
  const calls: Array<{ command: ChildProcess.StandardCommand; prompt: string }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
      const stdin = command.options.stdin;
      const prompt =
        stdin && typeof stdin === "object" && "stream" in stdin && typeof stdin.stream !== "string"
          ? yield* stdin.stream.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (text, chunk) => text + chunk,
              ),
            )
          : "";
      calls.push({ command, prompt });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          released = true;
        }),
      );
      if (started) yield* Deferred.succeed(started, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: started ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(output)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { calls, spawner, released: () => released };
}

const envelope = (result: string, is_error = false) =>
  JSON.stringify({ type: "result", is_error, result });
const settings = decodeSettings({ commandPath: process.execPath });

describe("Qoder metadata generation", () => {
  it.effect("releases a stalled CLI process when generation times out", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cli = fakeCli("", 0, started);
      const generation = yield* makeQoderTextGeneration(settings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
      );
      const request = yield* generation
        .generateThreadTitle({ cwd: "/project", message: "Title", modelSelection })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(180_000);
      const failure = yield* Fiber.join(request);
      expect(failure.detail).toContain("timed out");
      expect(cli.released()).toBe(true);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("generates a linked-context title without running tools in the project", () =>
    Effect.gen(function* () {
      const cli = fakeCli(
        envelope('```json\n{"title":"  Fix login redirects  ","needsRefinement":true}\n```'),
      );
      const env = { QODER_PERSONAL_ACCESS_TOKEN: "test-token" };
      const generation = yield* makeQoderTextGeneration(settings, env).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
      );
      const result = yield* generation.generateThreadTitle({
        cwd: "/project",
        message: "Fix this link",
        linkedContext: "The change fixes login redirects.",
        modelSelection,
      });
      expect(result).toEqual({ title: "Fix login redirects", needsRefinement: true });
      const call = cli.calls[0]!;
      expect(call.command.options.cwd).not.toBe("/project");
      expect(call.command.options.env).toEqual(env);
      expect(call.prompt).toContain("The change fixes login redirects.");
      expect(call.command.args).toEqual(
        expect.arrayContaining([
          "--no-session-persistence",
          "--tools",
          "",
          "--permission-mode",
          "dont_ask",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--model",
          "efficient",
        ]),
      );
      expect(call.command.args).not.toContain("--acp");
      expect(call.command.args).not.toContain("--yolo");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("returns a sanitized commit and branch with the provided policy and diff", () =>
    Effect.gen(function* () {
      const cli = fakeCli(
        envelope(
          '{"subject":"Fix login redirects.\\nExtra line","body":"  Handle expired sessions.  ","branch":"Fix Login"}',
        ),
      );
      const generation = yield* makeQoderTextGeneration(settings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
      );
      expect(
        yield* generation.generateCommitMessage({
          cwd: "/project",
          branch: "fix/login",
          stagedSummary: "auth.ts | 2 +",
          stagedPatch: "+ redirectToLogin();",
          includeBranch: true,
          policy: {
            kind: "custom",
            inferRepositoryConventions: false,
            commitInstructions: "Mention session expiry.",
          },
          modelSelection,
        }),
      ).toEqual({
        subject: "Fix login redirects",
        body: "Handle expired sessions.",
        branch: "feature/fix-login",
      });
      expect(cli.calls[0]!.prompt).toContain("+ redirectToLogin();");
      expect(cli.calls[0]!.prompt).toContain("Mention session expiry.");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("uses the PR template and returns a title and body", () =>
    Effect.gen(function* () {
      const cli = fakeCli(
        envelope(
          '{"title":"Fix login redirects\\nExtra","body":"  ## Summary\\nFix expired sessions.  "}',
        ),
      );
      const generation = yield* makeQoderTextGeneration(settings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
      );
      expect(
        yield* generation.generatePrContent({
          cwd: "/project",
          baseBranch: "main",
          headBranch: "fix/login",
          commitSummary: "Fix login",
          diffSummary: "auth.ts | 2 +",
          diffPatch: "+ redirectToLogin();",
          changeRequestTemplate: "## Summary\n## Validation",
          modelSelection,
        }),
      ).toEqual({ title: "Fix login redirects", body: "## Summary\nFix expired sessions." });
      expect(cli.calls[0]!.prompt).toContain("## Validation");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect.each([
    {
      output: envelope("Authentication required", true),
      code: 0,
      detail: "Authentication required",
    },
    { output: envelope(""), code: 0, detail: "empty output" },
    { output: envelope('{"title":42}'), code: 0, detail: "invalid structured output" },
    { output: "not-json", code: 0, detail: "unexpected output format" },
    { output: "", code: 3, detail: "exited with code 3" },
  ])("reports $detail as a typed generation error", ({ output, code, detail }) =>
    Effect.gen(function* () {
      const cli = fakeCli(output, code);
      const generation = yield* makeQoderTextGeneration(settings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
      );
      const failure = yield* Effect.flip(
        generation.generateThreadTitle({ cwd: "/project", message: "Title", modelSelection }),
      );
      expect(failure._tag).toBe("TextGenerationError");
      expect(failure.operation).toBe("generateThreadTitle");
      expect(failure.detail).toContain(detail);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("rejects a disabled instance without starting the CLI", () =>
    Effect.gen(function* () {
      const cli = fakeCli(envelope('{"title":"Unused"}'));
      const generation = yield* makeQoderTextGeneration({ ...settings, enabled: false }, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
      );
      const failure = yield* Effect.flip(
        generation.generateThreadTitle({ cwd: "/project", message: "Title", modelSelection }),
      );
      expect(failure.detail).toContain("disabled");
      expect(cli.calls).toHaveLength(0);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
