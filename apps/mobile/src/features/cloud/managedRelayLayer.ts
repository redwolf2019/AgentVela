import {
  AgentVelaRelay,
  DpopProof,
  ManagedRelayBridge,
  RelayConfig,
  RelaySession,
} from "@t3tools/client-runtime/relay";
import * as Layer from "effect/Layer";

import { loadOrCreateProofKey } from "./dpop";
import { layerMobileRelayConfigStorage, layerMobileRelaySessionStore } from "./relayStorage";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "expo-secure-store",
  loadOrCreateKey: loadOrCreateProofKey(),
});

export function makeLayer(defaultRelayUrl: string | null = null) {
  const layerRelayConfig = RelayConfig.layerRelayUrlConfig({
    defaultRelayUrl,
  }).pipe(Layer.provide(layerMobileRelayConfigStorage));

  const layerRelaySession = RelaySession.layerRelayAuthSession.pipe(
    Layer.provideMerge(layerRelayConfig),
    Layer.provide(layerMobileRelaySessionStore),
  );

  const layerRelayClient = AgentVelaRelay.layerAgentVelaRelayClient({
    clientSurface: "mobile",
  }).pipe(Layer.provideMerge(layerRelaySession), Layer.provideMerge(layerRelayDpopSigner));

  return Layer.mergeAll(
    ManagedRelayBridge.layerManagedRelayBridge,
    RelaySession.layerCloudSessionFromRelayAuth,
  ).pipe(Layer.provideMerge(layerRelayClient));
}
