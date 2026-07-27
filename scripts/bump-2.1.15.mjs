import fs from "node:fs";
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (p.name !== "@devcodex/opentelemetry") throw new Error(p.name);
p.version = "2.1.15";
p.publishConfig = { registry: "https://registry.npmjs.org/", access: "public" };
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
console.log("wrote", p.name, p.version);
