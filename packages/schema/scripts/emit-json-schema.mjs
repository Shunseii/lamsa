import { writeFileSync } from "node:fs";
import { designFileJsonSchema } from "../dist/index.js";

writeFileSync(
  new URL("../dist/lamsa.schema.json", import.meta.url),
  JSON.stringify(designFileJsonSchema(), null, 2) + "\n",
);
