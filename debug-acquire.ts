import { acquireSource } from "./src/lib/io.ts";
const r = await acquireSource("smoke-src", "/tmp/smoke-src");
await Bun.write("./acq.txt", JSON.stringify(r));
