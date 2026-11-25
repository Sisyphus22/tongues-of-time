// Builds the GitHub Pages website into ./docs from tongues-of-time.html (and img/, media/ if present).
// Run from the project root:  node tools/build-site.js <download-url>
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs");
const download = process.argv[2] || "";
if (download && !/^https:\/\//.test(download)) throw new Error("Download URL must start with https://");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "img"), { recursive: true });

const page = fs.readFileSync(path.join(ROOT, "tongues-of-time.html"), "utf8");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Turn modern words into Old Hungarian, Old English, Sumerian, Egyptian, Latin and more, and hear how they may have sounded.">
<link rel="icon" href="img/icon.png">
<style>:root{color-scheme:dark;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
<script>window.APP_SITE = ${JSON.stringify({ download })};</script>
<script src="web-backend.js"></script>
<script src="app-shim.js"></script>
</head><body>
${page}
</body></html>
`;
fs.writeFileSync(path.join(OUT, "index.html"), html);
fs.copyFileSync(path.join(ROOT, "tools", "web-backend.js"), path.join(OUT, "web-backend.js"));
fs.copyFileSync(path.join(ROOT, "desktop", "app-src", "app-shim.js"), path.join(OUT, "app-shim.js"));
for (const dir of ["img", "media"]) {
  const src = path.join(ROOT, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(OUT, dir), { recursive: true });
}
fs.copyFileSync(path.join(ROOT, "desktop", "build", "icon.png"), path.join(OUT, "img", "icon.png"));
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
console.log("Built docs/ (download link: " + (download || "none") + ")");
