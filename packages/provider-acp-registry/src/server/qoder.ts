import { ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { QoderSettings } from "../qoderSettings.ts";
import { makeAcpRegistryDriver } from "./driver.ts";
import { makeAcpRegistryAdapterV2Driver } from "./adapter.ts";

const decodeSettings = Schema.decodeSync(QoderSettings);
const driverKind = ProviderDriverKind.make("qoder");

export const QoderAdapterV2Driver = {
  ...makeAcpRegistryAdapterV2Driver(driverKind),
  configSchema: QoderSettings,
  defaultConfig: () => decodeSettings({}),
};

export const QoderDriver = makeAcpRegistryDriver({
  driverKind,
  metadata: {
    displayName: "Qoder",
    supportsMultipleInstances: true,
    hasDefaultInstance: true,
  },
  configSchema: QoderSettings,
  defaultConfig: () => decodeSettings({}),
});
