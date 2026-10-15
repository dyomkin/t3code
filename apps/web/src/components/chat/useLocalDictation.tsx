import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon, MicIcon, SquareIcon, XIcon } from "lucide-react";
import {
  LOCAL_DICTATION_MAX_SECONDS,
  localDictationModelSize,
  type LocalDictationStatus,
} from "@t3tools/contracts";
import { recordingToWavBase64 } from "../../lib/dictationAudio";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroupLabel,
  MenuGroup,
} from "../ui/menu";

type Recording = {
  id: string;
  target: string;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: ReturnType<typeof setTimeout>;
};
function releaseRecording(recording: Recording) {
  clearTimeout(recording.timer);
  if (recording.recorder?.state === "recording") recording.recorder.stop();
  recording.stream?.getTracks().forEach((track) => track.stop());
}

export function useLocalDictation(
  target: string,
  disabled: boolean,
  insert: (text: string) => boolean,
) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [phase, setPhase] = useState<"idle" | "preparing" | "recording" | "transcribing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<LocalDictationStatus | null>(null);
  const [changingModel, setChangingModel] = useState(false);
  const refreshModel = () =>
    bridge
      ?.getLocalDictationStatus?.()
      .then(setModelStatus)
      .catch(() => {});
  const model = modelStatus ? localDictationModelSize(modelStatus.settings.modelPath) : null;
  useEffect(() => {
    let disposed = false;
    void bridge
      ?.getLocalDictationStatus?.()
      .then((status) => {
        if (!disposed) setModelStatus(status);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [bridge, target]);
  const active = useRef<Recording | null>(null);
  const insertRef = useRef({ target, insert });
  useLayoutEffect(() => {
    insertRef.current = { target, insert };
  }, [insert, target]);
  const cancel = () => {
    const recording = active.current;
    active.current = null;
    if (recording) {
      releaseRecording(recording);
      void bridge?.cancelLocalDictation?.(recording.id).catch(() => {});
    }
    setPhase("idle");
  };
  useEffect(() => {
    // Switching drafts cancels the external microphone/transcription session.
    setError(null);
    setPhase("idle");
    return () => {
      const recording = active.current;
      if (recording?.target !== target) return;
      active.current = null;
      if (recording) {
        releaseRecording(recording);
        void window.desktopBridge?.cancelLocalDictation?.(recording.id).catch(() => {});
      }
    };
  }, [target]);

  const start = async () => {
    if (
      !bridge?.getLocalDictationStatus ||
      !bridge.transcribeLocalDictation ||
      active.current ||
      disabled
    )
      return;
    const recording: Recording = { id: randomUUID(), target };
    active.current = recording;
    setError(null);
    setPhase("preparing");
    try {
      const status = await bridge.getLocalDictationStatus();
      if (active.current !== recording) return;
      if (!status.available)
        throw new Error("Set up local dictation in Settings → General → Local dictation.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (active.current !== recording) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      recording.stream = stream;
      const recorder = new MediaRecorder(stream);
      recording.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (active.current === recording) {
          cancel();
          setError("Microphone recording failed. Try again.");
        }
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        clearTimeout(recording.timer);
        if (active.current !== recording) return;
        setPhase("transcribing");
        void (async () => {
          try {
            const wavBase64 = await recordingToWavBase64(
              new Blob(chunks, { type: recorder.mimeType }),
            );
            if (active.current !== recording) return;
            const text = await bridge.transcribeLocalDictation!({
              requestId: recording.id,
              wavBase64,
            });
            if (active.current !== recording) return;
            if (!text)
              throw new Error("No speech recognized. Try speaking closer to the microphone.");
            if (insertRef.current.target !== recording.target) return;
            if (!insertRef.current.insert(text))
              throw new Error(`Could not insert dictation. Recognized text: ${text}`);
          } catch (cause) {
            if (active.current === recording)
              setError(cause instanceof Error ? cause.message : "Dictation failed.");
          } finally {
            if (active.current === recording) {
              active.current = null;
              setPhase("idle");
            }
          }
        })();
      };
      recorder.start();
      setPhase("recording");
      recording.timer = setTimeout(
        () => releaseRecording(recording),
        LOCAL_DICTATION_MAX_SECONDS * 1000,
      );
    } catch (cause) {
      if (active.current !== recording) return;
      active.current = null;
      releaseRecording(recording);
      setPhase("idle");
      setError(cause instanceof Error ? cause.message : "Could not access the microphone.");
    }
  };
  const label =
    phase === "recording"
      ? "Stop dictation"
      : phase === "transcribing"
        ? "Whisper is transcribing…"
        : phase === "preparing"
          ? "Preparing microphone…"
          : "Dictate with local Whisper";
  const control = bridge?.transcribeLocalDictation ? (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant={phase === "recording" ? "destructive" : "ghost"}
              aria-label={label}
              aria-pressed={phase === "recording"}
              disabled={
                (disabled && phase === "idle") || phase === "preparing" || phase === "transcribing"
              }
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (phase === "recording" && active.current) releaseRecording(active.current);
                else void start();
              }}
            />
          }
        >
          {phase === "recording" ? <SquareIcon /> : <MicIcon />}
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      {bridge.setLocalDictationModel ? (
        <Menu
          onOpenChange={(open) => {
            if (open) void refreshModel();
          }}
        >
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Whisper model: ${model ?? "loading"}`}
                disabled={phase !== "idle" || changingModel}
                onPointerDown={(event) => event.preventDefault()}
              />
            }
          >
            {model === "small" ? "Small" : model === "medium" ? "Medium" : "Whisper"}
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup side="bottom" align="end">
            <MenuGroup>
              <MenuGroupLabel>Local Whisper model</MenuGroupLabel>
              <MenuRadioGroup
                value={model ?? ""}
                onValueChange={(size) => {
                  if (size !== "small" && size !== "medium") return;
                  setChangingModel(true);
                  setError(null);
                  void bridge.setLocalDictationModel!(size)
                    .then(setModelStatus)
                    .catch((cause) =>
                      setError(
                        cause instanceof Error ? cause.message : "Could not change Whisper model.",
                      ),
                    )
                    .finally(() => setChangingModel(false));
                }}
              >
                <MenuRadioItem value="small">Small — faster</MenuRadioItem>
                <MenuRadioItem value="medium">Medium — more accurate</MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
          </MenuPopup>
        </Menu>
      ) : null}
      {phase !== "idle" ? (
        <>
          <span className="text-xs text-muted-foreground" role="status">
            {phase === "recording"
              ? "Recording"
              : phase === "transcribing"
                ? "Transcribing…"
                : "Preparing…"}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Cancel dictation"
            onClick={cancel}
          >
            <XIcon />
          </Button>
        </>
      ) : null}
    </div>
  ) : null;
  return { control, error, busy: phase !== "idle", active, dismissError: () => setError(null) };
}
