import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";

export type UpRoute = "lan";
export type UpRoutes = Readonly<Record<UpRoute, boolean>>;

export interface UpRelaySetup {
  readonly linked: boolean;
  readonly relayUrl: string | null;
  readonly endpointUrl: string | null;
}

/** How other devices reach this machine now. */
export interface UpSetup {
  readonly service: BootService.BootServiceStatus;
  readonly relay: UpRelaySetup;
  readonly lan: boolean;
  /** An installed service with no T3CODE_LAN or T3CODE_HOST keeps the old default: on. */
  readonly lanFromOldDefault: boolean;
  readonly host: string | undefined;
}

export interface UpHints {
  readonly run: string;
  readonly pair: string;
  readonly up: string;
  readonly upNoLan: string;
}

export const formatSetup = (setup: UpSetup, hints: UpHints): string => {
  const { service } = setup;
  if (service.otherBaseDir !== undefined) {
    return [
      `  ${"Service".padEnd(15)}installed for another T3 home · ${service.otherBaseDir}`,
      "",
      `Pass \`${BootService.formatBootServiceBaseDirOption(service.otherBaseDir)}\` to manage it.`,
    ].join("\n");
  }
  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      "Service",
      !service.supported
        ? "unavailable"
        : service.installed
          ? `installed · t3@${service.installedVersion ?? packageJson.version}`
          : "not installed",
    ],
    ...(setup.relay.linked
      ? [
          [
            "Relay",
            `on · ${setup.relay.endpointUrl ?? setup.relay.relayUrl ?? "self-hosted"}`,
          ] as const,
        ]
      : []),
    [
      "Local network",
      setup.host !== undefined
        ? `overridden · T3CODE_HOST=${setup.host}`
        : setup.lanFromOldDefault
          ? "on · kept from an older install"
          : setup.lan
            ? "on · pairing code only"
            : "off",
    ],
  ];
  const notes = [
    ...(setup.host === undefined && setup.lan
      ? ["Anyone on your LAN or tailnet can reach the port. A pairing code is the only lock."]
      : []),
    ...(setup.lanFromOldDefault
      ? [`Older installs keep LAN access on. Turn it off: \`${hints.upNoLan}\`.`]
      : []),
  ];
  return [
    ...rows.map(([label, value]) => `  ${label.padEnd(15)}${value}`),
    ...(notes.length === 0 ? [] : ["", ...notes]),
  ].join("\n");
};

export const formatNextSteps = (
  routes: UpRoutes,
  relayLinked: boolean,
  serviceInstalled: boolean,
  hints: UpHints,
): string =>
  [
    ...(relayLinked
      ? ["Open your self-hosted relay web UI on another device to access this machine."]
      : []),
    ...(routes.lan ? [`Run \`${hints.pair}\`. Use the code on your other device.`] : []),
    ...(routes.lan || relayLinked
      ? []
      : [
          serviceInstalled
            ? "Remote access is off. T3 Code still runs here in the background."
            : `Remote access is off. Run \`${hints.run}\` to use T3 Code here.`,
        ]),
  ].join("\n");

/** `t3 status --json`, for scripts and agents. */
export const setupJson = (setup: UpSetup): string =>
  JSON.stringify(
    {
      service: {
        supported: setup.service.supported,
        installed: setup.service.installed,
        installedVersion: setup.service.installedVersion ?? null,
        otherBaseDir: setup.service.otherBaseDir ?? null,
      },
      relay: setup.relay,
      lan: {
        enabled: setup.lan,
        inheritedDefault: setup.lanFromOldDefault,
        hostOverride: setup.host ?? null,
      },
    },
    null,
    2,
  );
