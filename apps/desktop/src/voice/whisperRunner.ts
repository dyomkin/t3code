// @effect-diagnostics nodeBuiltinImport:off -- whisper.cpp is a native executable with temporary WAV input and cooperative subprocess cancellation.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { LOCAL_DICTATION_MAX_WAV_BYTES, type LocalDictationSettings } from "@t3tools/contracts";

/** Accept only the bounded PCM format produced by the microphone recorder. */
export function decodeDictationWav(base64: string): Buffer {
  if (base64.length > Math.ceil(LOCAL_DICTATION_MAX_WAV_BYTES / 3) * 4) {
    throw new Error("Invalid dictation audio.");
  }
  const wav = Buffer.from(base64, "base64");
  if (wav.toString("base64") !== base64) throw new Error("Invalid dictation audio.");
  if (
    wav.length <= 44 ||
    wav.length > LOCAL_DICTATION_MAX_WAV_BYTES ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE" ||
    wav.toString("ascii", 12, 16) !== "fmt " ||
    wav.readUInt32LE(16) !== 16 ||
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(22) !== 1 ||
    wav.readUInt32LE(24) !== 16000 ||
    wav.readUInt32LE(28) !== 32000 ||
    wav.readUInt16LE(32) !== 2 ||
    wav.readUInt16LE(34) !== 16 ||
    wav.toString("ascii", 36, 40) !== "data" ||
    wav.readUInt32LE(40) !== wav.length - 44 ||
    wav.readUInt32LE(4) !== wav.length - 8 ||
    (wav.length - 44) % 2 !== 0
  )
    throw new Error("Dictation requires mono 16 kHz PCM audio, up to two minutes.");
  return wav;
}

export function whisperArguments(settings: LocalDictationSettings, input: string, output: string) {
  return [
    "--model",
    settings.modelPath,
    "--file",
    input,
    "--language",
    settings.language,
    "--prompt",
    settings.prompt,
    "--output-txt",
    "--output-file",
    output,
    "--no-timestamps",
    "--threads",
    "6",
  ];
}

export async function runWhisper(
  settings: LocalDictationSettings,
  wav: Buffer,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dictation-"));
  try {
    const input = NodePath.join(temp, "recording.wav");
    const output = NodePath.join(temp, "transcript");
    await NodeFSP.writeFile(input, wav);
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        settings.binaryPath,
        whisperArguments(settings, input, output),
        {
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
          signal,
        },
      );
      let stderr = "";
      let failure: Error | undefined;
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-4096);
      });
      // Abort emits error before close. Wait for close before deleting input files.
      child.on("error", (error) => {
        failure = error;
      });
      child.on("close", (code) => {
        if (signal.aborted) reject(new Error("Dictation cancelled."));
        else if (failure) reject(new Error(`Could not start Whisper: ${failure.message}`));
        else if (code !== 0) reject(new Error(`Whisper failed (${code}): ${stderr.trim()}`));
        else resolve();
      });
    });
    signal.throwIfAborted();
    return (await NodeFSP.readFile(`${output}.txt`, "utf8")).trim();
  } finally {
    // Only this invocation's freshly allocated temporary directory is removed.
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
}
