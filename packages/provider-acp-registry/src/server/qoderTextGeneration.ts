import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { normalizeCliError } from "@t3tools/provider-core/server/textGenerationUtils";
import type { AcpRegistrySettings } from "../settings.ts";

const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("result"),
      is_error: Schema.Boolean,
      result: Schema.String,
    }),
  ),
);
const isTextGenerationError = Schema.is(TextGenerationError);
const TIMEOUT_MS = 180_000;

/** Stateless Qoder requests; all context comes from the shared metadata prompts. */
export const makeQoderTextGeneration = Effect.fn("makeQoderTextGeneration")(function* (
  settings: AcpRegistrySettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const host = yield* ProviderHost.ProviderHost;
  const executable = expandHomePath(
    settings.commandPath || "qodercli",
    yield* HostProcess.HomeDirectory,
  );

  const run: TextGenerationOperations.Runner = (request) =>
    Effect.gen(function* () {
      const { operation, prompt, modelSelection } = request;
      if (!settings.enabled) {
        return yield* new TextGenerationError({
          operation,
          detail: "Qoder is disabled in T3 Code settings.",
        });
      }
      // Empty working and setting sources keep project/user hooks, instructions,
      // and plugins out of background metadata generation. Credentials still apply.
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-qoder-text-" });
      const attachmentArgs: string[] = [];
      for (const attachment of request.attachments ?? []) {
        const path = host.resolveAttachmentPath(attachment);
        if (path === null) {
          return yield* new TextGenerationError({
            operation,
            detail: "Qoder text generation attachment is unavailable.",
          });
        }
        attachmentArgs.push("--attachment", path);
      }
      const launch = yield* resolveSpawnCommand(
        executable,
        [
          "--print",
          "--output-format",
          "json",
          "--no-session-persistence",
          "--setting-sources",
          "",
          "--tools",
          "",
          "--permission-mode",
          "dont_ask",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--max-output-tokens",
          "4096",
          ...(modelSelection.model === "default" ? [] : ["--model", modelSelection.model]),
          ...attachmentArgs,
        ],
        { env: environment },
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(launch.command, launch.args, {
          cwd,
          env: environment,
          shell: launch.shell,
          stdin: { stream: Stream.encodeText(Stream.make(prompt)) },
        }),
      );
      const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (output, chunk) => output + chunk,
          ),
        );
      const [stdout, , exitCode] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* new TextGenerationError({
          operation,
          detail: `Qoder CLI exited with code ${exitCode}.`,
        });
      }
      const output = yield* decodeResult(stdout).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Qoder CLI returned an unexpected output format.",
              cause,
            }),
        ),
      );
      if (output.is_error || !output.result.trim()) {
        const detail = output.is_error
          ? makeProviderFailure({ class: "provider_error", message: output.result }).message
          : "Qoder CLI returned empty output.";
        return yield* new TextGenerationError({ operation, detail });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Qoder", output.result);
    }).pipe(
      Effect.timeoutOrElse({
        duration: TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new TextGenerationError({
              operation: request.operation,
              detail: "Qoder CLI request timed out.",
            }),
          ),
      }),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : normalizeCliError(
              "qodercli",
              request.operation,
              cause,
              "Qoder CLI text generation failed.",
            ),
      ),
      Effect.scoped,
    );

  return TextGenerationOperations.fromRunner(
    "QoderTextGeneration",
    TextGenerationOperations.withoutInvestigation("Qoder", run),
  );
});
