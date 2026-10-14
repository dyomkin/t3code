// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the native subprocess boundary and its real temporary-file cleanup.
import * as NodeEvents from "node:events";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_DICTATION_DEFAULT_PROMPT, type LocalDictationSettings } from "@t3tools/contracts";
import { encodeDictationWav } from "@t3tools/client-runtime/voice-input/wav";
import { decodeDictationWav, runWhisper, whisperArguments } from "./whisperRunner.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const settings: LocalDictationSettings = {
  binaryPath: "whisper-cli",
  modelPath: "medium.bin",
  language: "ru",
  prompt: LOCAL_DICTATION_DEFAULT_PROMPT,
};
const audio = () => Buffer.from(encodeDictationWav(new Float32Array([0, -1, 0.5, 1])));

describe("Whisper dictation boundary", () => {
  beforeEach(() => vi.clearAllMocks());
  it("preserves signed PCM samples and rejects malformed or differently sampled input", () => {
    const wav = audio();
    expect(decodeDictationWav(wav.toString("base64"))).toEqual(wav);
    expect(wav.readInt16LE(46)).toBe(-32768);
    expect(wav.readInt16LE(50)).toBe(32767);
    wav.writeUInt32LE(48000, 24);
    expect(() => decodeDictationWav(wav.toString("base64"))).toThrow("16 kHz");
    expect(() => decodeDictationWav("not base64!")).toThrow("Invalid");
    expect(() => decodeDictationWav(Buffer.alloc(43).toString("base64"))).toThrow();
    expect(() => encodeDictationWav(new Float32Array(16000 * 121))).toThrow("two minutes");
    const longest = Buffer.from(encodeDictationWav(new Float32Array(16000 * 120)));
    expect(decodeDictationWav(longest.toString("base64")).length).toBe(longest.length);
  });
  it("forces Russian transcription and passes English vocabulary without enabling translation", () => {
    const args = whisperArguments(settings, "record.wav", "result");
    expect(args.slice(args.indexOf("--language"), args.indexOf("--language") + 2)).toEqual([
      "--language",
      "ru",
    ]);
    expect(args).toContain(LOCAL_DICTATION_DEFAULT_PROMPT);
    expect(args).not.toContain("--translate");
  });
  it("reads the native transcript and cleans its private temporary recording", async () => {
    let input = "";
    vi.mocked(NodeChildProcess.spawn).mockImplementation((_command, args) => {
      const child = new NodeEvents.EventEmitter();
      Object.assign(child, { stderr: new NodeEvents.EventEmitter() });
      const argv = args as string[];
      input = argv[argv.indexOf("--file") + 1]!;
      const output = argv[argv.indexOf("--output-file") + 1]!;
      void NodeFSP.readFile(input).then(async (wav) => {
        expect(wav).toEqual(audio());
        await NodeFSP.writeFile(`${output}.txt`, " Добавь API в GitHub. \n");
        child.emit("close", 0);
      });
      return child as NodeChildProcess.ChildProcess;
    });
    expect(await runWhisper(settings, audio(), new AbortController().signal)).toBe(
      "Добавь API в GitHub.",
    );
    await expect(NodeFSP.access(NodePath.dirname(input))).rejects.toThrow();
  });
  it("waits for process close on cancellation before deleting the recording", async () => {
    const controller = new AbortController();
    let child: NodeEvents.EventEmitter;
    let input = "";
    let spawned!: () => void;
    const ready = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    vi.mocked(NodeChildProcess.spawn).mockImplementation((_command, args) => {
      child = new NodeEvents.EventEmitter();
      Object.assign(child, { stderr: new NodeEvents.EventEmitter() });
      const argv = args as string[];
      input = argv[argv.indexOf("--file") + 1]!;
      spawned();
      return child as NodeChildProcess.ChildProcess;
    });
    const result = runWhisper(settings, audio(), controller.signal);
    const rejection = expect(result).rejects.toThrow("cancelled");
    await ready;
    controller.abort();
    child!.emit("error", new Error("aborted"));
    await NodeFSP.access(input);
    child!.emit("close", null);
    await rejection;
    await expect(NodeFSP.access(NodePath.dirname(input))).rejects.toThrow();
  });
  it("reports a native launch failure and rejects an already cancelled request without spawning", async () => {
    vi.mocked(NodeChildProcess.spawn).mockImplementation(() => {
      const child = new NodeEvents.EventEmitter();
      Object.assign(child, { stderr: new NodeEvents.EventEmitter() });
      queueMicrotask(() => {
        child.emit("error", new Error("ENOENT"));
        child.emit("close", -1);
      });
      return child as NodeChildProcess.ChildProcess;
    });
    await expect(runWhisper(settings, audio(), new AbortController().signal)).rejects.toThrow(
      "Could not start Whisper",
    );
    const controller = new AbortController();
    controller.abort();
    vi.clearAllMocks();
    await expect(runWhisper(settings, audio(), controller.signal)).rejects.toThrow();
    expect(NodeChildProcess.spawn).not.toHaveBeenCalled();
  });
});
