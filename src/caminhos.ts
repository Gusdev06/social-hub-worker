import { fileURLToPath } from "node:url";

/** Os scripts python vivem ao lado do worker — versionados junto, não no ~/.claude. */
export const SCRIPTS = fileURLToPath(new URL("./scripts/", import.meta.url));
