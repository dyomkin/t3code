// @effect-diagnostics nodeBuiltinImport:off -- The Windows power command is a native process boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { IdleShutdownError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

export class ComputerPower extends Context.Service<
  ComputerPower,
  {
    readonly available: boolean;
    readonly shutdown: Effect.Effect<void, IdleShutdownError>;
  }
>()("t3/process/ComputerPower") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const available = platform === "win32" && config.mode === "desktop";
  return ComputerPower.of({
    available,
    shutdown: available
      ? Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              // /t 0 does not imply /f: Windows can protect unsaved documents.
              NodeChildProcess.execFile(
                NodePath.join(environment.SystemRoot ?? "C:\\Windows", "System32", "shutdown.exe"),
                ["/s", "/t", "0"],
                { windowsHide: true },
                (error) => (error ? reject(error) : resolve()),
              );
            }),
          catch: (cause) => new IdleShutdownError({ operation: "shutdown", cause }),
        })
      : Effect.fail(new IdleShutdownError({ operation: "unsupported" })),
  });
});
export const layer = Layer.effect(ComputerPower, make);
