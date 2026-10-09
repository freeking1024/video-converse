import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");

const [html, css, javascript] = await Promise.all([
  readFile(path.join(projectDirectory, "index.html"), "utf8"),
  readFile(path.join(projectDirectory, "styles.css"), "utf8"),
  readFile(path.join(projectDirectory, "app.js"), "utf8"),
]);

const standalone = html
  .replace(
    '    <link rel="stylesheet" href="styles.css" />',
    `    <style>\n${css}\n    </style>`,
  )
  .replace(
    '    <script src="app.js"></script>',
    `    <script>\n${javascript.replaceAll("</script>", "<\\/script>")}\n    </script>`,
  );

if (standalone === html || standalone.includes('href="styles.css"') || standalone.includes('src="app.js"')) {
  throw new Error("未能生成单文件版本，请检查 index.html 中的资源引用。");
}

await writeFile(path.join(projectDirectory, "frameflow.html"), standalone, "utf8");
console.log("已生成 frameflow.html");
