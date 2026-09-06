# OMPx Annotate Chrome Extension

Install from a built `ompx` (no repo checkout needed):

```sh
ompx annotate install            # writes ~/.omp/annotate/extension
ompx annotate install --dir ./ext
```

Chrome cannot install an unpacked extension from outside the browser, so the command prints the folder and the `chrome://extensions` › Load unpacked steps. Re-run it after updating ompx, then click Reload on the extension card.

Or build from source:

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

Press Cmd+. (macOS) or Ctrl+. to toggle the annotation overlay. If Chrome leaves that shortcut unbound or it conflicts with another extension, rebind it at `chrome://extensions/shortcuts`. Once the annotator has been opened in a tab, the same shortcut also works from the page itself.

After Send, the markers and comment stay so you can iterate; press Clear to start over. The screenshot sent to the agent is the bare page with the numbered markers drawn on it.
