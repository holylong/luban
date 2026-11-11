import chalk from "chalk";
import { applyTerminalCapabilities } from "./terminal-capabilities.js";

/**
 * Runs before anything that decides on colors.
 *
 * chalk resolves its level when it is imported, and Ink is imported by the
 * workbench modules right after this one. Keeping the bootstrap in its own
 * module (imported first by the entry point) makes that ordering explicit
 * instead of a comment on an import list.
 *
 * The level is assigned directly rather than through `FORCE_COLOR`: chalk maps
 * every `FORCE_COLOR` value to 24-bit output, and a terminal that only knows
 * the 256-color cube draws `38;2;r;g;b` as plain text — which is how a styled
 * workbench turns monochrome over ssh.
 */
const capabilities = applyTerminalCapabilities();
chalk.level = capabilities.colorLevel;
