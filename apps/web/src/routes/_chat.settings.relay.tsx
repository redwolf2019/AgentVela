import { createFileRoute } from "@tanstack/react-router";

import { RelaySettingsPage } from "../components/relay/RelaySettingsPage";

export const Route = createFileRoute("/_chat/settings/relay")({
  component: RelaySettingsPage,
});
