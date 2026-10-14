import { LOCAL_DICTATION_MAX_SECONDS } from "@t3tools/contracts";
import { encodeDictationWav } from "@t3tools/client-runtime/voice-input/wav";

export async function recordingToWavBase64(blob: Blob): Promise<string> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await context.close();
  }
  if (decoded.duration > LOCAL_DICTATION_MAX_SECONDS + 1) throw new Error("Recording is too long.");
  const frames = Math.min(
    Math.ceil(decoded.duration * 16_000),
    LOCAL_DICTATION_MAX_SECONDS * 16_000,
  );
  const offline = new OfflineAudioContext(1, frames, 16_000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const mono = (await offline.startRendering()).getChannelData(0);
  const bytes = new Uint8Array(encodeDictationWav(mono));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
