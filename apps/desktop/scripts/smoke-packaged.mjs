// Launches a packaged build against a copy of the example project and checks what depends on the files
// shipped next to the bundle: design files and tokens load, icons resolve (lucide-static) and a PNG
// export works (playwright-core). The release workflow runs it before uploading installers.
//
//   node apps/desktop/scripts/smoke-packaged.mjs <path to the lamsa-desktop executable> [screenshot.png]
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const [executable, screenshot] = process.argv.slice(2);
if (!executable) {
  console.error("usage: smoke-packaged.mjs <lamsa-desktop executable> [screenshot.png]");
  process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CHECKOUT_SCREEN = "08JQi0tV";

const root = mkdtempSync(join(tmpdir(), "lamsa-packaged-"));
cpSync(join(repo, "examples/shadcn-app"), root, { recursive: true, filter: (path) => !/[\\/](node_modules|\.lamsa)([\\/]|$)/.test(path) });
spawnSync("git", ["init", "-q"], { cwd: root });
// Answers the first-open prompt: every design file open.
const designs = readdirSync(join(root, "designs")).filter((name) => name.endsWith(".lamsa.json"));
mkdirSync(join(root, ".lamsa"));
writeFileSync(join(root, ".lamsa/session.json"), JSON.stringify({ selection: [], open: designs.map((name) => `designs/${name}`) }));

const errors = [];
const app = await _electron.launch({
  executablePath: executable,
  // CI runners on Linux block Chromium's sandbox; this only launches a trusted local build.
  args: ["--root", root, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
  env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
});
const fail = async (message) => {
  console.error(`✗ ${message}`);
  if (errors.length) console.error(errors.join("\n"));
  await app.close();
  process.exit(1);
};
try {
  const win = await app.firstWindow();
  win.on("pageerror", (error) => errors.push(`page error: ${error.message}`));
  await win.locator(`[data-root-id="${CHECKOUT_SCREEN}"]`).waitFor({ timeout: 60_000 });

  const summary = await win.getByText(/design files ·/).first().innerText();
  if (!summary.startsWith(`${designs.length} design files`) || !/\d+ tokens/.test(summary)) await fail(`project didn't load: "${summary}"`);
  console.log(`✓ project: ${summary}`);

  const icons = await win.evaluate(() => window.lamsa.icons(["lock", "chevron-left"]));
  if (Object.keys(icons ?? {}).length !== 2) await fail(`icons missing: ${JSON.stringify(icons)}`);
  console.log("✓ icons");

  const [frame] = await win.evaluate((id) => window.lamsa.render([id], "light"), CHECKOUT_SCREEN);
  if (!frame || !existsSync(frame.path)) await fail(`export failed: ${JSON.stringify(frame)}`);
  console.log(`✓ export: ${frame.width}×${frame.height}`);

  if (screenshot) await win.screenshot({ path: screenshot });
  if (errors.length) await fail("errors in the page");
} catch (error) {
  await fail(error.message);
}
await app.close();
