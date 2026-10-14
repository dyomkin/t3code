import { useEffect, useState } from "react";
import {
  localDictationModelPath,
  localDictationModelSize,
  type LocalDictationStatus,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function LocalDictationSettings() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [status, setStatus] = useState<LocalDictationStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let disposed = false;
    void bridge
      ?.getLocalDictationStatus?.()
      .then((value) => {
        if (!disposed) setStatus(value);
      })
      .catch((cause) => {
        if (!disposed) setMessage(String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [bridge]);
  if (!bridge?.getLocalDictationStatus) return null;
  const save = async () => {
    if (!status || !bridge.setLocalDictationSettings) return;
    setSaving(true);
    setMessage(null);
    try {
      await bridge.setLocalDictationSettings(status.settings);
      setStatus(await bridge.getLocalDictationStatus!());
      setMessage("Saved.");
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection id="local-dictation" title="Local dictation">
      <SettingsRow
        title="Whisper"
        description="Use the microphone beside Send to dictate into the draft. Audio stays on this computer, including when the chat uses a remote environment."
        control={
          <span className="text-sm text-muted-foreground">
            {status?.available ? "Ready" : "Setup required"}
          </span>
        }
      />
      {status ? (
        <>
          <SettingsRow
            title="Whisper executable"
            control={
              <div className="w-full sm:w-96">
                <Input
                  aria-label="Whisper executable"
                  size="sm"
                  value={status.settings.binaryPath}
                  onChange={(event) =>
                    setStatus({
                      ...status,
                      settings: { ...status.settings, binaryPath: event.target.value },
                    })
                  }
                />
              </div>
            }
          />
          <SettingsRow
            title="Model size"
            description="Small prioritizes speed; medium prioritizes accuracy. Both are multilingual. Models must be installed in the same folder. Click Save to apply the choice to the next dictation."
            control={
              <Select
                value={localDictationModelSize(status.settings.modelPath)}
                onValueChange={(size) => {
                  if (size === "small" || size === "medium")
                    setStatus({
                      ...status,
                      settings: {
                        ...status.settings,
                        modelPath: localDictationModelPath(status.settings.modelPath, size),
                      },
                    });
                }}
              >
                <SelectTrigger size="sm" aria-label="Whisper model size">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="small">Small</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  {localDictationModelSize(status.settings.modelPath) === "custom" ? (
                    <SelectItem value="custom" disabled>
                      Custom file
                    </SelectItem>
                  ) : null}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="Model file"
            description="Choose a multilingual ggml model, such as medium. English-only .en models do not recognize Russian."
            control={
              <div className="w-full sm:w-96">
                <Input
                  aria-label="Whisper model file"
                  size="sm"
                  value={status.settings.modelPath}
                  onChange={(event) =>
                    setStatus({
                      ...status,
                      settings: { ...status.settings, modelPath: event.target.value },
                    })
                  }
                />
              </div>
            }
          />
          <SettingsRow
            title="Dictation language"
            description="Russian fixes the language to ru and keeps English technical terms. Auto enables language detection."
            control={
              <Select
                value={status.settings.language}
                onValueChange={(language) => {
                  if (language === "ru" || language === "en" || language === "auto")
                    setStatus({ ...status, settings: { ...status.settings, language } });
                }}
              >
                <SelectTrigger size="sm" aria-label="Dictation language">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="ru">Russian</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="auto">Auto</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="Vocabulary hint"
            description="Words and example phrasing to help recognition; this does not guarantee exact spelling."
            control={
              <div className="w-full sm:w-96">
                <Input
                  aria-label="Dictation vocabulary hint"
                  size="sm"
                  value={status.settings.prompt}
                  onChange={(event) =>
                    setStatus({
                      ...status,
                      settings: { ...status.settings, prompt: event.target.value },
                    })
                  }
                />
              </div>
            }
          />
          <SettingsRow
            title="Save dictation settings"
            description={message ?? status.detail}
            control={
              <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            }
          />
        </>
      ) : (
        <p role="status">{message ?? "Loading…"}</p>
      )}
    </SettingsSection>
  );
}
