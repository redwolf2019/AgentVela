#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- CLI entrypoint reads process argv/env via node:process.
import * as NodeProcess from "node:process";

import { runRelayCli } from "./cli.ts";

runRelayCli(NodeProcess.argv.slice(2), NodeProcess.env, NodeProcess.cwd()).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  NodeProcess.stderr.write(`agent-vela-relay: ${message}\n`, () => {
    NodeProcess.exit(1);
  });
});
