// Run the installed CLI in production by default. This module must load before
// React/Ink: React's development performance measures accumulate in Node.
// Preserve an explicitly selected development or test environment.
process.env.NODE_ENV ||= "production";

export {};
