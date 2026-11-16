import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Resolve from this script so npm's working directory cannot change the target.
const output = fileURLToPath(new URL("../dist/", import.meta.url));
await rm(output, { recursive: true, force: true });
