/**
 * Example: serve a SolidJS (@opentui/solid) app over SSH.
 *
 *   bun run packages/ssh/examples/solid.tsx
 *
 *   ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
 *       guest@localhost
 *
 * Solid JSX needs a Bun transform plugin. Register it before dynamically
 * loading the JSX implementation so this example works without CLI preloads.
 */
import "@opentui/solid/preload"

await import("./solid-app.js")
