import { loadInputs } from "./bank";
import { exec, now, uid, transaction } from "./db";
export function registeredInputs() {
  const i = loadInputs();
  transaction(() => {
    for (const [kind, version, hash, content] of [
      ["bank", i.bankVersion, i.bankHash, i.bankText],
      ["spec", i.specVersion, i.specHash, i.spec],
    ])
      exec(
        "INSERT OR IGNORE INTO input_versions(id,kind,version,sha256,loaded_at,content) VALUES(?,?,?,?,?,?)",
        uid(),
        kind,
        version,
        hash,
        now(),
        content,
      );
    exec(
      "UPDATE evaluations SET is_current=0 WHERE bank_hash<>? OR spec_hash<>?",
      i.bankHash,
      i.specHash,
    );
  });
  return i;
}
