# Vendored

Third-party code kept in the repo on purpose, so the app works offline and
nothing is fetched from a CDN at runtime.

| file | version | why |
|---|---|---|
| `mermaid.min.js` | 11.4.1 | Renders ```mermaid diagrams in documents. Loaded lazily — only when a document actually contains one. |

Pinned deliberately: update by replacing the file and changing the version
here, never by pointing at a range.
