import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";
import { LOCAL_DICTATION_DEFAULT_PROMPT, LocalDictationStatusSchema } from "@t3tools/contracts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { LocalDictation } from "../../voice/LocalDictation.ts";
import {
  getLocalDictationStatus,
  transcribeLocalDictation,
  cancelLocalDictation,
} from "./localDictation.ts";
const decodeStatus = Schema.decodeUnknownSync(LocalDictationStatusSchema);

describe("local dictation IPC authorization", () => {
  it.effect("rejects guest and detached requests before touching the local voice service", () => {
    let calls = 0;
    const window = { webContents: { id: 42 } } as Electron.BrowserWindow;
    const layer = Layer.mergeAll(
      Layer.mock(ElectronWindow)({ main: Effect.succeedSome(window) }),
      Layer.mock(LocalDictation)({
        status: Effect.sync(() => {
          calls++;
          return {
            settings: {
              binaryPath: "whisper",
              modelPath: "medium",
              language: "ru" as const,
              prompt: LOCAL_DICTATION_DEFAULT_PROMPT,
            },
            available: true,
            detail: null,
          };
        }),
        transcribe: () =>
          Effect.sync(() => {
            calls++;
            return "Привет, API.";
          }),
        cancel: () =>
          Effect.sync(() => {
            calls++;
          }),
      }),
    );
    return Effect.gen(function* () {
      const request = { requestId: "test", wavBase64: "AA==" };
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(getLocalDictationStatus.handler(undefined, { sender: { id: 99 } })),
        ),
      );
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(transcribeLocalDictation.handler(request, undefined))),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(cancelLocalDictation.handler("test", { sender: { id: 99 } })),
        ),
      );
      assert.equal(calls, 0);
      assert.isTrue(
        decodeStatus(yield* getLocalDictationStatus.handler(undefined, { sender: { id: 42 } }))
          .available,
      );
      assert.equal(
        yield* transcribeLocalDictation.handler(request, { sender: { id: 42 } }),
        "Привет, API.",
      );
      yield* cancelLocalDictation.handler("test", { sender: { id: 42 } });
      assert.equal(calls, 3);
    }).pipe(Effect.provide(layer));
  });
});
