import {
  LocalDictationRequestSchema,
  LocalDictationSettingsSchema,
  LocalDictationStatusSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { LocalDictation, LocalDictationError } from "../../voice/LocalDictation.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

const trusted = Effect.fn(function* (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) {
  const main = yield* (yield* ElectronWindow).main;
  if (!event || Option.isNone(main) || main.value.webContents.id !== event.sender.id) {
    return yield* new LocalDictationError({ detail: "Dictation request was rejected." });
  }
});
export const getLocalDictationStatus = DesktopIpc.makeIpcMethod({
  channel: Channels.LOCAL_DICTATION_STATUS_CHANNEL,
  payload: Schema.Void,
  result: LocalDictationStatusSchema,
  handler: Effect.fn(function* (_, event) {
    yield* trusted(event);
    return yield* (yield* LocalDictation).status;
  }),
});
export const setLocalDictationSettings = DesktopIpc.makeIpcMethod({
  channel: Channels.LOCAL_DICTATION_CONFIGURE_CHANNEL,
  payload: LocalDictationSettingsSchema,
  result: Schema.Void,
  handler: Effect.fn(function* (settings, event) {
    yield* trusted(event);
    yield* (yield* LocalDictation).configure(settings);
  }),
});
export const transcribeLocalDictation = DesktopIpc.makeIpcMethod({
  channel: Channels.LOCAL_DICTATION_TRANSCRIBE_CHANNEL,
  payload: LocalDictationRequestSchema,
  result: Schema.String,
  handler: Effect.fn(function* (request, event) {
    yield* trusted(event);
    return yield* (yield* LocalDictation).transcribe(request);
  }),
});
export const cancelLocalDictation = DesktopIpc.makeIpcMethod({
  channel: Channels.LOCAL_DICTATION_CANCEL_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn(function* (id, event) {
    yield* trusted(event);
    yield* (yield* LocalDictation).cancel(id);
  }),
});
