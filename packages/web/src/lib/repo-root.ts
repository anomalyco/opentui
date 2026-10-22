import { basename, dirname, join } from "node:path"

const WORKING_DIRECTORY = process.cwd()

/** Repository root, for scripts and builds started in the repository root or in packages/web. */
export const REPO_ROOT =
  basename(WORKING_DIRECTORY) === "web" && basename(dirname(WORKING_DIRECTORY)) === "packages"
    ? join(WORKING_DIRECTORY, "../..")
    : WORKING_DIRECTORY
