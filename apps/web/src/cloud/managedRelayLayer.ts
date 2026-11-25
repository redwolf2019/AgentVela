import {
  AgentVelaRelay,
  DpopProof,
  ManagedRelayBridge,
  RelayConfig,
  RelaySession,
} from "@t3tools/client-runtime/relay";
import * as Layer from "effect/Layer";

import { isElectron } from "../env";
import { loadOrCreateProofKey } from "./dpop";
import { resolveDefaultRelayUrl } from "./publicConfig";
import { layerWebRelayConfigStorage, layerWebRelaySessionStore } from "./relayStorage";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "indexed-db",
  loadOrCreateKey: loadOrCreateProofKey(),
});

const layerRelayConfig = RelayConfig.layerRelayUrlConfig({
  defaultRelayUrl: resolveDefaultRelayUrl(),
}).pipe(Layer.provide(layerWebRelayConfigStorage));

const layerRelaySession = RelaySession.layerRelayAuthSession.pipe(
  Layer.provideMerge(layerRelayConfig),
  Layer.provide(layerWebRelaySessionStore),
);

const layerRelayClient = AgentVelaRelay.layerAgentVelaRelayClient({
  clientSurface: isElectron ? "desktop" : "web",
}).pipe(Layer.provideMerge(layerRelaySession), Layer.provideMerge(layerRelayDpopSigner));

export const layer = Layer.mergeAll(
  ManagedRelayBridge.layerManagedRelayBridge,
  RelaySession.layerCloudSessionFromRelayAuth,
).pipe(Layer.provideMerge(layerRelayClient));
