// Renders banner.html to docs/banner.png at 2x:
//   apps/desktop/node_modules/electron/dist/electron docs/banner/render.cjs banner.html ../banner.png
const { app, BrowserWindow } = require("electron");
const path = require("path");
app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 640, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, process.argv.at(-2)));
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => Promise.all([...document.images].map(i => i.decode())))");
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  require("fs").writeFileSync(process.argv.at(-1), img.toPNG());
  console.log(img.getSize());
  app.quit();
});
