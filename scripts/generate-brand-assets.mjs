import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "public/favicon.svg");
const svg = await readFile(sourcePath, "utf8");
const foregroundSvg = svg.replace(/<rect\b[^>]*\/>/i, "");
const browser = await chromium.launch({ channel: "chrome", headless: true });

async function render(path, width, height, { foreground = false, splash = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const artwork = foreground ? foregroundSvg : svg;
  const logoSize = splash ? Math.round(Math.min(width, height) * 0.25) : foreground ? Math.round(Math.min(width, height) * 0.62) : Math.min(width, height);
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{display:grid;place-items:center;background:${splash ? "radial-gradient(circle at 50% 42%,#173c5d 0,#0b263d 42%,#061722 100%)" : "transparent"}}
    body::after{content:"";position:absolute;left:-10%;right:-10%;bottom:${splash ? "12%" : "-100%"};height:18%;opacity:.32;background:repeating-radial-gradient(ellipse at 50% 100%,transparent 0 22px,#6ca6a2 23px 25px,transparent 26px 44px)}
    #brand{position:relative;width:${logoSize}px;height:${logoSize}px;filter:${splash ? "drop-shadow(0 18px 32px rgba(0,0,0,.25))" : "none"}}
    svg{display:block;width:100%;height:100%}
  </style><div id="brand">${artwork}</div>`);
  await page.screenshot({ path, omitBackground: !splash });
  await page.close();
}

const densities = [["mdpi",48,108],["hdpi",72,162],["xhdpi",96,216],["xxhdpi",144,324],["xxxhdpi",192,432]];
for (const [density, iconSize, foregroundSize] of densities) {
  const folder = resolve(root, `android/app/src/main/res/mipmap-${density}`);
  await render(resolve(folder, "ic_launcher.png"), iconSize, iconSize);
  await render(resolve(folder, "ic_launcher_round.png"), iconSize, iconSize);
  await render(resolve(folder, "ic_launcher_foreground.png"), foregroundSize, foregroundSize, { foreground: true });
}

const splashes = [["drawable",480,320],["drawable-land-mdpi",480,320],["drawable-land-hdpi",800,480],["drawable-land-xhdpi",1280,720],["drawable-land-xxhdpi",1600,960],["drawable-land-xxxhdpi",1920,1280],["drawable-port-mdpi",320,480],["drawable-port-hdpi",480,800],["drawable-port-xhdpi",720,1280],["drawable-port-xxhdpi",960,1600],["drawable-port-xxxhdpi",1280,1920]];
for (const [folder, width, height] of splashes) await render(resolve(root, `android/app/src/main/res/${folder}/splash.png`), width, height, { splash: true });

await browser.close();
console.log(JSON.stringify({ source: sourcePath, icons: densities.length * 3, splashes: splashes.length }));

