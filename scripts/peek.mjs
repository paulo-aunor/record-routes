import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
import fs from "fs/promises";
const buf = await fs.readFile(process.argv[2]);
const { text } = await pdf(buf);
console.log(text);
