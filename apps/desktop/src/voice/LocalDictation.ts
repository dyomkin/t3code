// @effect-diagnostics nodeBuiltinImport:off -- Local Whisper settings and subprocess cancellation are desktop-native boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  LOCAL_DICTATION_DEFAULT_PROMPT,
  LocalDictationSettingsSchema,
  localDictationModelPath,
  type LocalDictationModelSize,
  type LocalDictationSettings,
  type LocalDictationStatus,
  type LocalDictationRequest,
} from "@t3tools/contracts";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { decodeDictationWav, runWhisper } from "./whisperRunner.ts";

export class LocalDictationError extends Schema.TaggedError<LocalDictationError>()(
  "LocalDictationError",
  {
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail;
  }
}
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new LocalDictationError({ detail: String(cause) }),
  });
const decodeSettings = Schema.decodeUnknownSync(LocalDictationSettingsSchema);

export class LocalDictation extends Context.Service<
  LocalDictation,
  {
    readonly status: Effect.Effect<LocalDictationStatus, LocalDictationError>;
    readonly selectModel: (
      size: LocalDictationModelSize,
    ) => Effect.Effect<LocalDictationStatus, LocalDictationError>;
    readonly configure: (
      settings: LocalDictationSettings,
    ) => Effect.Effect<void, LocalDictationError>;
    readonly transcribe: (
      request: LocalDictationRequest,
    ) => Effect.Effect<string, LocalDictationError>;
    readonly cancel: (requestId: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/voice/LocalDictation") {}

export const make = Effect.gen(function* () {
  const env = yield* DesktopEnvironment;
  const dir = NodePath.join(env.baseDir, "voice");
  const configPath = NodePath.join(dir, "config.json");
  const defaults: LocalDictationSettings = {
    binaryPath: NodePath.join(
      dir,
      "runtime",
      "Release",
      env.platform === "win32" ? "whisper-cli.exe" : "whisper-cli",
    ),
    modelPath: NodePath.join(dir, "ggml-medium.bin"),
    language: "ru",
    prompt: LOCAL_DICTATION_DEFAULT_PROMPT,
  };
  const active = new Map<string, AbortController>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const controller of active.values()) controller.abort();
    }),
  );
  const readSettings = async () => {
    try {
      return decodeSettings(JSON.parse(await NodeFSP.readFile(configPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
      throw error;
    }
  };
  const status = attempt(async () => {
    const settings = await readSettings();
    try {
      await Promise.all([NodeFSP.access(settings.binaryPath), NodeFSP.access(settings.modelPath)]);
      return { settings, available: true, detail: null };
    } catch {
      return {
        settings,
        available: false,
        detail: "Install whisper.cpp and a multilingual Whisper model, then set their paths below.",
      };
    }
  });
  const writeSettings = async (settings: LocalDictationSettings) => {
    await NodeFSP.mkdir(dir, { recursive: true });
    const tmp = `${configPath}.${NodeCrypto.randomUUID()}.tmp`;
    await NodeFSP.writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
    await NodeFSP.rename(tmp, configPath);
  };
  return LocalDictation.of({
    status,
    selectModel: (size) =>
      attempt(async () => {
        const settings = await readSettings();
        const modelPath = localDictationModelPath(settings.modelPath, size);
        await NodeFSP.access(modelPath);
        await writeSettings({ ...settings, modelPath });
      }).pipe(Effect.andThen(status)),
    configure: (settings) => attempt(() => writeSettings(settings)),
    cancel: (requestId) =>
      Effect.sync(() => {
        active.get(requestId)?.abort();
      }),
    transcribe: (request) =>
      attempt(async () => {
        if (active.size)
          throw new Error("Whisper is already transcribing. Wait or cancel the current dictation.");
        const wav = decodeDictationWav(request.wavBase64);
        const controller = new AbortController();
        active.set(request.requestId, controller);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
        try {
          return await runWhisper(await readSettings(), wav, signal);
        } finally {
          active.delete(request.requestId);
        }
      }),
  });
});
export const layer = Layer.effect(LocalDictation, make);
