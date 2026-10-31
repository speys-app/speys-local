# Contributing

Node 24+, no dependencies, no build step. Paths go through `node:path` and dynamic imports through
`pathToFileURL`, so the code runs on Mac and Windows; macOS-only commands are guarded by platform.

**Speed is a requirement.** Backends load on their first request, an opened frame is not reloaded, and nothing
heavy runs at startup. A new applet must not change that.

Code, comments and interface source text are in English. Run `npm test` before opening a pull request.

## Folders

| folder | what | in git |
|---|---|---|
| `core/` | applet discovery, sidebar, Settings, `kit.js`, `kit.css` | yes |
| `lib/` | helpers shared by backends | yes |
| `applets/official/<id>/` | applets that ship to everyone | yes |
| `applets/store/<id>/` | applets installed from the Store | no |
| `applets/custom/<id>/` | applets on this computer only; a copy with the same id replaces an official one | no |
| `data/` | settings and applet data | no |

An applet never imports another applet or `core/`; shared code goes in `lib/`. Applets may call each other over
HTTP (`/a/<id>/api/...`) and must cope with the other applet being absent. To open another applet from a page:
`parent.openApplet(id, innerHash)`.

Personal data never goes in the repo. Paths, names and accounts belong in settings.

## applet.json

| field | meaning |
|---|---|
| `name`, `description` | name and tooltip in the sidebar |
| `icon` | an SVG file using `currentColor`; no star or sparkle icons |
| `order` | position, lower is higher |
| `url` | a tool running at another address, opened in the frame |
| `page` | the page of an applet without a backend, default `index.html` |
| `backend` | the backend file |
| `dashboard` | `true` puts it in the Dashboards section at the top of the sidebar |
| `settings` | fields on the Settings page: `key`, `label`, `hint`, `type` (path, text, json), `placeholder`, `section` |

## Backend

```js
export default function ({ dataDir, settings, saveSettings, t, language }) {
  return (req, res) => {};
}
```

- `dataDir`: this applet's folder, `data/<workspace>/apps/<id>/`.
- `settings()`: this applet's settings; `saveSettings(value)` replaces them.
- `t(text, values)` and `language()`: call them during a request, not at module load.

The applet runs under `/a/<id>/` and `req.url` does not include that prefix. Pages use **relative** addresses
(`./api/...`), not `/api/...`.

An applet with missing settings does not fail: it returns `{ not_configured: true }` and the page shows
`notConfigured(name)`. Better still, start with an empty state that works.

Writes go through `handleWrite` in `lib/common.js`, which checks the `X-Panel: 1` header and answers
`{ ok }` or `{ error }`.

## Page

Load `/kit.css` and `/kit.js`. `kit.js` gives you:

`t`, `LOCALE`, `$`, `esc`, `inlineMd`, `timeAgo`, `notify`, `getJson`, `isHidden`, `goTo`, `percent`, `formatNumber`,
`formatDecimal`, `lineChart`, `diffHtml`, `shortDay`, `svg`, `ICON`, `formatDate`, `checkboxHtml`, `isoDay`, `listHtml`,
`notConfigured`, `openPopup`.

The dashboard fires `focus` on a frame when its applet comes back or every 30 seconds, so refresh data on `focus`,
and skip it when `isHidden()`.

## Store

Anyone can write an applet; the maintainer approves every version before people can install it.

1. Put the applet in its own public GitHub repository, with `applet.json` at the top.
2. Open a pull request adding it to `store.json`:

```json
{
  "id": "my-notes",
  "name": "My notes",
  "description": "One sentence about what it does.",
  "author": "your-github-name",
  "version": "1.0.0",
  "repo": "https://github.com/you/my-notes",
  "commit": "the full 40-character hash of this version"
}
```

3. The code at that commit gets reviewed. Once merged, people see it in the Store.

A new version is a new pull request changing `version` and `commit`, and it is reviewed the same way. Installs take exactly that commit, updates only happen when the user clicks, and nothing from the download is run at install time. Symlinks and paths pointing outside the applet are refused.

Applets have no sandbox: a backend runs with the user's permissions, and pages share one address. Review with that in mind, and don't accept minified code you can't read.

## Demo data

The Demo workspace comes from `core/demo.js` and is rebuilt each time it opens. Keep it made up, and when you add an applet, add a little data for it there. README screenshots are taken from it, never from real data.

## Translations

English is the source language and the text is the key:

```js
t("Save")
t("{n} open", { n })
```

Translations live in `<applet>/locales/<lang>.json`:

```json
{ "Save": "Kaydet", "{n} open": "{n} açık" }
```

Text without a translation shows in English, so you never have to know another language to contribute. Format
dates and numbers with `LOCALE`. The `name`, `description`, `label`, `hint` and `placeholder` in `applet.json` are
translated the same way. A new language also needs `core/locales/<lang>.json`, which adds it to Settings.

User data is not translated.
