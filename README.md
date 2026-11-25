# Tongues of Time

Turn modern words into the languages of the past, and hear how they may have sounded:
Old Hungarian, Old English, Chaucer, Old Norse, Latin, Ancient Greek, Old Church Slavonic,
Old Persian, Sumerian, Akkadian, Middle Egyptian, Coptic, Classical Quechua and Nahuatl,
Old Tupi, Old Japanese, Middle Chinese and more.

- **Open the website:** https://sisyphus22.github.io/tongues-of-time/
- **Download for Windows, Mac or Linux:** https://github.com/Sisyphus22/tongues-of-time/releases/latest

© 2026 Valeria · All rights reserved · Made with Claude. See [LICENSE](LICENSE).

## How it works

Type in any modern language, pick a language and an age, and press **Turn back time**.
Claude writes your words in that stage of the language, with a sound-it-out guide (for English or
Hungarian speakers), IPA, a word-by-word list and notes on what is certain. It then reads the
result aloud.

Translating uses each person's own Anthropic API key (**Connect Claude**, top right). It is
pay-per-use with no subscription, and the key is only sent to Anthropic.

Reading aloud uses your device's built-in voices. For the best sound, add the matching voice in
your system settings, for example a Hungarian voice on Windows: **Settings → Time & language →
Speech → Add voices**.

## About this project folder

- `tongues-of-time.html` – the page, shared by the website, the desktop app and the claude.ai version
- `desktop/` – the desktop app (Electron); `tools/` – the website build and its Claude backend
- `docs/` – the built website served by GitHub Pages

Build the website: `node tools/build-site.js https://github.com/Sisyphus22/tongues-of-time/releases/latest`

Desktop app (needs Node.js), in `desktop/`: `npm install`, then `npm start` to run it or
`npm run dist` to make a Windows installer. Pushing a `v*` tag makes GitHub build the Windows,
Mac and Linux installers and attach them to that release.
