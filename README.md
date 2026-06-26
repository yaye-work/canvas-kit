# Canvas Kit

A FigJam-style annotation toolbar for Obsidian Canvas. A persistent toolbar at the top of every canvas gives you drawing tools, borderless text, cards (blank or note-backed), sections, tables, and images — without leaving the canvas.

Ink is stored as inline SVG inside ordinary canvas text nodes — **no separate files, no drawings folder**. Everything lives in the `.canvas` file itself.

## Tools

- **Select** (`V` / `Esc`) — normal canvas interaction; the default.
- **Draw** (`M`) — freehand drawing, smoothed with [perfect-freehand](https://github.com/steveruizok/perfect-freehand). The toolbar button shows your last-used draw tool. Sub-toolbar:
  - *Marker / Highlighter* — highlighter is fatter, flat-tipped, and translucent.
  - *Tape* — drag a strip of washi-style grid tape across the canvas.
  - *Eraser* — click or drag over ink to remove a whole stroke.
  - *Size* — one button, click for a thickness slider (disabled for tape/eraser).
  - *Colors* — FigJam-style presets plus a color wheel for custom colors.
  - Ink auto-commits a few seconds after you stop drawing and renders frameless, like ink sitting on the canvas. Committed ink is a normal node: select, move, delete.
- **Text** (`T`) — click anywhere and start typing, Photoshop-style: no box, no card, no background, just text that grows as you type. Supports markdown, including per-line headings and lists. Resize a text node to scale it uniformly, recolor it with the node's color button, and re-open it for editing via the Edit button, a double-click, or the Text tool.
- **Card** (`C`) — drag to size a card. A sub-toolbar picks what the card is:
  - *Empty* — a blank card.
  - *New note* — creates a note in your vault and embeds it in one gesture.
  - *Existing note* — pick a note from an inline search and drop it in.
  - A blank card also shows **+ / embed** buttons on its edge while selected, so you can turn it into a new or existing note in place.
- **Section** (`G`) — drag a marquee to create a native canvas group; the label drops straight into rename mode.
- **Table** (`B`) — drag to set rows × columns; a borderless, interactive table you can edit in place. Drag the row/column handles to reorder, **click** a handle to select a row/column (then delete it with the trash button or `Delete`), and drag the dividers to resize.
- **Image** (`I`) — a previewable image picker: search your vault's images as thumbnails, or **upload** one from your computer, then drag to place it.

## Tips

- **Right-click** exits the current tool (back to Select). Right-clicking while editing text finishes the edit.
- The draw button remembers the last sub-tool you used and reopens it.

## Settings

- **Toolbar size** — scale the toolbar to taste.
- **Hide Obsidian's bottom bar** — hide the built-in add-to-canvas bar (Canvas Kit replaces it).
- **Default marker color / size**, **default text size**, and a slot to remove a custom tape image.

## Install

### From Community Plugins

*Settings → Community plugins → Browse*, search for **Canvas Kit**, install, and enable. (Pending review.)

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/yaye-work/canvas-kit/releases).
2. Copy them into `<vault>/.obsidian/plugins/canvas-kit/`.
3. Reload Obsidian and enable **Canvas Kit** in *Settings → Community plugins*.

## Caveats

- Canvas has no official plugin API; this relies on undocumented internals (e.g. `posFromEvt`, `createTextNode`, `createFileNode`, `createGroupNode`, `removeNode`) and may need a patch after an Obsidian update.
- On devices without the plugin, ink nodes render as the raw SVG markup (or whatever Obsidian's markdown HTML rendering makes of it) and borderless nodes get their frame back — content is never lost, only styling.

## Development

```sh
npm install
npm run dev    # watch build
npm run build  # type-check + production build
```

## License

[MIT](LICENSE) © yaye.work
