import * as Schema from "effect/Schema";

export const LOCAL_DICTATION_MAX_SECONDS = 120;
export const LOCAL_DICTATION_MAX_WAV_BYTES = 44 + 16_000 * 2 * LOCAL_DICTATION_MAX_SECONDS;
export const LOCAL_DICTATION_DEFAULT_PROMPT =
  "Русская речь с английскими техническими терминами: Codex, Claude, Qoder, T3 Code, Whisper, API, GitHub, commit, pull request, branch, TypeScript, JavaScript, React, Node.js, Windows, CLI, SDK, JSON, OAuth, regex, localhost.";

export const LocalDictationSettingsSchema = Schema.Struct({
  binaryPath: Schema.String.check(Schema.isMaxLength(4096)),
  modelPath: Schema.String.check(Schema.isMaxLength(4096)),
  language: Schema.Literals(["ru", "en", "auto"]),
  prompt: Schema.String.check(Schema.isMaxLength(2048)),
});
export type LocalDictationSettings = typeof LocalDictationSettingsSchema.Type;

export const LocalDictationStatusSchema = Schema.Struct({
  settings: LocalDictationSettingsSchema,
  available: Schema.Boolean,
  detail: Schema.NullOr(Schema.String),
});
export type LocalDictationStatus = typeof LocalDictationStatusSchema.Type;

export const LocalDictationRequestSchema = Schema.Struct({
  requestId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,64}$/)),
  wavBase64: Schema.String.check(
    Schema.isMaxLength(Math.ceil(LOCAL_DICTATION_MAX_WAV_BYTES / 3) * 4),
  ),
});
export type LocalDictationRequest = typeof LocalDictationRequestSchema.Type;
