#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const app = join(dirname(fileURLToPath(import.meta.url)), "..");

const child = spawn(electron, [app, ...process.argv.slice(2)], { detached: true, stdio: "ignore" });
child.unref();
