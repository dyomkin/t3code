import {
  AcpRegistryOperationError,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { QoderSettings } from "../qoderSettings.ts";
import { buildCheckedAcpRegistrySnapshot } from "./driver.ts";
import { QoderDriver } from "./qoder.ts";

const decodeSettings = Schema.decodeUnknownSync(QoderSettings);
const identity = {
  driverKind: ProviderDriverKind.make("qoder"),
  instanceId: ProviderInstanceId.make("qoder_work"),
  displayName: "Qoder Work",
  accentColor: undefined,
  continuationKey: "qoder:instance:qoder_work",
};

describe("Qoder provider", () => {
  it("launches local ACP by default and preserves an executable override", () => {
    expect(QoderDriver.defaultConfig()).toMatchObject({
      source: "local",
      commandPath: "qodercli",
      commandArgs: ["--acp"],
      enabled: true,
    });
    expect(decodeSettings({ commandPath: "C:/Tools/qodercli.exe" }).commandPath).toBe(
      "C:/Tools/qodercli.exe",
    );
    expect(() => decodeSettings({ source: "registry" })).toThrow();
  });

  it("keeps Qoder routing identity when publishing a ready local snapshot", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({}),
      checkedAt: "2026-10-14T18:00:00.000Z",
      inspection: { status: "ready", agentId: "qodercli", version: null, distribution: "local" },
    });
    expect(snapshot).toMatchObject({
      driver: "qoder",
      instanceId: "qoder_work",
      displayName: "Qoder Work",
      continuation: { groupKey: identity.continuationKey },
      installed: true,
      status: "ready",
      supportsTextGeneration: false,
    });
  });

  it("reports CLI login requirements without treating the binary as missing", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({}),
      checkedAt: "2026-10-14T18:00:00.000Z",
      inspection: { status: "ready", agentId: "qodercli", version: null, distribution: "local" },
      probeError: new AcpRegistryOperationError({
        reason: "authentication_failed",
        message: "Authentication required",
        authMethods: [
          { id: "qodercli-login", name: "Use qodercli login", description: null, type: "agent" },
        ],
      }),
    });
    expect(snapshot).toMatchObject({
      driver: "qoder",
      installed: true,
      status: "warning",
      auth: { status: "unauthenticated", label: "Use qodercli login" },
    });
  });
});
