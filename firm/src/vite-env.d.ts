/// <reference types="vite/client" />

/**
 * Build-time flags for the Firm OS bundle.
 *
 * Declared rather than left to `any` so a typo in a flag name is a type error at
 * the call site instead of a silently-undefined value that disables a feature.
 */
interface ImportMetaEnv {
  /**
   * Renders the synthetic demo-account list on the sign-in screen.
   *
   * WHY THIS IS A FLAG AND NOT `import.meta.env.DEV`
   *   Vite sets `DEV` from the COMMAND, not the mode: `vite build` always yields
   *   `DEV === false`, even under `--mode development`. Gating the demo list on
   *   DEV therefore strips it from every build, including the demo deployment
   *   this repo is meant to be previewed from — leaving a sign-in screen with no
   *   visible way to obtain credentials.
   *
   *   An explicit flag makes the choice deliberate and inspectable: the preview
   *   build sets it, a production build does not, and the difference is visible in
   *   the build command rather than hidden in Vite's semantics.
   *
   * WHAT IT EXPOSES, AND WHY THAT IS ACCEPTABLE HERE
   *   Synthetic emails and a synthetic password for accounts that exist only in
   *   the demo seed. Both are already committed in server/src/db/demo-data.ts and
   *   printed to the server console on seed, so the bundle adds no disclosure.
   *   With the flag unset, Rollup removes the block entirely and no credential
   *   string appears in the output.
   */
  readonly VITE_SHOW_DEMO_ACCOUNTS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
