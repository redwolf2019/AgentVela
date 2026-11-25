import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

export type RelayAuthDialogMode = "signin" | "register";

export interface RelayAuthDialogState {
  readonly open: boolean;
  readonly initialMode: RelayAuthDialogMode;
  readonly onAuthenticated: (() => void) | undefined;
}

const INITIAL_DIALOG_STATE: RelayAuthDialogState = {
  open: false,
  initialMode: "signin",
  onAuthenticated: undefined,
};

export const relayAuthDialogAtom = Atom.make<RelayAuthDialogState>(INITIAL_DIALOG_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("relay:auth-dialog"),
);

export function openRelayAuthDialog(options?: {
  readonly initialMode?: RelayAuthDialogMode;
  readonly onAuthenticated?: () => void;
}): void {
  appAtomRegistry.set(relayAuthDialogAtom, {
    open: true,
    initialMode: options?.initialMode ?? "signin",
    onAuthenticated: options?.onAuthenticated,
  });
}

export function closeRelayAuthDialog(): void {
  appAtomRegistry.set(relayAuthDialogAtom, INITIAL_DIALOG_STATE);
}
