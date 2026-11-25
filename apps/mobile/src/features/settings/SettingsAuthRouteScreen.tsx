import { useGT } from "gt-react-native";

import { useSelfHostedRelaySession } from "../../state/relay";
import { RelayAuthForm } from "../cloud/RelayAuthForm";
import { T3ConnectProfilePage } from "../cloud/T3ConnectProfilePage";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsAuthRouteScreen() {
  const gt = useGT();
  const session = useSelfHostedRelaySession();

  return (
    <SettingsScreen title={gt("Relay")}>
      {session.status === "signed_in" ? <T3ConnectProfilePage /> : <RelayAuthForm />}
    </SettingsScreen>
  );
}
