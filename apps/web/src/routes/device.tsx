import { createFileRoute } from "@tanstack/react-router";

import { RelayDeviceAuthPage } from "../components/relay/RelayDeviceAuthPage";

export const Route = createFileRoute("/device")({
  component: RelayDeviceAuthPage,
});
