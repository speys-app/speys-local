# Contributing

Node 24+, no dependencies, no build step. Paths go through `node:path` and dynamic imports through
`pathToFileURL`, so the code runs on Mac and Windows; macOS-only commands are guarded by platform.

**Speed is a requirement.** Backends load on their first request, an opened frame is not reloaded, and nothing
heavy runs at startup. A new applet must not change that.

Code, comments and interface source text are in English.

Run `npm test` before opening a pull request and put the result in its description. A pull request without a test result waits until it has one.

## Folders

| folder | what | in git |
|---|---|---|
| `core/` | applet discovery, sidebar, Settings, `kit.js`, `kit.css` | yes |
| `lib/` | helpers shared by backends | yes |
| `applets/store/<id>/` | every applet that ships to everyone; each is listed in the Store and shows up once installed | yes |
| `applets/custom/<id>/` | applets on this computer only; a copy with the same id replaces the Store one | no |
| `data/` | settings and applet data | no |

An applet never imports another applet or `core/`; shared code goes in `lib/`. Applets may call each other over
HTTP (`/a/<id>/api/...`) and must cope with the other applet being absent. To open another applet from a page:
`parent.openApplet(id, innerHash)`.

Personal data never goes in the repo. Paths, names and accounts belong in settings.

## applet.json

| field | meaning |
|---|---|
| `name`, `description` | name and tooltip in the sidebar, and its card in the Store |
| `icon` | an SVG file using `currentColor`; no star or sparkle icons |
| `author` | who wrote it, shown in the Store; default `Speys` |
| `category` | one word or two for the Store's filters, such as `Productivity` or `Games` |
| `reads` | what it reads, and anything it loads from the network; shown before installing |
| `platforms` | some of `macos`, `windows`, `linux`, when it doesn't run everywhere |
| `preinstalled` | `true` installs it in a new workspace; keep this for the few everyone needs |
| `storeOrder` | its place in the Store, lower first; without it the Store follows `order` after these |
| `order` | position, lower is higher |
| `url` | a tool running at another address, opened in the frame |
| `page` | the page of an applet without a backend, default `index.html` |
| `backend` | the backend file |
| `dashboard` | `true` puts it in the Dashboards section at the top of the sidebar |
| `settings` | fields on the Settings page: `key`, `label`, `hint`, `type` (path, text, json), `placeholder`, `section` |
| `sync` | what syncs with a Speys account, when the user connects one; see [Syncing with Speys](#syncing-with-speys) |

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

## Syncing with Speys

An applet works fully without an account. When it has a counterpart in Speys (the first is Finances, `kasa`), the user
can connect their account and the two are kept in step both ways. The sync works on the data, not on your code: a copy
of an applet in `applets/custom/` that looks and behaves differently keeps syncing.

```json
"sync": {
  "version": 1,
  "file": "defter.json",
  "collections": {
    "rules": { "remote": "kasa.recurring", "own": ["lastGenerated"] },
    "entries": { "remote": "kasa.entries", "map": { "kdv": "vatRate" } }
  }
}
```

- `file` is in the applet's data folder; `collections` are the arrays in it, sent in this order (a record that points
  to another goes after it). `remote` is `<service>.<kind>` in Speys.
- A record needs an `id` that is the same on both sides, an `updatedAt` that changes on edit, and `deletedAt` when
  deleted (or it leaves the file). Everything else is free: fields Speys doesn't know are kept there and sent back.
- A field missing from a record means "this applet doesn't know it", not "delete it"; write `null` to clear.
- `map` renames a field between your name and Speys's; `own` lists fields that belong to this computer only and are
  never sent; `"tombstones": false` removes deleted records from the file instead of keeping them marked.
- A record two sides can create on their own (a repeat of a rule on a date) takes `stableId(...)` from `lib/sync.js`,
  so it isn't made twice.

`lib/sync.js` merges field by field against the last synced copy: a field changed on one side wins, the same field
changed differently on both is asked, never dropped. `lib/speys.js` signs in (Speys's OAuth, back to this computer,
a token that only works for Speys Local) and `lib/speys-sync.js` runs one sync. Nothing syncs at start-up; the page
asks while it is open.

## Page

Load `/kit.css` and `/kit.js`. `kit.js` gives you:

`t`, `LOCALE`, `$`, `esc`, `inlineMd`, `timeAgo`, `notify`, `getJson`, `isHidden`, `goTo`, `percent`, `formatNumber`,
`formatDecimal`, `lineChart`, `diffHtml`, `shortDay`, `svg`, `ICON`, `formatDate`, `checkboxHtml`, `isoDay`, `listHtml`,
`notConfigured`, `openPopup`.

The dashboard fires `focus` on a frame when its applet comes back or every 30 seconds, so refresh data on `focus`,
and skip it when `isHidden()`.

## Store

Every applet in `applets/store/` is listed in the Store. Installing one only adds its id to the workspace's
`_dashboard.installed` list in `settings.json`: nothing is downloaded, and an applet that isn't installed has no page
and runs no code. Applets update together with Speys Local, when the user clicks.

To add yours:

1. Write it in `applets/custom/<id>/` and use it for a while.
2. Move it to `applets/store/<id>/`, fill in `author`, `category` and `reads` in `applet.json` (see above), and put
   one to three PNG screenshots taken with made-up data in `screenshots/`, shown in name order.
3. Open a pull request. The code is reviewed line by line; once merged, everyone sees it in the Store.

A change to it later is a pull request too, reviewed the same way.

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
