// @effect-diagnostics nodeBuiltinImport:off -- Isolated files exercise the native settings boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { LocalDictation, layer } from "./LocalDictation.ts";

it.effect(
  "switches installed models without resetting language or vocabulary; rejects missing files",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-model-settings-"))),
        (directory) =>
          Effect.promise(async () => {
            const resolved = await NodeFSP.realpath(directory);
            const temporary = await NodeFSP.realpath(NodeOS.tmpdir());
            if (
              NodePath.dirname(resolved).toLowerCase() !== temporary.toLowerCase() ||
              !NodePath.basename(resolved).startsWith("t3-model-settings-")
            )
              throw new Error("Unexpected temporary directory");
            await NodeFSP.rm(resolved, { recursive: true });
          }),
      );
      const voice = NodePath.join(root, "voice");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(voice);
        await NodeFSP.writeFile(NodePath.join(voice, "ggml-small.bin"), "model fixture");
        await NodeFSP.writeFile(NodePath.join(voice, "whisper.exe"), "binary fixture");
      });
      yield* Effect.gen(function* () {
        const service = yield* LocalDictation;
        yield* service.configure({
          binaryPath: NodePath.join(voice, "whisper.exe"),
          modelPath: NodePath.join(voice, "ggml-medium.bin"),
          language: "ru",
          prompt: "Русская речь и API",
        });
        const small = yield* service.selectModel("small");
        assert.isTrue(small.available);
        assert.equal(small.settings.modelPath, NodePath.join(voice, "ggml-small.bin"));
        assert.equal(small.settings.language, "ru");
        assert.equal(small.settings.prompt, "Русская речь и API");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(service.selectModel("medium"))));
        assert.equal((yield* service.status).settings.modelPath, small.settings.modelPath);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(voice, "ggml-medium.bin"), "model fixture"),
        );
        const medium = yield* service.selectModel("medium");
        assert.equal(medium.settings.modelPath, NodePath.join(voice, "ggml-medium.bin"));
        assert.equal(medium.settings.language, "ru");
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(
              Layer.succeed(DesktopEnvironment, {
                baseDir: root,
                platform: "win32",
              } as DesktopEnvironment["Service"]),
            ),
          ),
        ),
      );
    }),
);
