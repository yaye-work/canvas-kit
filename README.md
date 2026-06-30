

# Canvas Kit
<img alt="canvaskit" src="https://github.com/user-attachments/assets/24296da5-f944-41d7-a326-3bf8279bdd81" />
Add marker, highlighter, tape, text tool, quick drag-out card, make new notes or embed straight in the canvas FAST. Interactive table.
Your canvas power house with annonations.

Ink is stored as inline SVG inside ordinary canvas text nodes — **no separate files, no drawings folder**. Everything lives in the canvas file itself.

## Tools

- **Draw Kit** (`M`) — Smooth freehand Marker,Highlighter, Washi Tape with different designs (you can also upload any image and it will become a tape).
<img alt="Draw Kit" src="https://github.com/user-attachments/assets/ac19f481-9e50-4142-8488-867a68072064" />

- **Just Text Please** (`T`) — click anywhere and start typing, no outline or nested in a card. Supports markdown. Resize a text to scale it uniformly, recolor it with the node's color button, and re-open it for editing via the Edit button.
<img alt="TEXT" src="https://github.com/user-attachments/assets/97ab5f95-1dae-4f19-af4c-8ec95459e474" />

- **Better Cards** (`C`) — Create and resize your card in a single drag. Quick add existing note and new note. 
<img alt="card" src="https://github.com/user-attachments/assets/74d1e109-7471-40ce-a876-8e9bb2f18558" />

  A sub-toolbar picks what the card is:
    - *Empty* — a blank card.
    - *New note* — creates a note in your vault and embeds it in one gesture.
    - *Existing note* — pick a note from an inline search and drop it in.
    - A blank card also shows **new note / embed** buttons on its edge while selected, so you can turn it into a new or existing note in place.
  
- **Drag and Make Section** (`G`) — Similar to Figma's frame tool: drag a marquee to create a section; then you can rename the section straight away.

<img width="749" height="517" alt="Drag Section" src="https://github.com/user-attachments/assets/77cd12ae-9c91-4683-be2c-3812902f3fda" />

- **Table** (`B`) — drag to set rows × columns; a borderless, interactive table you can edit in place. Drag the row/column handles to reorder, **click** a handle to select a row/column (then delete it with the trash button or `Delete`), and drag the dividers to resize.
<img width="749" height="517" alt="Table" src="https://github.com/user-attachments/assets/cc7b22b5-cdfd-4072-afbc-794f990db8b0" />

- **Image** (`I`) — a previewable image picker: search your vault's images as thumbnails, or **upload** one from your computer, then drag to place it.
<img width="749" height="517" alt="image" src="https://github.com/user-attachments/assets/55512b41-f7af-442a-a444-652b5cdc3295" />

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
