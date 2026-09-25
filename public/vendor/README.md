# Vendored

Third-party code kept in the repo on purpose, so the app works offline and
nothing is fetched from a CDN at runtime.

| file | version | why |
|---|---|---|
| `mermaid.min.js` | 11.4.1 | Renders ```mermaid diagrams in documents. Loaded lazily — only when a document actually contains one. |
| `monaco/` | 0.57.0 (`min/vs`, MIT — `monaco/LICENSE`) | The editor in the pad (`/pad`). Trimmed, see below. |

Pinned deliberately: update by replacing the file and changing the version
here, never by pointing at a range.

## Monaco, trimmed

`monaco/vs` is `monaco-editor@0.57.0`'s `min/vs` with two things left out,
which takes it from 25 MB to 5.7 MB:

- `nls/lang/` — the non-English UI translations. The app is English.
- The TypeScript, JSON, CSS and HTML language-service workers
  (`assets/{ts,json,css,html}.worker-*.js` and `language/*/*.worker.js`).
  They power type errors, hovers and formatting — not colouring, which comes
  from `basic-languages/` and runs on the page. `pad.html` switches every
  worker-backed feature off with `setModeConfiguration`, so Monaco never
  asks for them; the 0.2 KB `vs/*.worker-*.js` stubs stay because the editor
  bundle imports them at start-up.

To update: `npm pack monaco-editor@<version>`, copy `package/min/vs` over
`monaco/vs`, delete the same files again, open `/pad`, switch through every
language, and check the console stays empty.
