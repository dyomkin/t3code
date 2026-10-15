import { useAtomValue } from "@effect/atom-react";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type EnvironmentId,
  type IdleShutdownStatus,
} from "@t3tools/contracts";
import { PowerIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The local host owns this one-shot intent; changing chats never arms it again. */
export function IdleShutdownControl({ environmentId }: { environmentId: EnvironmentId }) {
  const local = !!window.desktopBridge && environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID;
  const [status, setStatus] = useState<IdleShutdownStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);
  const allowed = useAtomValue(serverEnvironment.setIdleShutdown.permissionAtom(environmentId));
  const read = useAtomQueryRunner(serverEnvironment.idleShutdown, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const change = useAtomCommand(serverEnvironment.setIdleShutdown);
  useEffect(() => {
    if (!local) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const result = await read({ environmentId, input: {} });
      if (disposed) return;
      if (result._tag === "Success") {
        setStatus(result.value);
        setNow(Date.now());
      }
      timer = setTimeout(
        () => void refresh(),
        result._tag === "Success" && result.value.enabled ? 1_000 : 5_000,
      );
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [environmentId, local, read]);
  if (!local || !status?.available) return null;
  const seconds =
    status.deadline === null ? null : Math.max(0, Math.ceil((status.deadline - now) / 1000));
  const countdown =
    seconds === null
      ? null
      : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const label = status.enabled ? "Cancel automatic shutdown" : "Shut down after all tasks finish";
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={status.enabled ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={label}
              aria-pressed={status.enabled}
              disabled={!allowed || busy}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setBusy(true);
                void change({ environmentId, input: { enabled: !status.enabled } })
                  .then((result) => {
                    if (result._tag === "Success") setStatus(result.value);
                  })
                  .finally(() => setBusy(false));
              }}
            />
          }
        >
          <PowerIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {status.detail ??
            "Shut down this computer after all tasks in the local environment finish. Off by default; one session only."}
          {status.enabled ? " Click to cancel." : ""}
        </TooltipPopup>
      </Tooltip>
      {countdown ? (
        <span className="text-xs tabular-nums text-muted-foreground" role="status">
          {countdown}
        </span>
      ) : null}
      {status.phase === "error" ? (
        <span className="text-xs text-destructive" role="status">
          Cancelled
        </span>
      ) : null}
    </div>
  );
}
