import { TrimmedString, makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "./settings.ts";

/** Qoder uses the local ACP transport and the user's existing CLI credentials. */
export const QoderSettings = makeProviderSettingsSchema(
  {
    ...AcpRegistrySettings.fields,
    source: Schema.Literal("local").pipe(
      Schema.withDecodingDefault(Effect.succeed("local")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    agentId: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    commandPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("qodercli")),
      Schema.annotateKey({
        title: "Qoder CLI executable",
        description: "Install Qoder CLI and run qodercli login before starting a thread.",
        providerSettingsForm: { placeholder: "qodercli", clearWhenEmpty: "omit" },
      }),
    ),
    commandArgs: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed(["--acp"])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["commandPath", "authMethodId"] },
);
