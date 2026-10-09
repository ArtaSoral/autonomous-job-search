import { sqlite } from "../src/lib/db";
import { loadInputs } from "../src/lib/bank";
sqlite();
const { bank, bankVersion, specVersion } = loadInputs();
console.log(
  `Database ready; bank ${bankVersion}, spec ${specVersion}; ${bank.bullets.filter((b) => b.usable_in_generation).length} usable bullets.`,
);
