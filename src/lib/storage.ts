import { join } from "node:path";
// Tests set an isolated output root; normal app processes use private data/.
export const artifactDirectory = (kind: "documents" | "exports") =>
  join(
    /* turbopackIgnore: true */ process.env.TEST_ARTIFACT_DIR || "data",
    kind,
  );
