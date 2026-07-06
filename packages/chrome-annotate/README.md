# OMPx Annotate Chrome Extension

Build the extension:

```sh
bun run build
```

Load it in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `packages/chrome-annotate/dist`.

Pair and annotate:

1. In ompx, run `/annotate on`.
2. Copy the printed host and pairing code into the extension popup.
3. Click Connect.
4. Click Annotate this page.

The extension remembers one global host for all tabs. Pairing codes are stored per tab, so a new tab may ask for its own code in the annotation toolbar.

Press Alt+Shift+A to toggle the annotation overlay. If Chrome leaves that shortcut unbound or it conflicts with another extension, rebind it at `chrome://extensions/shortcuts`.
