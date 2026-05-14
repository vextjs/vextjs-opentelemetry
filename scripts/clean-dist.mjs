#!/usr/bin/env node

import { rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const distDir = resolve(projectRoot, "dist");

rmSync(distDir, { recursive: true, force: true });
console.log(`🧹 [clean-dist] removed ${distDir}`);

