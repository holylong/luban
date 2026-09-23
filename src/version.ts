import { createRequire } from "node:module";

// Works from both src/ and dist/, and follows the installed package version.
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
