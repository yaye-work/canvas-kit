import {
	App,
	ItemView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	setIcon,
} from "obsidian";
import { getStroke } from "perfect-freehand";

// ---------- Settings ----------

interface CanvasPencilSettings {
	strokeColor: string;
	strokeSize: number; // in canvas units
	tapeImage: string | null; // data URI of the user's custom tape tile
	textSize: number; // starting font size for new text (in canvas units)
	hideBottomBar: boolean; // hide Obsidian's bottom add-to-canvas bar (.canvas-card-menu)
	toolbarScale: number; // scale factor for Canvas Kit's own toolbar (1 = default)
}

const DEFAULT_SETTINGS: CanvasPencilSettings = {
	strokeColor: "#1e1e1e",
	strokeSize: 6,
	tapeImage: null,
	textSize: 20,
	hideBottomBar: false,
	toolbarScale: 1,
};

// FigJam-style preset row: black, red, orange, yellow, green, blue, violet, white.
const PALETTE = [
	"#1e1e1e",
	"#e03e3e",
	"#f08c28",
	"#f5c731",
	"#5bb98c",
	"#4f9ddb",
	"#7d5bd6",
	"#ffffff",
];

// Highlighter presets: pastels (grey, pink, orange, yellow, green, cyan, purple, white).
const HIGHLIGHT_PALETTE = [
	"#9e9e9e",
	"#f2a7dd",
	"#f5b266",
	"#f7ee7f",
	"#b6f08c",
	"#85efe4",
	"#a78bfa",
	"#ffffff",
];

const INK_MARK = "cp-ink"; // class marker inside stored SVG text

// ---------- Tape patterns ----------

interface TapePattern {
	id: string;
	label: string;
	base: string; // solid base color
	swatchCss: string;
	/** SVG <pattern> definition; angle = tape rotation in degrees. */
	defs: (pid: string, angle: number) => string;
}

const TAPE_PATTERNS: TapePattern[] = [
	{
		id: "grid",
		label: "Grid",
		base: "#dcd0f7",
		swatchCss:
			"background-color:#dcd0f7;background-image:linear-gradient(#8a63d2 1px,transparent 1px),linear-gradient(90deg,#8a63d2 1px,transparent 1px);background-size:5px 5px;",
		defs: (pid, angle) =>
			`<pattern id="${pid}" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})"><path d="M16 0H0V16" fill="none" stroke="#8a63d2" stroke-width="1.5"/></pattern>`,
	},
	{
		id: "dots",
		label: "Dots",
		base: "#fdf3e7",
		swatchCss:
			"background-color:#fdf3e7;background-image:radial-gradient(#e0626a 1.5px,transparent 1.7px);background-size:6px 6px;",
		defs: (pid, angle) =>
			`<pattern id="${pid}" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})"><circle cx="8" cy="8" r="3" fill="#e0626a"/></pattern>`,
	},
	{
		id: "checker",
		label: "Checker",
		base: "#ffffff",
		swatchCss:
			"background:conic-gradient(#4f9ddb 25%,#ffffff 25% 50%,#4f9ddb 50% 75%,#ffffff 75%);background-size:8px 8px;",
		defs: (pid, angle) =>
			`<pattern id="${pid}" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})"><rect width="8" height="8" fill="#4f9ddb"/><rect x="8" y="8" width="8" height="8" fill="#4f9ddb"/></pattern>`,
	},
	{
		id: "stars",
		label: "Stars",
		base: "#2b2d52",
		swatchCss:
			"background-color:#2b2d52;background-image:radial-gradient(#ffffff 1px,transparent 1.2px);background-size:7px 7px;",
		defs: (pid, angle) =>
			`<pattern id="${pid}" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})"><circle cx="6" cy="6" r="2" fill="#fff"/><circle cx="18" cy="14" r="1.4" fill="#fff"/><circle cx="10" cy="20" r="1" fill="#fff"/></pattern>`,
	},
	{
		id: "stripes",
		label: "Stripes",
		base: "#f5d442",
		swatchCss:
			"background:repeating-linear-gradient(45deg,#f5d442 0 4px,#58b583 4px 8px);",
		defs: (pid, angle) =>
			`<pattern id="${pid}" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle + 45})"><rect width="8" height="16" fill="#58b583"/></pattern>`,
	},
];

const CUSTOM_TAPE_ID = "custom";
const CUSTOM_TILE = 64; // tile size in canvas units

// ---------- Text tool ----------

const TEXT_LINE_HEIGHT = 1.2;
const TEXT_PAD_EM = 0; // no inner padding — the box hugs the glyphs (Photoshop-style)

/** Store text with REAL newlines so each line is its own markdown block — block
 *  syntax (`# heading`, `- list`) only works when lines are separated by an
 *  actual newline, not an inline `<br>`. The doubled-gap that `<br>` originally
 *  worked around is handled in CSS instead (white-space:nowrap collapses the
 *  literal newline Obsidian emits after a soft break). */
function textToMarkdown(s: string): string {
	return s.replace(/\r/g, "");
}
function markdownToText(s: string): string {
	// Legacy nodes stored soft breaks as bare `<br>`; show them back as newlines
	// (and swallow any trailing newline) so old text still edits correctly.
	return s.replace(/<br\s*\/?>\n?/gi, "\n");
}
const TEXT_FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

/** Live handle to the inline textarea editor mounted over the canvas. */
interface TextEditorHandle {
	commit: () => void;
}

let _measureCtx: CanvasRenderingContext2D | null = null;
function measureTextLines(lines: string[], fontSize: number): number {
	if (!_measureCtx) _measureCtx = activeDocument.createElement("canvas").getContext("2d");
	const ctx = _measureCtx;
	if (!ctx) return fontSize * 4;
	ctx.font = `${fontSize}px ${TEXT_FONT}`;
	let w = 0;
	for (const l of lines) w = Math.max(w, ctx.measureText(l || " ").width);
	return w;
}

interface TextBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Size the node box to fit the (raw) text at a given font size. Padding scales
 * with the font so the box stays proportional when the text is scaled later.
 * Width is measured generously off the source — rendered markdown drops its
 * `*`/`` ` `` markers, so it never clips.
 */
function textBox(raw: string, fontSize: number, origin: { x: number; y: number }): TextBox {
	const lines = raw.replace(/\r/g, "").split("\n");
	const lineH = fontSize * TEXT_LINE_HEIGHT;
	const pad = fontSize * TEXT_PAD_EM;
	const w = measureTextLines(lines, fontSize);
	return {
		x: Math.round(origin.x),
		y: Math.round(origin.y),
		width: Math.max(1, Math.ceil(w + pad * 2 + fontSize * 0.15)),
		height: Math.max(1, Math.ceil(lines.length * lineH + pad * 2)),
	};
}

const TEXT_DEFAULT_SIZE = 20;

/**
 * Stamp a node as Canvas Kit text and stash its base font size + box so the
 * text can be scaled uniformly when the node is resized. Color is NOT stored —
 * it rides Obsidian's own node color (--canvas-color), applied to the text.
 */
function tagTextNode(node: CanvasNodeLike, size: number, box: TextBox) {
	const stamp = (d: Record<string, unknown>) => {
		d.pencilType = "text";
		d.pencilTextSize = size;
		d.pencilBaseW = box.width;
		d.pencilBaseH = box.height;
	};
	try {
		if (node.unknownData) stamp(node.unknownData);
		if (node.getData && node.setData) {
			const d = node.getData();
			stamp(d);
			node.setData(d);
		}
	} catch (err) {
		console.warn("Canvas Kit: couldn't tag text node", err);
	}
}

/** Read back a text node's base font size + box (with sensible defaults). */
function textMeta(node: CanvasNodeLike): { size: number; baseW: number; baseH: number } {
	const d: Record<string, unknown> = node.getData?.() ?? {};
	const u: Record<string, unknown> = node.unknownData ?? {};
	const num = (k: string) => Number(d[k] ?? u[k]);
	const size = num("pencilTextSize");
	return {
		size: size > 0 ? size : TEXT_DEFAULT_SIZE,
		baseW: num("pencilBaseW") || 0,
		baseH: num("pencilBaseH") || 0,
	};
}

/** Screen-space transform of the canvas: world→client mapping + current zoom. */
function canvasTransform(canvas: CanvasLike) {
	const rect = canvas.wrapperEl.getBoundingClientRect();
	const a = canvas.posFromEvt!({ clientX: rect.left, clientY: rect.top });
	const b = canvas.posFromEvt!({ clientX: rect.left + 100, clientY: rect.top });
	const zoom = 100 / ((b.x - a.x) || 1);
	return { rect, originWorld: a, zoom };
}

// ---------- Types for undocumented canvas internals ----------

type Point = [number, number, number];

interface PencilStroke {
	worldPts: Point[];
	color: string;
	size: number;
	highlight: boolean;
}

interface CanvasNodeLike {
	nodeEl?: HTMLElement;
	text?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	startEditing?: () => void;
	getData?: () => Record<string, unknown>;
	setData?: (data: Record<string, unknown>) => void;
	unknownData?: Record<string, unknown>;
}

interface CanvasLike {
	wrapperEl: HTMLElement;
	nodes?: Map<string, CanvasNodeLike>;
	posFromEvt?: (evt: { clientX: number; clientY: number }) => { x: number; y: number };
	createTextNode?: (opts: {
		pos: { x: number; y: number };
		size?: { width: number; height: number };
		text?: string;
		save?: boolean;
		focus?: boolean;
	}) => CanvasNodeLike | undefined;
	createGroupNode?: (opts: {
		pos: { x: number; y: number };
		size: { width: number; height: number };
		label?: string;
		save?: boolean;
		focus?: boolean;
	}) => CanvasNodeLike | undefined;
	createFileNode?: (opts: {
		pos: { x: number; y: number };
		size?: { width: number; height: number };
		file: TFile;
		subpath?: string;
		save?: boolean;
		focus?: boolean;
	}) => CanvasNodeLike | undefined;
	removeNode?: (node: CanvasNodeLike) => void;
	requestSave?: () => void;
	deselectAll?: () => void;
	getData?: () => unknown;
	pushHistory?: (data: unknown) => void;
}

/** Record the post-change canvas state in Obsidian's own undo history, so the
 *  built-in undo/redo buttons revert Canvas Kit strokes/nodes too. */
function pushCanvasHistory(canvas: CanvasLike | undefined) {
	if (!canvas) return;
	try {
		const data = canvas.getData?.();
		if (data) canvas.pushHistory?.(data);
	} catch (err) {
		console.warn("Canvas Kit: couldn't push undo history", err);
	}
}

interface CanvasViewLike extends ItemView {
	canvas?: CanvasLike;
}

type ToolId = "select" | "marker" | "text" | "card" | "section" | "table" | "image";
type MarkerMode = "draw" | "highlight" | "tape" | "erase";
type CardMode = "empty" | "new" | "existing";

// ---------- Plugin ----------

export default class CanvasPencilPlugin extends Plugin {
	settings: CanvasPencilSettings;
	private toolbars = new Map<CanvasViewLike, CanvasToolbar>();

	async onload() {
		await this.loadSettings();
		this.applyBottomBarVisibility();
		this.addSettingTab(new CanvasPencilSettingTab(this.app, this));

		this.addCommand({
			id: "toggle-marker",
			name: "Toggle marker tool on active canvas",
			checkCallback: (checking) => {
				const view = this.getActiveCanvasView();
				if (!view) return false;
				if (!checking) {
					const tb = this.toolbars.get(view);
					tb?.setTool(tb.tool === "marker" ? "select" : "marker");
				}
				return true;
			},
		});

		this.registerEvent(this.app.workspace.on("layout-change", () => this.attachToolbars()));
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.attachToolbars())
		);
		this.app.workspace.onLayoutReady(() => this.attachToolbars());

		this.registerInterval(
			window.setInterval(() => {
				for (const tb of this.toolbars.values()) tb.refreshNodeStyles();
			}, 1200)
		);
	}

	onunload() {
		for (const tb of this.toolbars.values()) tb.destroy();
		this.toolbars.clear();
		activeDocument.body.removeClass("canvas-kit-hide-bottom-bar");
	}

	/** Toggle a body class that hides Obsidian's bottom add-to-canvas bar. */
	applyBottomBarVisibility() {
		activeDocument.body.toggleClass("canvas-kit-hide-bottom-bar", this.settings.hideBottomBar);
	}

	/** Re-apply the toolbar scale to every live canvas toolbar. */
	applyToolbarScale() {
		for (const tb of this.toolbars.values()) tb.applyScale();
	}

	getActiveCanvasView(): CanvasViewLike | null {
		const view = this.app.workspace.getActiveViewOfType<CanvasViewLike>(ItemView);
		if (view && view.getViewType() === "canvas" && view.canvas) return view;
		return null;
	}

	private attachToolbars() {
		const live = new Set<CanvasViewLike>();
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const view = leaf.view as CanvasViewLike;
			if (!view.canvas) continue;
			live.add(view);
			if (!this.toolbars.has(view)) {
				this.toolbars.set(view, new CanvasToolbar(this, view));
			}
		}
		for (const [view, tb] of this.toolbars) {
			if (!live.has(view)) {
				tb.destroy();
				this.toolbars.delete(view);
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<CanvasPencilSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ---------- Toolbar ----------

// ---------- Custom toolbar icons (designed; filled, inherit currentColor) ----------

const svgIcon = (inner: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" class="svg-icon">${inner}</svg>`;

/**
 * Mount a self-authored SVG string into an element as parsed DOM nodes.
 * Parsed as image/svg+xml, so any markup is data — scripts never execute — and
 * the element keeps the correct SVG namespace. Returns false on a parse error.
 */
function setSvg(el: HTMLElement, svg: string): boolean {
	const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
	if (!root || root.tagName.toLowerCase() !== "svg") return false;
	el.empty();
	el.appendChild(el.ownerDocument.importNode(root, true));
	return true;
}
// Multi-path icons (e.g. a card + its plus/magnifier overlay): every subpath is
// filled with evenodd so cut-outs read as holes.
const filledMulti = (...ds: string[]) =>
	svgIcon(
		ds
			.map((d) => `<path fill-rule="evenodd" clip-rule="evenodd" d="${d}" fill="currentColor"/>`)
			.join("")
	);

// Turn a toolbar icon into a CSS cursor: give it an explicit pixel size (cursors
// have no CSS box to size them) and a concrete fill + white halo so it stays
// visible on any canvas background (currentColor doesn't resolve in a data URI).
// Hotspot is given in viewBox units (0–24) and scaled to `size` so it stays put
// at any size. `rotate` (deg, about the icon center) angles drawing tools.
const svgToCursor = (
	svgString: string,
	hotVBx: number,
	hotVBy: number,
	size: number,
	rotate = 0
): string => {
	let cur = svgString
		.replace('class="svg-icon"', `width="${size}" height="${size}"`)
		.replace(
			'fill="currentColor"',
			'fill="#202020" stroke="#ffffff" stroke-width="1.1" paint-order="stroke" stroke-linejoin="round"'
		);
	if (rotate) cur = cur.replace("<path ", `<path transform="rotate(${rotate} 12 12)" `);
	const hx = Math.round((hotVBx / 24) * size);
	const hy = Math.round((hotVBy / 24) * size);
	return `url("data:image/svg+xml;utf8,${encodeURIComponent(cur)}") ${hx} ${hy}, auto`;
};

// Designed toolbar icons (thin, filled, inherit currentColor). SVGO-optimized (p2). Frame uses Section.svg.
const ICON_MARKER = filledMulti("M11.18 1.99c.3-.46.95-.5 1.32-.12l.07.08v.02l.06.08v.01l1.43 2.67c.35.14.63.43.74.8l2.36 7.76q.55 1.81.55 3.7v4.15c0 .69-.56 1.25-1.25 1.25H7.54c-.7 0-1.25-.56-1.25-1.25v-4.32q0-1.7.45-3.35l2.15-7.9c.13-.48.53-.82 1-.9l1.23-2.58v-.01l.05-.08zm-3.4 18.9h8.43v-1.37H7.8zm.4-7.03q-.4 1.46-.4 2.96v1.2h8.43V17q0-1.67-.48-3.27l-2.3-7.59h-3.14z");
const ICON_HIGHLIGHTER = filledMulti("M14.49 1.62c.45-.06.85.29.85.75v2.12c.58.07 1.04.54 1.1 1.13l.34 3.85a10 10 0 0 0 1.27 4.1c.51.9.78 1.93.78 2.96v4.6c0 .7-.56 1.25-1.25 1.26H6.42c-.69 0-1.25-.56-1.25-1.25v-4.69q0-1.48.67-2.8.98-1.96 1.12-4.15l.24-3.85c.04-.64.56-1.14 1.2-1.17V3.13c0-.37.28-.69.65-.74zM6.67 20.9h10.66v-1.37H6.67zM8.46 9.6c-.1 1.65-.54 3.26-1.28 4.73a5 5 0 0 0-.5 2.13v1.57h10.65v-1.49q0-1.18-.58-2.22a12 12 0 0 1-1.46-4.7l-.33-3.63H8.7z");
const ICON_ERASER = filledMulti("M13.48 2.1a.75.75 0 0 1 1.06-.08L22.4 8.8l.06.05c.26.28.28.71.02 1l-9.93 11.57q-.38.43-.95.43H7.57q-.46 0-.81-.3L1.59 17.1a.75.75 0 0 1-.08-1.06zm-6.32 9.66 6.74 5.79 6.97-8.11-6.74-5.8z");
const ICON_WASHI = filledMulti("M11.54 1.93a.63.63 0 0 1 .88 0l2.82 2.83 2.83-2.83a.63.63 0 0 1 1.07.45V18.6q.04.03.04.1v.2q0 .05-.04.08v2.63c0 .35-.28.63-.63.63H5.45a.63.63 0 0 1-.63-.63V2.38a.63.63 0 0 1 1.07-.45L8.7 4.76zM6.07 21H7.3v-1.97H6.07zm1.67 0h1.78v-1.97H7.74zm2.23 0h1.78v-1.97H9.97zm2.23 0h1.78v-1.97H12.2zm2.23 0h1.78v-1.97h-1.78zm2.23 0h1.23v-1.97h-1.23zM6.07 18.58H7.3V16.8H6.07zm1.67 0h1.78V16.8H7.74zm2.23 0h1.78V16.8H9.97zm2.23 0h1.78V16.8H12.2zm2.23 0h1.78V16.8h-1.78zm2.23 0h1.23V16.8h-1.23zM6.07 16.36H7.3v-1.77H6.07zm1.67 0h1.78v-1.77H7.74zm2.23 0h1.78v-1.77H9.97zm2.23 0h1.78v-1.77H12.2zm2.23 0h1.78v-1.77h-1.78zm2.23 0h1.23v-1.77h-1.23zm-2.23-2.22h1.78v-1.78h-1.78zm2.23 0h1.23v-1.78h-1.23zm-10.59 0H7.3v-1.78H6.07zm1.67 0h1.78v-1.78H7.74zm2.23 0h1.78v-1.78H9.97zm2.23 0h1.78v-1.78H12.2zM6.07 11.9H7.3v-1.77H6.07zm1.67 0h1.78v-1.77H7.74zm2.23 0h1.78v-1.77H9.97zm2.23 0h1.78v-1.77H12.2zm2.23 0h1.78v-1.77h-1.78zm2.23 0h1.23v-1.77h-1.23zM6.07 9.7H7.3V7.92H6.07zm1.67 0h1.78V7.92H7.74zm2.23 0h1.78V7.92H9.97zm2.23 0h1.78V7.92H12.2zm2.23 0h1.78V7.92h-1.78zm2.23 0h1.23V7.92h-1.23zM6.07 7.47H7.3V5.7H6.07zm1.67 0h1.78V5.72l-.36.36a.63.63 0 0 1-.89 0L7.9 5.7h-.15zm2.23 0h1.78V5.7H9.97zm2.23 0h1.78V5.7H12.2zm3.49-1.39a.63.63 0 0 1-.89 0l-.37-.37v1.76h1.78V5.7h-.14zm.97 1.4h1.23V5.7h-1.23zM6.07 5.24H7.3V5.1L6.07 3.88zm3.92 0h1.76V3.5zm2.21 0h1.77L12.2 3.48zm4.46-.14v.14h1.23V3.88z");
const ICON_TEXT = filledMulti("M4.98 1.96q.15.05.31.05h12.47a1 1 0 0 0 .32-.05l.55-.19.16-.02h.07c.5 0 .9.4.9.9v5.07a.89.89 0 0 1-1.77.11l-.32-2.46c-.07-.55-.25-.89-.5-1.1a1.6 1.6 0 0 0-.98-.34l-.2-.01h-2.05a1 1 0 0 0-1 1v14.63a1 1 0 0 0 1 1h1.72a.92.92 0 1 1 0 1.83H7.4a.92.92 0 0 1 0-1.83h1.72a1 1 0 0 0 1-1V4.92a1 1 0 0 0-1-1H7.07q-.84.02-1.19.35c-.24.21-.43.55-.5 1.1l-.32 2.46a.89.89 0 0 1-1.77-.11V2.65a.9.9 0 0 1 1.2-.86z");
const ICON_CARD = filledMulti("M13.51 1.64q.33 0 .56.24l6.98 7.49q.2.22.2.51v11.94c0 .42-.34.76-.76.76H3.51a.76.76 0 0 1-.76-.76V2.4c0-.42.34-.76.76-.76zM4.53 3.17a.26.26 0 0 0-.26.26v17.36c0 .14.12.26.26.26h14.94c.14 0 .26-.12.26-.26v-9.55a.26.26 0 0 0-.26-.27h-5.73c-.7 0-1.28-.57-1.28-1.27V3.43a.26.26 0 0 0-.26-.26z");
const ICON_FRAME = filledMulti("M4.92 1.42c.31 0 .56.25.56.56v1.86q0 .06.07.07h12.78q.05 0 .06-.07V1.98c0-.31.25-.56.56-.56h.49c.3 0 .56.25.56.56v1.86q0 .06.06.07h2c.3 0 .56.25.56.56v.48c0 .31-.26.56-.57.56h-1.99a.06.06 0 0 0-.06.07v12.88q0 .05.06.06H22c.3 0 .56.25.56.56v.48c0 .31-.25.57-.56.57h-1.94l-.06.06v1.83c0 .31-.25.56-.56.56h-.49a.56.56 0 0 1-.56-.56V20.2l-.06-.06H5.55a.06.06 0 0 0-.07.06v1.77c0 .3-.25.56-.56.56h-.48a.56.56 0 0 1-.56-.56V20.2a.06.06 0 0 0-.07-.06H1.95a.56.56 0 0 1-.57-.57v-.48c0-.31.26-.56.57-.56H3.8q.07 0 .07-.06V5.58a.06.06 0 0 0-.07-.07H1.95a.56.56 0 0 1-.57-.56v-.48c0-.31.26-.56.57-.56H3.8q.07 0 .07-.07V1.98c0-.31.25-.56.56-.56zm.63 4.1a.06.06 0 0 0-.07.06v12.88q0 .05.07.06h12.78q.05 0 .06-.06V5.58a.06.06 0 0 0-.06-.07z");
const ICON_TABLE = filledMulti("M19.23 1.92c.3 0 .55.24.55.54v19.08c0 .3-.25.54-.55.55H4.77a.55.55 0 0 1-.55-.55V2.46c0-.3.25-.54.55-.54zM5.77 17.16l-.05.05v3.33q0 .03.05.05h3.45q.05-.01.05-.05V17.2l-.05-.05zm5.05 0-.05.05v3.33q0 .03.05.05h7.41q.05-.01.05-.05V17.2l-.05-.05zm-5.05-4.74-.05.05v3.14q0 .05.05.05h3.45q.05 0 .05-.05v-3.14l-.05-.05zm5.05 0-.05.05v3.14q0 .05.05.05h7.41q.05 0 .05-.05v-3.14l-.05-.05zm-5.05-4.6a.05.05 0 0 0-.05.06v3q0 .03.05.04h3.45q.05 0 .05-.05v-3l-.05-.04zm5.05 0a.05.05 0 0 0-.05.06v3q0 .03.05.04h7.41q.05 0 .05-.05v-3l-.05-.04zm-5.05-4.4-.05.04v2.82q0 .05.05.05h3.45q.05 0 .05-.05V3.46l-.05-.04zm5.05 0-.05.04v2.82q0 .05.05.05h7.41q.05 0 .05-.05V3.46l-.05-.04z");
const ICON_IMAGE = filledMulti("M8.31 5.8a3.1 3.1 0 0 1 3.1 3.1v.16A3.1 3.1 0 0 1 8.3 12h-.16a3.1 3.1 0 0 1 .16-6.2m0 1.5a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2", "M21.62 2.34c.5.05.9.48.9 1v18a1 1 0 0 1-.9.9H2.81a1 1 0 0 1-.9-1V3.34a1 1 0 0 1 .9-1zm-18.2 18.4H7.1q1.02-1.57 2.05-3.25a62 62 0 0 1 2.3-3.5 15 15 0 0 1 2.42-2.74 4.5 4.5 0 0 1 2.83-1.21c1.95 0 3.36.7 4.32 1.55V3.84H3.42zm13.28-9.2q-.81-.02-1.86.86a14 14 0 0 0-2.17 2.47 61 61 0 0 0-2.24 3.41l-1.54 2.46h12.13v-6.7c-.36-.84-1.66-2.5-4.32-2.5");
const ICON_CARD_EMPTY = filledMulti("M13.51 1.64q.33 0 .56.24l6.98 7.49q.2.22.2.51v11.94c0 .42-.34.76-.76.76H3.51a.76.76 0 0 1-.76-.76V2.4c0-.42.34-.76.76-.76zM4.53 3.17a.26.26 0 0 0-.26.26v17.36c0 .14.12.26.26.26h14.94c.14 0 .26-.12.26-.26v-9.55a.26.26 0 0 0-.26-.27h-5.73c-.7 0-1.28-.57-1.28-1.27V3.43a.26.26 0 0 0-.26-.26z");
const ICON_CARD_NEW = filledMulti("M9.95 12c.28 0 .5.22.5.5v2.3c0 .27.22.5.5.5h2.29c.28 0 .5.21.5.5v.34a.5.5 0 0 1-.5.5h-2.3a.5.5 0 0 0-.5.5v2.29a.5.5 0 0 1-.5.5H9.6a.5.5 0 0 1-.5-.5v-2.3a.5.5 0 0 0-.5-.5H6.31a.5.5 0 0 1-.5-.5v-.34c0-.28.23-.5.5-.5h2.3a.5.5 0 0 0 .5-.5V12.5c0-.28.22-.5.5-.5z", "M13.51 1.64q.33 0 .56.24l6.98 7.49q.2.22.2.51v11.94c0 .42-.34.76-.76.76H3.51a.76.76 0 0 1-.76-.76V2.4c0-.42.34-.76.76-.76zM4.53 3.17a.26.26 0 0 0-.26.26v17.36c0 .14.12.26.26.26h14.94c.14 0 .26-.12.26-.26v-9.55a.26.26 0 0 0-.26-.27h-5.73c-.7 0-1.28-.57-1.28-1.27V3.43a.26.26 0 0 0-.26-.26z");
const ICON_CARD_EXISTING = filledMulti("M8.13 11.82a3.3 3.3 0 0 1 3.97 4.42.6.6 0 0 0 .11.64l1.4 1.35c.21.2.22.52.02.73l-.36.37a.5.5 0 0 1-.72 0l-1.38-1.32a.6.6 0 0 0-.65-.08 3.28 3.28 0 0 1-4.6-2.02 3.3 3.3 0 0 1 2.21-4.1m2.62 2.65a1.75 1.75 0 1 0-3.36 1 1.75 1.75 0 0 0 3.36-1", "M13.51 1.64q.33 0 .56.24l6.98 7.49q.2.22.2.51v11.94c0 .42-.34.76-.76.76H3.51a.76.76 0 0 1-.76-.76V2.4c0-.42.34-.76.76-.76zM4.53 3.17a.26.26 0 0 0-.26.26v17.36c0 .14.12.26.26.26h14.94c.14 0 .26-.12.26-.26v-9.55a.26.26 0 0 0-.26-.27h-5.73c-.7 0-1.28-.57-1.28-1.27V3.43a.26.26 0 0 0-.26-.26z");

const TOOLS: { id: ToolId; icon: string; label: string; key: string; svg?: string }[] = [
	{ id: "select", icon: "mouse-pointer-2", label: "Select (V or Esc)", key: "v" },
	{ id: "marker", icon: "pencil", label: "Draw tools (M)", key: "m", svg: ICON_MARKER },
	{ id: "text", icon: "type", label: "Text — click to type (T)", key: "t", svg: ICON_TEXT },
	{ id: "card", icon: "file", label: "Card — drag to size (C)", key: "c", svg: ICON_CARD },
	{ id: "section", icon: "group", label: "Section — drag to group (G)", key: "g", svg: ICON_FRAME },
	{ id: "table", icon: "table", label: "Table — drag to size (B)", key: "b", svg: ICON_TABLE },
	{ id: "image", icon: "image", label: "Image — search or upload (I)", key: "i", svg: ICON_IMAGE },
];

const MARKER_MODES: { id: MarkerMode; icon: string; label: string; svg?: string }[] = [
	{ id: "draw", icon: "pen-line", label: "Marker", svg: ICON_MARKER },
	{ id: "highlight", icon: "highlighter", label: "Highlighter", svg: ICON_HIGHLIGHTER },
	{ id: "tape", icon: "rectangle-horizontal", label: "Washi tape — drag a strip", svg: ICON_WASHI },
	{ id: "erase", icon: "eraser", label: "Eraser — removes a whole stroke", svg: ICON_ERASER },
];

const CARD_MODES: { id: CardMode; icon: string; label: string; svg?: string }[] = [
	{ id: "empty", icon: "square", label: "Empty card", svg: ICON_CARD_EMPTY },
	{ id: "new", icon: "file-plus", label: "New note — drag to create & embed a note", svg: ICON_CARD_NEW },
	{ id: "existing", icon: "file-search", label: "Existing note — drag, then pick a note", svg: ICON_CARD_EXISTING },
];

class CanvasToolbar {
	tool: ToolId = "select";
	markerMode: MarkerMode = "draw";
	cardMode: CardMode = "empty";
	/** Flow A: the note chosen in "Existing note" mode, waiting to be placed by a drag. */
	pendingExistingFile: TFile | null = null;
	/** The image chosen/uploaded in the Image tool, waiting to be placed by a drag. */
	pendingImageFile: TFile | null = null;
	/** Natural pixel size of the pending image, for aspect-correct click placement. */
	pendingImageDims: { w: number; h: number } | null = null;
	markerColor: string;
	highlightColor: string = HIGHLIGHT_PALETTE[3]; // classic yellow
	markerSize: number;
	tapePattern = TAPE_PATTERNS[0].id;
	textSize: number; // default font size for new text (resize scales it after)
	activeTextEditor: TextEditorHandle | null = null;

	/** This view's document (stable across popout windows) for global listeners. */
	private get doc(): Document {
		return this.view.containerEl.ownerDocument;
	}

	private barEl: HTMLElement;
	private subBarEl: HTMLElement | null = null;
	private sizeSectionEl: HTMLElement | null = null;
	private styleSectionEl: HTMLElement | null = null;
	private sizePopupEl: HTMLElement | null = null;
	private cardSearchEl: HTMLElement | null = null;
	private cardSearchOutside: ((e: PointerEvent) => void) | null = null;
	private overlay: ToolOverlay | null = null;
	private buttons = new Map<ToolId, HTMLElement>();
	private keyHandler: (e: KeyboardEvent) => void;
	private selectionObserver: MutationObserver | null = null;
	private contextmenuHandler: ((e: MouseEvent) => void) | null = null;

	constructor(public plugin: CanvasPencilPlugin, public view: CanvasViewLike) {
		this.markerColor = plugin.settings.strokeColor;
		this.markerSize = plugin.settings.strokeSize;
		this.textSize = plugin.settings.textSize;

		const wrapper = this.view.canvas!.wrapperEl;
		this.barEl = wrapper.createDiv({ cls: "canvas-pencil-bar" });
		for (const t of TOOLS) {
			const btn = this.barEl.createDiv({
				cls: "canvas-pencil-tool",
				attr: { "aria-label": t.label },
			});
			if (t.svg) setSvg(btn, t.svg);
			else setIcon(btn, t.icon);
			btn.addEventListener("click", () => this.setTool(t.id));
			this.buttons.set(t.id, btn);
		}
		this.buttons.get("select")!.addClass("is-active");
		this.updateMarkerToolIcon();
		this.applyScale();
		// Hovering the toolbar hides the cursor-following hint so it doesn't overlap.
		this.barEl.addEventListener("pointerenter", () => this.overlay?.hideHint());

		this.keyHandler = (e: KeyboardEvent) => {
			if (
				this.view.containerEl.ownerDocument.activeElement?.closest(
					".canvas-node, input, textarea, [contenteditable=true]"
				)
			)
				return;
			if (!this.view.containerEl.contains(e.target as Node)) return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if (e.key === "Escape" && this.tool !== "select") {
				this.setTool("select");
				e.preventDefault();
				return;
			}
			const t = TOOLS.find((t) => t.key === e.key.toLowerCase());
			if (t) {
				this.setTool(t.id);
				e.preventDefault();
			}
		};
		this.view.containerEl.addEventListener("keydown", this.keyHandler, true);

		// Selection changes (is-selected / is-focused toggling on a node) otherwise
		// only show up in the 1.2s sweep. Watch the node class attributes and
		// refresh in the SAME microtask — before the browser paints — so the
		// empty-card buttons appear instantly AND the table's menu-hiding class is
		// in place before Obsidian's popup can flash on screen.
		const wrap = this.view.canvas!.wrapperEl;
		this.selectionObserver = new MutationObserver((records) => {
			for (const r of records) {
				const t = r.target as HTMLElement;
				if (!t.classList?.contains("canvas-node")) continue;
				const had = /is-selected|is-focused/.test(r.oldValue || "");
				const has =
					t.classList.contains("is-selected") || t.classList.contains("is-focused");
				if (had !== has) {
					this.scheduleRefresh();
					return;
				}
			}
		});
		this.selectionObserver.observe(wrap, {
			attributes: true,
			attributeFilter: ["class"],
			attributeOldValue: true,
			subtree: true,
		});

		// Right-clicking while editing text should finish editing. Obsidian/Advanced
		// Canvas swallows `contextmenu` on the textarea itself, so commit from a
		// document-level capture listener whenever a text editor is active.
		this.contextmenuHandler = () => this.activeTextEditor?.commit();
		this.doc.addEventListener("contextmenu", this.contextmenuHandler, true);

		this.refreshNodeStyles();
	}

	private refreshScheduled = false;
	/** Coalesce refreshes to one per microtask (runs before paint → no flash). */
	private scheduleRefresh() {
		if (this.refreshScheduled) return;
		this.refreshScheduled = true;
		queueMicrotask(() => {
			this.refreshScheduled = false;
			this.refreshNodeStyles();
		});
	}

	/** Scale the toolbar per the user's setting (anchored top-center). */
	applyScale() {
		const s = this.plugin.settings.toolbarScale || 1;
		this.barEl.setCssStyles({ transformOrigin: "top center" });
		this.barEl.style.transform = `translateX(-50%) scale(${s})`;
	}

	setTool(tool: ToolId) {
		if (tool === this.tool && tool !== "select") return;
		this.activeTextEditor?.commit();
		this.overlay?.destroy();
		this.overlay = null;
		this.hideSubBar();
		this.closeCardSearch();
		this.pendingExistingFile = null;
		this.pendingImageFile = null;

		this.tool = tool;
		for (const [id, btn] of this.buttons) btn.toggleClass("is-active", id === tool);
		this.updateMarkerToolIcon();
		this.applyToolCursor();

		if (tool === "marker") {
			this.overlay = new MarkerOverlay(this);
			this.showMarkerSubBar();
		} else if (tool === "text") {
			this.overlay = new TextEditOverlay(this);
		} else if (tool === "card") {
			this.overlay = new DragCreateOverlay(this, "card");
			this.showCardSubBar();
		} else if (tool === "image") {
			this.overlay = new DragCreateOverlay(this, "image");
			this.openImagePicker();
		} else if (tool !== "select") {
			this.overlay = new DragCreateOverlay(this, tool);
		}
	}

	/**
	 * The first toolbar button always shows the LAST-USED draw sub-mode (marker /
	 * highlighter / washi / eraser) — there's no separate "draw kit" icon. So on a
	 * fresh canvas it shows the marker, and it remembers whatever the user last
	 * picked even after switching to other tools.
	 */
	private updateMarkerToolIcon() {
		const btn = this.buttons.get("marker");
		if (!btn) return;
		const mode = MARKER_MODES.find((m) => m.id === this.markerMode);
		if (mode?.svg) setSvg(btn, mode.svg);
		else setIcon(btn, mode?.icon ?? "pencil");
	}

	/**
	 * Replace the canvas cursor with the active tool's icon. For the marker tool
	 * the cursor tracks the active sub-mode (marker / highlighter / washi / eraser)
	 * with the hotspot near the nib; other tools point from the top-left.
	 */
	private applyToolCursor() {
		const wrap = this.view.canvas!.wrapperEl;
		if (this.tool === "marker") {
			const svg = MARKER_MODES.find((m) => m.id === this.markerMode)?.svg;
			if (!svg) {
				wrap.setCssStyles({ cursor: "auto" });
			} else if (this.markerMode === "erase") {
				wrap.style.cursor = svgToCursor(svg, 12, 12, this.iconSizePx()); // upright
			} else {
				// Nib points southwest: washi sits at 30°; marker/highlighter are
				// flipped a further 180° (their tip starts at the opposite end).
				const rot = this.markerMode === "tape" ? 30 : 210;
				wrap.style.cursor = svgToCursor(svg, 7, 21, this.iconSizePx(), rot);
			}
			return;
		}
		// text / card / frame / table use a simple crosshair; select is default.
		wrap.style.cursor = this.tool === "select" ? "auto" : "crosshair";
	}

	/** Match the cursor to the toolbar's rendered icon size (falls back to 18px). */
	private iconSizePx(): number {
		const svg = this.barEl.querySelector(".canvas-pencil-tool svg");
		const w = svg ? (svg as SVGElement).getBoundingClientRect().width : 0;
		return w >= 8 ? Math.round(w) : 18;
	}

	setMarkerMode(mode: MarkerMode) {
		this.markerMode = mode;
		this.updateMarkerToolIcon();
		(this.overlay as MarkerOverlay | null)?.onModeChange?.();
		this.subBarEl
			?.querySelectorAll(".canvas-pencil-mode-btn")
			.forEach((el, i) => el.toggleClass("is-active", MARKER_MODES[i].id === mode));
		this.renderStyleSection();
		this.applyToolCursor();

		// Eraser greys out size + style; washi tape only greys out the size slider
		// (its width comes from the drag, not the stroke size).
		const sizeDisabled = mode === "erase" || mode === "tape";
		const styleDisabled = mode === "erase";
		this.sizeSectionEl?.toggleClass("is-disabled", sizeDisabled);
		this.styleSectionEl?.toggleClass("is-disabled", styleDisabled);
		if (sizeDisabled) {
			this.sizePopupEl?.remove();
			this.sizePopupEl = null;
		}
	}

	revertToSelect() {
		this.setTool("select");
	}

	/**
	 * iPad: the on-screen keyboard scrolls the app (window and/or workspace
	 * ancestors) to keep the caret visible and doesn't always scroll it back,
	 * leaving the toolbar off-screen. Re-pin everything once editing ends —
	 * repeated on a timer to outlast the keyboard's hide animation.
	 */
	restoreViewportPosition() {
		const pin = () => {
			const win = this.doc.defaultView;
			win?.scrollTo(0, 0);
			let el: HTMLElement | null = this.view.canvas?.wrapperEl ?? null;
			while (el) {
				if (el.scrollTop) el.scrollTop = 0;
				if (el.scrollLeft) el.scrollLeft = 0;
				el = el.parentElement;
			}
		};
		pin();
		window.setTimeout(pin, 300);
		window.setTimeout(pin, 700);
	}

	// --- marker sub toolbar: [modes] | [size] | [colors or tape patterns] ---

	private showMarkerSubBar() {
		const sub = (this.subBarEl = this.view.canvas!.wrapperEl.createDiv({
			cls: "canvas-pencil-subbar",
		}));
		sub.addEventListener("pointerenter", () => this.overlay?.hideHint());

		const modes = sub.createDiv({ cls: "canvas-pencil-section" });
		for (const m of MARKER_MODES) {
			const btn = modes.createDiv({
				cls: "canvas-pencil-mode canvas-pencil-mode-btn",
				attr: { "aria-label": m.label },
			});
			if (m.svg) setSvg(btn, m.svg);
			else setIcon(btn, m.icon);
			if (m.id === this.markerMode) btn.addClass("is-active");
			btn.addEventListener("click", () => this.setMarkerMode(m.id));
		}

		sub.createDiv({ cls: "canvas-pencil-divider" });

		this.sizeSectionEl = sub.createDiv({ cls: "canvas-pencil-section" });
		const sizeBtn = this.sizeSectionEl.createDiv({
			cls: "canvas-pencil-mode",
			attr: { "aria-label": "Stroke size" },
		});
		setIcon(sizeBtn, "sliders-horizontal");
		sizeBtn.addEventListener("click", () => this.toggleSizePopup(sizeBtn));

		sub.createDiv({ cls: "canvas-pencil-divider" });

		this.styleSectionEl = sub.createDiv({
			cls: "canvas-pencil-section canvas-pencil-swatches",
		});
		this.renderStyleSection();

		// Apply the remembered mode's disabled state up front — eraser has no stroke
		// width (and no color), tape has no stroke width.
		const sizeDisabled = this.markerMode === "erase" || this.markerMode === "tape";
		this.sizeSectionEl.toggleClass("is-disabled", sizeDisabled);
		this.styleSectionEl.toggleClass("is-disabled", this.markerMode === "erase");
	}

	// --- card sub toolbar: [empty | new note | existing note] ---

	private showCardSubBar() {
		const sub = (this.subBarEl = this.view.canvas!.wrapperEl.createDiv({
			cls: "canvas-pencil-subbar",
		}));
		sub.addEventListener("pointerenter", () => this.overlay?.hideHint());
		const modes = sub.createDiv({ cls: "canvas-pencil-section" });
		for (const m of CARD_MODES) {
			const btn = modes.createDiv({
				cls: "canvas-pencil-mode canvas-pencil-mode-btn",
				attr: { "aria-label": m.label },
			});
			if (m.svg) setSvg(btn, m.svg);
			else setIcon(btn, m.icon);
			if (m.id === this.cardMode) btn.addClass("is-active");
			btn.addEventListener("click", () => this.setCardMode(m.id));
		}
	}

	setCardMode(mode: CardMode) {
		this.cardMode = mode;
		this.subBarEl
			?.querySelectorAll(".canvas-pencil-mode-btn")
			.forEach((el, i) => el.toggleClass("is-active", CARD_MODES[i].id === mode));
		// Flow A: choosing "Existing note" opens the picker right away. Once a note
		// is picked it's held in pendingExistingFile and dropped by the next drag.
		this.pendingExistingFile = null;
		this.closeCardSearch();
		if (mode === "existing") this.openExistingNotePicker();
	}

	/**
	 * Create a new markdown note next to the canvas and embed it as a file card.
	 * Used by the "New note" card mode (drag) — Obsidian's own createFileNode does
	 * the embedding, so we add no new persistence surface.
	 */
	async createNoteCardAt(
		pos: { x: number; y: number },
		size: { width: number; height: number }
	) {
		const canvas = this.view.canvas;
		const file = await this.makeNewNote();
		if (!file || !canvas) return;
		if (typeof canvas.createFileNode !== "function") {
			new Notice("Canvas Kit: this Obsidian version can't embed notes here.");
			return;
		}
		try {
			canvas.createFileNode({ pos, size, file, save: true, focus: true });
			canvas.requestSave?.();
			pushCanvasHistory(canvas);
		} catch (err) {
			console.error("Canvas Kit: couldn't embed new note", err);
			new Notice("Canvas Kit: couldn't embed the new note.");
		}
	}

	/** Create a uniquely-named empty note in the canvas's folder (vault root fallback). */
	private async makeNewNote(): Promise<TFile | null> {
		const app = this.plugin.app;
		const folder = (this.view as unknown as { file?: TFile }).file?.parent?.path ?? "";
		const join = (n: string) => (folder && folder !== "/" ? `${folder}/${n}.md` : `${n}.md`);
		let name = "Untitled";
		let i = 0;
		while (app.vault.getAbstractFileByPath(join(name))) name = `Untitled ${++i}`;
		try {
			return await app.vault.create(join(name), "");
		} catch (err) {
			console.error("Canvas Kit: couldn't create note", err);
			new Notice("Canvas Kit: couldn't create the note.");
			return null;
		}
	}

	/** Swap an empty card for a file card pointing at `file`, keeping its box. */
	private replaceCardWithFile(node: CanvasNodeLike, file: TFile) {
		const canvas = this.view.canvas;
		if (!canvas) return;
		if (typeof canvas.createFileNode !== "function") {
			new Notice("Canvas Kit: this Obsidian version can't embed notes here.");
			return;
		}
		const d = node.getData?.() ?? {};
		const pos = { x: Number(d.x) || node.x || 0, y: Number(d.y) || node.y || 0 };
		const size = {
			width: Number(d.width) || node.width || 320,
			height: Number(d.height) || node.height || 180,
		};
		try {
			canvas.removeNode?.(node);
			canvas.createFileNode({ pos, size, file, save: true, focus: true });
			canvas.requestSave?.();
			pushCanvasHistory(canvas);
		} catch (err) {
			console.error("Canvas Kit: couldn't embed note", err);
			new Notice("Canvas Kit: couldn't embed the note.");
		}
	}

	/**
	 * Inline note picker — the search lands where the user is already looking,
	 * instead of the bottom-bar → top-search round trip Obsidian forces. `anchor`
	 * is in wrapper-local coords; `onPick` receives the chosen note.
	 */
	private openNoteSearch(
		anchor: { left: number; top: number },
		onPick: (file: TFile) => void
	) {
		this.closeCardSearch();
		const canvas = this.view.canvas;
		if (!canvas) return;
		const wrap = canvas.wrapperEl;
		const pop = (this.cardSearchEl = wrap.createDiv({ cls: "canvas-pencil-card-search" }));
		const input = pop.createEl("input", {
			type: "text",
			attr: { placeholder: "Search notes…", spellcheck: "false" },
		});
		const list = pop.createDiv({ cls: "canvas-pencil-card-search-list" });
		const files = this.plugin.app.vault.getMarkdownFiles();
		const render = (q: string) => {
			list.empty();
			const ql = q.toLowerCase();
			const matches = (ql
				? files.filter((f) => f.path.toLowerCase().includes(ql))
				: files
			).slice(0, 8);
			if (!matches.length) {
				list.createDiv({ cls: "canvas-pencil-card-search-empty", text: "No notes found" });
				return;
			}
			for (const f of matches) {
				const item = list.createDiv({ cls: "canvas-pencil-card-search-item" });
				item.createSpan({ cls: "canvas-pencil-card-search-name", text: f.basename });
				const dir = f.parent?.path;
				if (dir && dir !== "/") {
					item.createSpan({ cls: "canvas-pencil-card-search-path", text: dir });
				}
				item.addEventListener("pointerdown", (e) => e.preventDefault());
				item.addEventListener("click", () => {
					this.closeCardSearch();
					onPick(f);
				});
			}
		};
		render("");
		input.addEventListener("input", () => render(input.value));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				this.closeCardSearch();
			} else if (e.key === "Enter") {
				e.preventDefault();
				(list.querySelector<HTMLElement>(".canvas-pencil-card-search-item"))?.click();
			}
		});

		pop.style.left = `${anchor.left}px`;
		pop.style.top = `${anchor.top}px`;

		// Dismiss on any click outside the popup.
		this.cardSearchOutside = (e: PointerEvent) => {
			if (!pop.contains(e.target as Node)) this.closeCardSearch();
		};
		window.setTimeout(() => {
			this.doc.addEventListener("pointerdown", this.cardSearchOutside!, true);
			input.focus();
		}, 0);
	}

	/** Empty-card affordance: pick a note → swap this card for that file embed. */
	openExistingNoteSearch(node: CanvasNodeLike) {
		const canvas = this.view.canvas;
		const el = node.nodeEl;
		if (!canvas || !el) return;
		const nodeRect = el.getBoundingClientRect();
		const wrapRect = canvas.wrapperEl.getBoundingClientRect();
		this.openNoteSearch(
			{ left: nodeRect.left - wrapRect.left, top: nodeRect.top - wrapRect.top },
			(f) => this.replaceCardWithFile(node, f)
		);
	}

	/**
	 * Flow A ("Existing note" mode): open the picker under the sub-bar. The chosen
	 * note is held in pendingExistingFile; the next drag drops it as a file card.
	 */
	private openExistingNotePicker() {
		const canvas = this.view.canvas;
		if (!canvas) return;
		const wrapRect = canvas.wrapperEl.getBoundingClientRect();
		let left = wrapRect.width / 2 - 130;
		let top = 100;
		if (this.subBarEl) {
			const r = this.subBarEl.getBoundingClientRect();
			left = r.left - wrapRect.left;
			top = r.bottom - wrapRect.top + 8;
		}
		this.openNoteSearch({ left, top }, (f) => {
			this.pendingExistingFile = f;
			new Notice(`Drag (or click) to place "${f.basename}"`);
		});
	}

	/** Embed an already-chosen note as a file card at the dragged box. */
	placeExistingFile(
		pos: { x: number; y: number },
		size: { width: number; height: number },
		file: TFile
	) {
		const canvas = this.view.canvas;
		if (!canvas) return;
		if (typeof canvas.createFileNode !== "function") {
			new Notice("Canvas Kit: this Obsidian version can't embed notes here.");
			return;
		}
		try {
			canvas.createFileNode({ pos, size, file, save: true, focus: true });
			canvas.requestSave?.();
			pushCanvasHistory(canvas);
		} catch (err) {
			console.error("Canvas Kit: couldn't embed note", err);
			new Notice("Canvas Kit: couldn't embed the note.");
		}
	}

	private closeCardSearch() {
		if (this.cardSearchOutside) {
			this.doc.removeEventListener("pointerdown", this.cardSearchOutside, true);
			this.cardSearchOutside = null;
		}
		this.cardSearchEl?.remove();
		this.cardSearchEl = null;
	}

	// --- image tool: previewable search + desktop upload ---

	private static IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

	/**
	 * Previewable image picker (thumbnail grid of vault images + an Upload button)
	 * anchored under the toolbar. Picking or uploading arms `pendingImageFile`; the
	 * next drag/click on the canvas drops it as an image card. Fills the gap in
	 * Obsidian's own add-image flow (name-only search, no desktop upload).
	 */
	openImagePicker() {
		this.closeCardSearch();
		const canvas = this.view.canvas;
		if (!canvas) return;
		const wrap = canvas.wrapperEl;
		const pop = (this.cardSearchEl = wrap.createDiv({
			cls: "canvas-pencil-card-search canvas-pencil-image-picker",
		}));
		pop.addEventListener("pointerdown", (e) => e.stopPropagation());

		const top = pop.createDiv({ cls: "canvas-pencil-image-top" });
		const input = top.createEl("input", {
			type: "text",
			attr: { placeholder: "Search images…", spellcheck: "false" },
		});
		const uploadBtn = top.createEl("button", {
			cls: "canvas-pencil-image-upload",
			text: "Upload",
		});
		const grid = pop.createDiv({ cls: "canvas-pencil-image-grid" });

		const arm = (file: TFile, dims: { w: number; h: number } | null) => {
			this.pendingImageFile = file;
			this.pendingImageDims = dims;
			this.closeCardSearch();
			new Notice(`Drag (or click) to place "${file.name}"`);
		};

		const images = this.plugin.app.vault
			.getFiles()
			.filter((f) => CanvasToolbar.IMAGE_EXTS.includes(f.extension.toLowerCase()));
		const render = (q: string) => {
			grid.empty();
			const ql = q.toLowerCase();
			const matches = (ql ? images.filter((f) => f.path.toLowerCase().includes(ql)) : images).slice(
				0,
				24
			);
			if (!matches.length) {
				grid.createDiv({ cls: "canvas-pencil-card-search-empty", text: "No images found" });
				return;
			}
			for (const f of matches) {
				const cell = grid.createDiv({
					cls: "canvas-pencil-image-cell",
					attr: { "aria-label": f.name },
				});
				const img = cell.createEl("img");
				img.src = this.plugin.app.vault.getResourcePath(f);
				img.addEventListener("pointerdown", (e) => e.preventDefault());
				cell.addEventListener("click", () =>
					arm(f, img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null)
				);
			}
		};
		render("");
		input.addEventListener("input", () => render(input.value));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				this.closeCardSearch();
			}
		});
		uploadBtn.addEventListener("click", () => this.pickImageUpload(arm));

		const br = this.barEl.getBoundingClientRect();
		const wr = wrap.getBoundingClientRect();
		pop.style.left = `${Math.max(8, br.left - wr.left)}px`;
		pop.style.top = `${br.bottom - wr.top + 10}px`;

		this.cardSearchOutside = (e: PointerEvent) => {
			if (!pop.contains(e.target as Node)) this.closeCardSearch();
		};
		window.setTimeout(() => {
			this.doc.addEventListener("pointerdown", this.cardSearchOutside!, true);
			input.focus();
		}, 0);
	}

	/** Import a desktop image into the vault (attachment folder), then arm it. */
	private pickImageUpload(arm: (file: TFile, dims: { w: number; h: number } | null) => void) {
		const fileInput = createEl("input", { type: "file", attr: { accept: "image/*" } });
		fileInput.addEventListener("change", () => void (async () => {
			const f = fileInput.files?.[0];
			if (!f) return;
			try {
				const buf = await f.arrayBuffer();
				const fm = this.plugin.app.fileManager as unknown as {
					getAvailablePathForAttachment?: (n: string, src?: string) => Promise<string>;
				};
				const src = (this.view as unknown as { file?: TFile }).file?.path ?? "";
				const path =
					(await fm.getAvailablePathForAttachment?.(f.name, src)) ?? f.name;
				const tfile = await this.plugin.app.vault.createBinary(path, buf);
				// Read natural size off the bytes so click-placement keeps aspect.
				const url = URL.createObjectURL(f);
				const probe = new Image();
				probe.onload = () => {
					URL.revokeObjectURL(url);
					arm(tfile, { w: probe.naturalWidth, h: probe.naturalHeight });
				};
				probe.onerror = () => {
					URL.revokeObjectURL(url);
					arm(tfile, null);
				};
				probe.src = url;
			} catch (err) {
				console.error("Canvas Kit: couldn't upload image", err);
				new Notice("Canvas Kit: couldn't upload that image.");
			}
		})());
		fileInput.click();
	}

	/** Embed the armed image as a file card at the dragged box (aspect-correct). */
	placeImageFile(
		pos: { x: number; y: number },
		size: { width: number; height: number },
		file: TFile,
		dims: { w: number; h: number } | null
	) {
		const canvas = this.view.canvas;
		if (!canvas) return;
		if (typeof canvas.createFileNode !== "function") {
			new Notice("Canvas Kit: this Obsidian version can't embed images here.");
			return;
		}
		try {
			canvas.createFileNode({ pos, size, file, save: true, focus: true });
			canvas.requestSave?.();
			pushCanvasHistory(canvas);
		} catch (err) {
			console.error("Canvas Kit: couldn't embed image", err);
			new Notice("Canvas Kit: couldn't embed the image.");
		}
	}

	/**
	 * Mount the [+] (new note) / embed (existing note) affordance just outside an
	 * empty card's top-left, so a blank card can become a note without redrawing.
	 */
	private mountCardActions(node: CanvasNodeLike, el: HTMLElement) {
		el.addClass("canvas-pencil-has-actions"); // lets the affordance overflow the card
		if (el.querySelector(":scope > .canvas-pencil-card-actions")) return;
		const bar = el.createDiv({ cls: "canvas-pencil-card-actions" });
		const stop = (e: Event) => e.stopPropagation();
		bar.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			stop(e);
		});
		bar.addEventListener("mousedown", stop);

		const plus = bar.createDiv({
			cls: "canvas-pencil-card-action",
			attr: { "aria-label": "Turn into a new note" },
		});
		setIcon(plus, "file-plus");
		plus.addEventListener("click", (e) => void (async () => {
			stop(e);
			const file = await this.makeNewNote();
			if (file) this.replaceCardWithFile(node, file);
		})());

		const append = bar.createDiv({
			cls: "canvas-pencil-card-action",
			attr: { "aria-label": "Embed an existing note" },
		});
		setIcon(append, "file-search");
		append.addEventListener("click", (e) => {
			stop(e);
			this.openExistingNoteSearch(node);
		});
	}

	private unmountCardActions(el: HTMLElement) {
		el.removeClass("canvas-pencil-has-actions");
		el.querySelector(":scope > .canvas-pencil-card-actions")?.remove();
	}

	/** Third sub-bar section: colors for draw/highlight, patterns for tape. */
	private renderStyleSection() {
		const el = this.styleSectionEl;
		if (!el) return;
		el.empty();

		if (this.markerMode === "tape") {
			for (const p of TAPE_PATTERNS) {
				const sw = el.createDiv({
					cls: "canvas-pencil-swatch",
					attr: { "aria-label": p.label, style: p.swatchCss },
				});
				if (this.tapePattern === p.id) sw.addClass("is-active");
				sw.addEventListener("click", () => {
					this.tapePattern = p.id;
					this.markStyleActive(el, sw);
				});
			}
			this.renderCustomTapeSlot(el);
		} else {
			// Marker and highlighter keep separate palettes and remembered colors.
			const highlight = this.markerMode === "highlight";
			const palette = highlight ? HIGHLIGHT_PALETTE : PALETTE;
			const current = highlight ? this.highlightColor : this.markerColor;
			const setColor = (c: string) => {
				if (highlight) this.highlightColor = c;
				else this.markerColor = c;
			};
			for (const c of palette) {
				const sw = el.createDiv({ cls: "canvas-pencil-swatch" });
				sw.style.backgroundColor = c;
				if (c.toLowerCase() === current.toLowerCase()) sw.addClass("is-active");
				sw.addEventListener("click", () => {
					setColor(c);
					this.markStyleActive(el, sw);
				});
			}
			const wheel = el.createDiv({
				cls: "canvas-pencil-wheel",
				attr: { "aria-label": "Custom color" },
			});
			const picker = wheel.createEl("input", { type: "color" });
			picker.value = /^#[0-9a-f]{6}$/i.test(current) ? current : "#1e1e1e";
			picker.addEventListener("input", () => {
				setColor(picker.value);
				this.markStyleActive(el, wheel);
			});
			if (!palette.some((c) => c.toLowerCase() === current.toLowerCase())) {
				this.markStyleActive(el, wheel);
			}
		}
	}

	private markStyleActive(section: HTMLElement, active: HTMLElement) {
		section
			.querySelectorAll(".canvas-pencil-swatch, .canvas-pencil-wheel, .canvas-pencil-tape-custom")
			.forEach((e) => e.removeClass("is-active"));
		active.addClass("is-active");
	}

	private renderCustomTapeSlot(section: HTMLElement) {
		const image = this.plugin.settings.tapeImage;
		const slot = section.createDiv({
			cls: "canvas-pencil-tape-custom",
			attr: {
				"aria-label": image
					? "Your tape image (click again to replace)"
					: "Add your own tape image",
			},
		});
		if (image) {
			slot.style.backgroundImage = `url("${image}")`;
			if (this.tapePattern === CUSTOM_TAPE_ID) slot.addClass("is-active");
			slot.addEventListener("click", () => {
				// First click selects; clicking while selected opens the picker to replace.
				if (this.tapePattern === CUSTOM_TAPE_ID) {
					this.pickTapeImage(section);
				} else {
					this.tapePattern = CUSTOM_TAPE_ID;
					this.markStyleActive(section, slot);
				}
			});
		} else {
			setIcon(slot, "plus");
			slot.addEventListener("click", () => this.pickTapeImage(section));
		}
	}

	private pickTapeImage(section: HTMLElement) {
		const input = createEl("input", { type: "file", attr: { accept: "image/*" } });
		input.addEventListener("change", () => {
			const f = input.files?.[0];
			if (!f) return;
			const url = URL.createObjectURL(f);
			const img = new Image();
			img.onload = () => {
				URL.revokeObjectURL(url);
				// Downscale to a small square tile so the canvas file stays light.
				const TILE = 96;
				const c = activeDocument.createElement("canvas");
				c.width = c.height = TILE;
				const ctx = c.getContext("2d")!;
				const s = Math.max(TILE / img.width, TILE / img.height);
				const dw = img.width * s;
				const dh = img.height * s;
				ctx.drawImage(img, (TILE - dw) / 2, (TILE - dh) / 2, dw, dh);
				this.plugin.settings.tapeImage = c.toDataURL("image/jpeg", 0.8);
				void this.plugin.saveSettings();
				this.tapePattern = CUSTOM_TAPE_ID;
				this.renderStyleSection();
			};
			img.onerror = () => {
				URL.revokeObjectURL(url);
				new Notice("Canvas Kit: couldn't read that image.");
			};
			img.src = url;
		});
		input.click();
	}

	private toggleSizePopup(anchor: HTMLElement) {
		if (this.sizePopupEl) {
			this.sizePopupEl.remove();
			this.sizePopupEl = null;
			return;
		}
		const pop = (this.sizePopupEl = this.view.canvas!.wrapperEl.createDiv({
			cls: "canvas-pencil-size-popup",
		}));
		const slider = pop.createEl("input", {
			type: "range",
			attr: { min: "2", max: "30", step: "1", "aria-label": "Stroke size" },
		});
		slider.value = String(this.markerSize);
		const preview = pop.createDiv({ cls: "canvas-pencil-size-preview" });
		const updatePreview = () => {
			const d = Math.max(3, Math.min(26, this.markerSize));
			preview.style.width = preview.style.height = `${d}px`;
		};
		updatePreview();
		slider.addEventListener("input", () => {
			this.markerSize = Number(slider.value);
			updatePreview();
		});
		const wrapRect = this.view.canvas!.wrapperEl.getBoundingClientRect();
		const btnRect = anchor.getBoundingClientRect();
		pop.style.left = `${btnRect.left + btnRect.width / 2 - wrapRect.left}px`;
		// Toolbar is at the top, so the popup opens downward from the button.
		pop.style.top = `${btnRect.bottom - wrapRect.top + 10}px`;
	}

	/**
	 * Mount a transparent, auto-growing textarea over the canvas (Excalidraw-style).
	 * On commit the text is written to a frameless markdown node. Padding scales
	 * with the font so it matches how the committed node is sized.
	 */
	openTextEditor(
		origin: { x: number; y: number },
		fontSize: number,
		color: string | null,
		existingNode: CanvasNodeLike | null,
		initialText: string,
		onClose?: () => void
	) {
		const canvas = this.view.canvas;
		if (
			!canvas ||
			typeof canvas.posFromEvt !== "function" ||
			typeof canvas.createTextNode !== "function"
		)
			return;
		this.activeTextEditor?.commit();

		const t = canvasTransform(canvas);
		const screen = {
			x: t.rect.left + (origin.x - t.originWorld.x) * t.zoom,
			y: t.rect.top + (origin.y - t.originWorld.y) * t.zoom,
		};
		const curColor = color || "var(--text-normal)";
		const curSize = fontSize;

		const ta = canvas.wrapperEl.createEl("textarea", {
			cls: "canvas-pencil-text-editor",
		});
		ta.value = initialText;
		ta.wrap = "off";
		ta.spellcheck = false;
		ta.style.left = `${screen.x - t.rect.left}px`;
		ta.style.top = `${screen.y - t.rect.top}px`;
		ta.style.fontFamily = TEXT_FONT;
		ta.style.lineHeight = String(TEXT_LINE_HEIGHT);
		ta.style.color = curColor;
		ta.style.caretColor = curColor;
		const px = curSize * t.zoom;
		ta.style.fontSize = `${px}px`;
		ta.style.padding = `${TEXT_PAD_EM}em`; // scales with the font size

		const grow = () => {
			const lines = ta.value.length ? ta.value.split("\n") : [""];
			const tw = measureTextLines(lines, px);
			// extra slack so the caret never wraps the last glyph
			ta.style.width = `${Math.ceil(tw + px * 0.6 + 2)}px`;
			ta.style.height = `${Math.ceil(lines.length * px * TEXT_LINE_HEIGHT)}px`;
		};
		grow();
		ta.addEventListener("input", grow);
		// Swallow pointer events so clicks in the editor don't pan/deselect the canvas.
		ta.addEventListener("pointerdown", (e) => e.stopPropagation());
		ta.addEventListener("mousedown", (e) => e.stopPropagation());

		let committed = false;
		const handle: TextEditorHandle = {
			commit: () => {
				if (committed) return;
				committed = true;
				const val = ta.value;
				ta.remove();
				if (this.activeTextEditor === handle) this.activeTextEditor = null;
				let target: CanvasNodeLike | null = null;
				try {
					const empty = !val.trim();
					const md = textToMarkdown(val);
					if (existingNode) {
						if (empty) {
							canvas.removeNode?.(existingNode);
						} else {
							// Update the markdown + box in place so node id / links survive.
							const box = textBox(val, curSize, origin);
							setNodeText(existingNode, md);
							tagTextNode(existingNode, curSize, box);
							const resizable = existingNode as unknown as {
								moveAndResize?: (r: TextBox) => void;
							};
							resizable.moveAndResize?.(box);
							if (existingNode.nodeEl) existingNode.nodeEl.setCssStyles({ visibility: "" });
							target = existingNode;
						}
					} else if (!empty) {
						const box = textBox(val, curSize, origin);
						const node = canvas.createTextNode?.({
							pos: { x: box.x, y: box.y },
							size: { width: box.width, height: box.height },
							text: md,
							save: true,
							focus: false,
						});
						if (node) tagTextNode(node, curSize, box);
						target = node ?? null;
						canvas.deselectAll?.();
					}
					canvas.requestSave?.();
					pushCanvasHistory(canvas);
				} catch (err) {
					console.error("Canvas Kit: text commit failed", err);
					new Notice("Canvas Kit: couldn't save text.");
				}
				// The node mounts + renders async — re-assert frameless styling and
				// then fit the box to the actually-rendered glyphs.
				const settle = () => {
					this.refreshNodeStyles();
					if (target) this.fitTextNode(target);
				};
				this.refreshNodeStyles();
				window.requestAnimationFrame(settle);
				window.setTimeout(settle, 80);
				window.setTimeout(settle, 250);
				this.restoreViewportPosition();
				onClose?.();
			},
		};
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				handle.commit();
			}
		});
		// Right-click finishes editing (commit + leave the text tool), matching the
		// other tools' right-click-to-exit behaviour. We commit on right-BUTTON
		// mousedown (capture) because Obsidian/Advanced Canvas swallows the
		// `contextmenu` event before the textarea sees it; we still preventDefault
		// the contextmenu to suppress the native menu.
		ta.addEventListener(
			"mousedown",
			(e) => {
				if (e.button === 2) {
					e.preventDefault();
					e.stopPropagation();
					handle.commit();
				}
			},
			true
		);
		ta.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			handle.commit();
		});
		ta.addEventListener("blur", () => handle.commit());
		this.activeTextEditor = handle;
		window.setTimeout(() => {
			ta.focus();
			const len = ta.value.length;
			ta.setSelectionRange(len, len);
		}, 0);
	}

	/** Reopen a committed text node in the inline editor (hides it while editing). */
	editTextNode(node: CanvasNodeLike, el: HTMLElement, onClose?: () => void) {
		const meta = textMeta(node);
		// Show <br> line breaks back as real newlines in the editor.
		const text = markdownToText(typeof node.text === "string" ? node.text : "");
		// The node may have been resized → scaled; edit at the current displayed size.
		const w = Number(node.width) || meta.baseW;
		const size = meta.baseW > 0 ? meta.size * (w / meta.baseW) : meta.size;
		// Match the live text color (it rides Obsidian's node color).
		const view = el.querySelector<HTMLElement>(
			".markdown-preview-view, .markdown-rendered, .markdown-embed-content"
		);
		const color = view ? getComputedStyle(view).color : null;
		el.setCssStyles({ visibility: "hidden" });
		this.openTextEditor(
			{ x: node.x ?? 0, y: node.y ?? 0 },
			size,
			color,
			node,
			text,
			onClose
		);
	}

	/** Double-click a committed text node to reopen it in the inline editor. */
	bindTextReedit(node: CanvasNodeLike, el: HTMLElement) {
		if (el.dataset.cpTextEdit) return;
		el.dataset.cpTextEdit = "1";
		el.addEventListener(
			"dblclick",
			(e) => {
				e.preventDefault();
				e.stopImmediatePropagation();
				this.editTextNode(node, el);
			},
			true
		);
	}

	/** Hit-test for a committed text node under a world point (topmost wins). */
	findTextNodeAt(
		w: { x: number; y: number }
	): { node: CanvasNodeLike; el: HTMLElement } | null {
		const canvas = this.view.canvas;
		if (!canvas?.nodes) return null;
		let found: { node: CanvasNodeLike; el: HTMLElement } | null = null;
		for (const node of canvas.nodes.values()) {
			if (pencilKind(node) !== "text") continue;
			const { x, y, width, height } = node;
			if (
				x != null && y != null && width != null && height != null &&
				w.x >= x && w.x <= x + width && w.y >= y && w.y <= y + height &&
				node.nodeEl
			) {
				found = { node, el: node.nodeEl }; // later nodes are drawn on top
			}
		}
		return found;
	}

	private hideSubBar() {
		this.subBarEl?.remove();
		this.subBarEl = null;
		this.sizeSectionEl = null;
		this.styleSectionEl = null;
		this.sizePopupEl?.remove();
		this.sizePopupEl = null;
	}

	// --- node styling sweep ---

	private tableWidgets = new WeakMap<Element, TableWidget>();

	refreshNodeStyles() {
		const canvas = this.view.canvas;
		if (!canvas?.nodes) return;
		let tableSelected = false;
		for (const node of canvas.nodes.values()) {
			const el = node.nodeEl;
			if (!el) continue;
			const text = node.text;
			if (typeof text === "string" && text.startsWith("<svg") && text.includes(INK_MARK)) {
				el.addClass("canvas-pencil-ink");
				blockDblClick(el);
				// Never open raw SVG source. The toolbar's Edit button calls
				// startEditing — repurpose it to re-enter the marker tool so the
				// user can keep drawing (there's nothing to text-edit here).
				if (!el.dataset.cpNoEdit) {
					el.dataset.cpNoEdit = "1";
					try {
						node.startEditing = () => this.setTool("marker");
					} catch (err) {
						console.warn("Canvas Kit: couldn't hook ink editing", err);
					}
				}
				enforceInkVisual(el, text);
				// Re-assert the bare SVG the instant Obsidian re-renders the node,
				// so committed ink never flashes the padded markdown rendering.
				if (!el.dataset.cpObserved) {
					el.dataset.cpObserved = "1";
					const observer = new MutationObserver(() => enforceInkVisual(el, text));
					observer.observe(el, { childList: true, subtree: true });
				}
				this.lockInkAspect(node, text);
				continue;
			}
			const kind = pencilKind(node);
			if (kind === "text") {
				// Frameless markdown: chrome stripped by CSS (.canvas-pencil-text).
				// Text color rides Obsidian's own node color (--canvas-color), also
				// via CSS — so the native toolbar's color button colors the text.
				el.addClass("canvas-pencil-plain");
				el.addClass("canvas-pencil-text");
				// Resize = uniform scale: lock the box to the text's aspect ratio and
				// derive the font size from the box width, so text never clips.
				this.lockTextScale(node, el);
				// React live to resize drags — update only the font size (no setData,
				// so we don't fight Obsidian's drag); the sweep snaps height/aspect.
				if (!el.dataset.cpTextResize) {
					el.dataset.cpTextResize = "1";
					const ro = new ResizeObserver(() => {
						const m = textMeta(node);
						if (m.baseW <= 0) return;
						const w = Number(node.getData?.().width) || m.baseW;
						el.style.setProperty("--cp-text-size", `${m.size * (w / m.baseW)}px`);
					});
					ro.observe(el);
				}
				// Re-fit once so boxes saved before the tight-spacing CSS collapse to
				// hug the text (also corrects any stale height from earlier builds).
				if (!el.dataset.cpFitted) {
					el.dataset.cpFitted = "1";
					window.setTimeout(() => this.fitTextNode(node), 60);
				}
				// Route every edit path — the toolbar's Edit button, double-click,
				// Enter — to OUR inline textarea instead of Obsidian's raw editor.
				if (!el.dataset.cpNoEdit) {
					el.dataset.cpNoEdit = "1";
					try {
						node.startEditing = () => this.editTextNode(node, el);
					} catch (err) {
						console.warn("Canvas Kit: couldn't hook text editing", err);
					}
				}
				this.bindTextReedit(node, el);
			} else if (kind === "table") {
				el.addClass("canvas-pencil-plain");
				el.addClass("canvas-pencil-table");
				blockDblClick(el);
				// Tables must never open Obsidian's editor (raw markdown source).
				if (!el.dataset.cpNoEdit) {
					el.dataset.cpNoEdit = "1";
					try {
						node.startEditing = () => {};
					} catch (err) {
						console.warn("Canvas Kit: couldn't disable table editing", err);
					}
				}
				this.mountTableWidget(node, el);
				if (el.hasClass("is-focused") || el.hasClass("is-selected")) tableSelected = true;
			} else {
				// A plain Obsidian text card. While it's still empty, offer the
				// [+]/embed affordance so it can become a new/existing note in place;
				// once it has content (or isn't a text card), drop the affordance.
				const data = node.getData?.() ?? {};
				const txt =
					typeof node.text === "string"
						? node.text
						: typeof data.text === "string"
							? data.text
							: "";
				// Show the [+]/embed affordance only while an EMPTY card is selected
				// (not permanently on every blank card).
				const selected = el.hasClass("is-selected") || el.hasClass("is-focused");
				const emptyCard = data.type === "text" && !txt.trim();
				if (emptyCard && selected) this.mountCardActions(node, el);
				else this.unmountCardActions(el);
			}
		}
		// Flag "a table is selected" on the canvas wrapper so CSS can hide the
		// floating card menu (.canvas-card-menu) that would otherwise cover the
		// table's top column-reorder handles.
		canvas.wrapperEl.toggleClass("canvas-kit-table-selected", tableSelected);
	}

	/** Snap an ink node's box back to its drawing's aspect ratio after a resize. */
	private lockInkAspect(node: CanvasNodeLike, text: string) {
		const m = text.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/);
		if (!m || !node.getData || !node.setData) return;
		const aspect = Number(m[1]) / Number(m[2]);
		if (!isFinite(aspect) || aspect <= 0) return;
		try {
			const data = node.getData();
			const w = Number(data.width) || 0;
			const h = Number(data.height) || 0;
			if (w > 0 && h > 0 && Math.abs(w / h - aspect) / aspect > 0.02) {
				data.height = Math.max(1, Math.round(w / aspect));
				node.setData(data);
				this.view.canvas?.requestSave?.();
			}
		} catch (err) {
			console.warn("Canvas Kit: couldn't lock ink aspect", err);
		}
	}

	/**
	 * Uniform text scaling: the font size is driven by the box width relative to
	 * the text's base width, and the box height is locked to the base aspect
	 * ratio. So dragging any handle scales the whole thing — the box always hugs
	 * the text and nothing ever clips.
	 */
	private lockTextScale(node: CanvasNodeLike, el: HTMLElement) {
		const meta = textMeta(node);
		if (meta.baseW <= 0 || meta.baseH <= 0) {
			el.style.setProperty("--cp-text-size", `${meta.size}px`);
			return;
		}
		const aspect = meta.baseW / meta.baseH;
		try {
			const data = node.getData?.() ?? {};
			const w = Number(data.width) || meta.baseW;
			const h = Number(data.height) || meta.baseH;
			const fontSize = meta.size * (w / meta.baseW);
			el.style.setProperty("--cp-text-size", `${fontSize}px`);
			const wantH = Math.max(1, Math.round(w / aspect));
			if (node.setData && Math.abs(h - wantH) > 1) {
				data.height = wantH;
				node.setData(data);
				this.view.canvas?.requestSave?.();
			}
		} catch (err) {
			console.warn("Canvas Kit: couldn't scale text", err);
		}
	}

	/**
	 * Fit the node box to the ACTUALLY-rendered text (measured off the markdown
	 * preview, which knows real font/bold widths). Run once after a commit so the
	 * box hugs the glyphs exactly — like Photoshop point text. scrollWidth/Height
	 * are pre-transform layout pixels, i.e. already in world units.
	 */
	fitTextNode(node: CanvasNodeLike) {
		const el = node.nodeEl;
		if (!el || el.style.visibility === "hidden") return;
		// Measure the tight inner block (the sizer), not the flex-stretched preview.
		const view =
			el.querySelector<HTMLElement>(".markdown-preview-sizer") ??
			el.querySelector<HTMLElement>(
				".markdown-preview-view, .markdown-rendered, .markdown-embed-content"
			);
		if (!view) return;
		const w = Math.ceil(view.scrollWidth) + 1;
		const h = Math.ceil(view.scrollHeight) + 1;
		if (w < 2 || h < 2) return;
		const data = node.getData?.() ?? {};
		const cw = Number(data.width) || 0;
		const ch = Number(data.height) || 0;
		if (Math.abs(cw - w) <= 1 && Math.abs(ch - h) <= 1) return; // already fits
		const box: TextBox = { x: node.x ?? 0, y: node.y ?? 0, width: w, height: h };
		// scrollWidth/Height are measured at the CURRENT displayed font size, so
		// re-base to that size (not the original) to preserve any prior scaling.
		const meta = textMeta(node);
		const displayed = meta.baseW > 0 ? meta.size * (cw / meta.baseW) : meta.size;
		tagTextNode(node, displayed, box);
		(node as unknown as { moveAndResize?: (r: TextBox) => void }).moveAndResize?.(box);
		this.view.canvas?.requestSave?.();
	}

	/** Replace Obsidian's markdown preview of table nodes with our interactive table. */
	private mountTableWidget(node: CanvasNodeLike, el: HTMLElement) {
		if (el.hasClass("is-editing")) return;
		const content = el.querySelector<HTMLElement>(".canvas-node-content");
		if (!content) return;
		let widget = this.tableWidgets.get(content);
		if (!widget) {
			widget = new TableWidget(this, node, content, el);
			this.tableWidgets.set(content, widget);
			widget.render();
			return;
		}
		// Re-render on external text changes; rescale on node resize.
		widget.syncFromNode();
	}

	destroy() {
		this.overlay?.destroy();
		this.overlay = null;
		this.view.containerEl.removeEventListener("keydown", this.keyHandler, true);
		this.selectionObserver?.disconnect();
		this.selectionObserver = null;
		if (this.contextmenuHandler) {
			this.doc.removeEventListener("contextmenu", this.contextmenuHandler, true);
			this.contextmenuHandler = null;
		}
		this.closeCardSearch();
		this.hideSubBar();
		this.barEl.remove();
	}
}

// ---------- Overlays ----------

abstract class ToolOverlay {
	protected el: HTMLElement;
	protected destroyed = false;
	private touchPts = new Map<number, { x: number; y: number }>();
	private gestureActive = false;

	constructor(protected tb: CanvasToolbar, cls: string) {
		this.el = tb.view.canvas!.wrapperEl.createDiv({ cls: `canvas-pencil-overlay ${cls}` });
		// Right-click exits the active tool (back to Select). The marker overlay
		// stops propagation in its own handler so it can finalize a stroke first.
		this.el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onContextMenu();
		});
		this.bindPanGestures();
	}

	/** True while a two-finger pan/zoom gesture owns the pointer. */
	protected gesturing(): boolean {
		return this.gestureActive;
	}

	/** A two-finger gesture just began — cancel any in-progress tool work. */
	protected onGestureStart() {}

	/**
	 * Freeform-canvas feel: with any tool active, a second finger turns the
	 * gesture into pan/pinch-zoom instead of more tool input. Tracked in the
	 * capture phase so the subclass tool handlers never see gesture moves.
	 */
	private bindPanGestures() {
		const down = (e: PointerEvent) => {
			if (e.pointerType !== "touch") return;
			this.touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (this.touchPts.size === 2 && !this.gestureActive) {
				this.gestureActive = true;
				this.onGestureStart();
			}
		};
		const move = (e: PointerEvent) => {
			if (e.pointerType !== "touch") return;
			const prev = this.touchPts.get(e.pointerId);
			if (!prev) return;
			if (!this.gestureActive || this.touchPts.size !== 2) {
				this.touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
				return;
			}
			const other = [...this.touchPts.entries()].find(([id]) => id !== e.pointerId)?.[1];
			this.touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (!other) return;
			const pcx = (prev.x + other.x) / 2;
			const pcy = (prev.y + other.y) / 2;
			const pd = Math.hypot(prev.x - other.x, prev.y - other.y);
			const cx = (e.clientX + other.x) / 2;
			const cy = (e.clientY + other.y) / 2;
			const d = Math.hypot(e.clientX - other.x, e.clientY - other.y);
			this.applyPanZoom(cx - pcx, cy - pcy, pd > 0 ? d / pd : 1, cx, cy);
			e.preventDefault();
			e.stopPropagation();
		};
		const up = (e: PointerEvent) => {
			if (e.pointerType !== "touch") return;
			this.touchPts.delete(e.pointerId);
			if (this.touchPts.size < 2) this.gestureActive = false;
		};
		this.el.addEventListener("pointerdown", down, true);
		this.el.addEventListener("pointermove", move, true);
		this.el.addEventListener("pointerup", up, true);
		this.el.addEventListener("pointercancel", up, true);
	}

	/** Drive Obsidian's own wheel handlers: plain wheel pans, ctrl+wheel zooms —
	 *  no reliance on undocumented viewport internals. */
	private applyPanZoom(dx: number, dy: number, ratio: number, cx: number, cy: number) {
		const wrap = this.canvas.wrapperEl;
		const target = wrap.querySelector(".canvas") ?? wrap;
		if (dx || dy) {
			target.dispatchEvent(
				new WheelEvent("wheel", {
					deltaX: -dx,
					deltaY: -dy,
					clientX: cx,
					clientY: cy,
					bubbles: true,
					cancelable: true,
				})
			);
		}
		if (ratio !== 1) {
			target.dispatchEvent(
				new WheelEvent("wheel", {
					ctrlKey: true,
					deltaY: (1 - ratio) * 100,
					clientX: cx,
					clientY: cy,
					bubbles: true,
					cancelable: true,
				})
			);
		}
	}

	/** Right-click behaviour; overrides may finalize work before reverting. */
	protected onContextMenu() {
		this.tb.revertToSelect();
	}

	/** Hide any cursor-following hint (called when the pointer enters the toolbar). */
	hideHint() {}

	protected get canvas(): CanvasLike {
		return this.tb.view.canvas!;
	}

	protected worldFromClient(clientX: number, clientY: number): { x: number; y: number } {
		const c = this.canvas;
		if (typeof c.posFromEvt === "function") return c.posFromEvt({ clientX, clientY });
		return { x: clientX, y: clientY };
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.onDestroy();
		this.el.remove();
	}

	protected onDestroy() {}
}

// --- Marker overlay: draw / highlight / tape / erase ---

const HIGHLIGHT_OPACITY = 0.45;
const HIGHLIGHT_SIZE_FACTOR = 3;
const TAPE_THICKNESS = 80;

class MarkerOverlay extends ToolOverlay {
	private canvasEl: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private current: PencilStroke | null = null;
	private tapeStart: { x: number; y: number } | null = null;
	private tapeEnd: { x: number; y: number } | null = null;
	private erased = false;
	private tapePreviewEl: HTMLElement;
	private resizeObserver: ResizeObserver;

	constructor(tb: CanvasToolbar) {
		super(tb, "canvas-pencil-overlay-marker");
		this.canvasEl = this.el.createEl("canvas");
		this.ctx = this.canvasEl.getContext("2d")!;
		this.tapePreviewEl = this.el.createDiv({ cls: "canvas-pencil-tape-preview" });
		this.tapePreviewEl.hide();
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(this.el);
		this.resize();
		this.bind();
		this.onModeChange();
	}

	onModeChange() {
		this.el.toggleClass("is-erasing", this.tb.markerMode === "erase");
	}

	/** Second finger landed — this is a pan/zoom, not a stroke. Drop the stroke. */
	protected onGestureStart() {
		this.current = null;
		this.tapeStart = this.tapeEnd = null;
		this.tapePreviewEl.hide();
		this.tapePreviewEl.empty();
		this.redraw();
	}

	private getScale(): number {
		const rect = this.el.getBoundingClientRect();
		const a = this.worldFromClient(rect.left, rect.top);
		const b = this.worldFromClient(rect.left + 100, rect.top);
		const d = b.x - a.x;
		return d !== 0 ? 100 / d : 1;
	}

	private resize() {
		const rect = this.el.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		this.canvasEl.width = Math.max(1, Math.round(rect.width * dpr));
		this.canvasEl.height = Math.max(1, Math.round(rect.height * dpr));
		this.canvasEl.style.width = `${rect.width}px`;
		this.canvasEl.style.height = `${rect.height}px`;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.redraw();
	}

	private bind() {
		const el = this.canvasEl;
		el.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			if (this.gesturing() || (e.pointerType === "touch" && !e.isPrimary)) {
				this.current = null;
				return;
			}
			el.setPointerCapture(e.pointerId);
			const mode = this.tb.markerMode;
			const w = this.worldFromClient(e.clientX, e.clientY);
			if (mode === "erase") {
				this.eraseAt(w);
			} else if (mode === "tape") {
				this.tapeStart = w;
				this.tapeEnd = w;
			} else {
				this.current = {
					worldPts: [[w.x, w.y, 0.5]],
					color: mode === "highlight" ? this.tb.highlightColor : this.tb.markerColor,
					size:
						mode === "highlight"
							? this.tb.markerSize * HIGHLIGHT_SIZE_FACTOR
							: this.tb.markerSize,
					highlight: mode === "highlight",
				};
			}
			e.preventDefault();
		});
		el.addEventListener("pointermove", (e) => {
			if (this.gesturing()) return;
			const mode = this.tb.markerMode;
			if (mode === "erase") {
				if (e.buttons & 1) this.eraseAt(this.worldFromClient(e.clientX, e.clientY));
				return;
			}
			if (mode === "tape") {
				if (this.tapeStart) {
					this.tapeEnd = this.worldFromClient(e.clientX, e.clientY);
					this.updateTapePreview();
				}
				return;
			}
			if (!this.current) return;
			const events =
				typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
			for (const ev of events) {
				const w = this.worldFromClient(ev.clientX, ev.clientY);
				this.current.worldPts.push([w.x, w.y, 0.5]);
			}
			this.redraw();
			e.preventDefault();
		});
		const end = (e: PointerEvent) => {
			if (this.tapeStart && this.tapeEnd) {
				const a = this.tapeStart;
				const b = this.tapeEnd;
				this.tapeStart = this.tapeEnd = null;
				if (Math.hypot(b.x - a.x, b.y - a.y) > 20) this.commitTape(a, b);
				this.tapePreviewEl.hide();
				this.tapePreviewEl.empty();
			}
			if (this.current) {
				// One stroke (pointer down → up) becomes one ink node, immediately.
				const stroke = this.current;
				this.current = null;
				if (stroke.worldPts.length > 1) this.commitStroke(stroke);
				this.redraw();
			}
			if (this.erased) {
				// One undo step per erase drag, not per node removed.
				this.erased = false;
				pushCanvasHistory(this.canvas);
			}
			e.preventDefault();
		};
		el.addEventListener("pointerup", end);
		el.addEventListener("pointercancel", end);
		el.addEventListener("wheel", () => window.requestAnimationFrame(() => this.redraw()), {
			passive: true,
		});
		// Right-click ends drawing: finalize anything in progress, leave the tool.
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.tapeStart && this.tapeEnd) {
				const a = this.tapeStart;
				const b = this.tapeEnd;
				this.tapeStart = this.tapeEnd = null;
				if (Math.hypot(b.x - a.x, b.y - a.y) > 20) this.commitTape(a, b);
				this.tapePreviewEl.hide();
				this.tapePreviewEl.empty();
			}
			if (this.current) {
				const stroke = this.current;
				this.current = null;
				if (stroke.worldPts.length > 1) this.commitStroke(stroke);
				this.redraw();
			}
			this.tb.revertToSelect();
		});
	}

	private eraseAt(w: { x: number; y: number }) {
		const canvas = this.canvas;
		if (!canvas.nodes) return;
		for (const node of [...canvas.nodes.values()]) {
			const t = node.text;
			const isInk = typeof t === "string" && t.startsWith("<svg") && t.includes(INK_MARK);
			if (!isInk) continue;
			const { x, y, width, height } = node;
			if (
				x !== undefined && y !== undefined &&
				width !== undefined && height !== undefined &&
				w.x >= x && w.x <= x + width && w.y >= y && w.y <= y + height
			) {
				canvas.removeNode?.(node);
				canvas.requestSave?.();
				this.erased = true;
			}
		}
	}

	private outlineFor(stroke: PencilStroke, scale: number): number[][] {
		return getStroke(
			stroke.worldPts.map(([x, y, p]) => [x * scale, y * scale, p]),
			{
				size: stroke.size * scale,
				thinning: 0, // uniform width — no pressure/speed variation
				smoothing: 0.5,
				streamline: 0.4,
				simulatePressure: false,
			}
		);
	}

	private redraw() {
		const rect = this.el.getBoundingClientRect();
		this.ctx.clearRect(0, 0, rect.width, rect.height);
		const stroke = this.current;
		if (!stroke) return;
		const scale = this.getScale();
		const origin = this.worldFromClient(rect.left, rect.top);
		const ox = origin.x * scale;
		const oy = origin.y * scale;

		if (stroke.highlight) {
			// Flat chisel: constant-width ribbon with flat ends.
			this.ctx.globalAlpha = HIGHLIGHT_OPACITY;
			this.ctx.strokeStyle = stroke.color;
			this.ctx.lineWidth = stroke.size * scale;
			this.ctx.lineCap = "butt";
			this.ctx.lineJoin = "round";
			this.ctx.beginPath();
			stroke.worldPts.forEach(([x, y], i) => {
				if (i === 0) this.ctx.moveTo(x * scale - ox, y * scale - oy);
				else this.ctx.lineTo(x * scale - ox, y * scale - oy);
			});
			this.ctx.stroke();
		} else {
			const outline = this.outlineFor(stroke, scale);
			if (outline.length < 2) return;
			this.ctx.globalAlpha = 1;
			this.ctx.fillStyle = stroke.color;
			this.ctx.beginPath();
			this.ctx.moveTo(outline[0][0] - ox, outline[0][1] - oy);
			for (let i = 1; i < outline.length; i++) {
				const [x0, y0] = outline[i - 1];
				const [x1, y1] = outline[i];
				this.ctx.quadraticCurveTo(x0 - ox, y0 - oy, (x0 + x1) / 2 - ox, (y0 + y1) / 2 - oy);
			}
			this.ctx.closePath();
			this.ctx.fill();
		}
		this.ctx.globalAlpha = 1;
	}

	/** Live tape preview: the real pattern SVG, stretched as you drag. */
	private updateTapePreview() {
		if (!this.tapeStart || !this.tapeEnd) return;
		const ink = buildTapeSvg(
			this.tapeStart,
			this.tapeEnd,
			this.tb.tapePattern,
			this.tb.plugin.settings.tapeImage
		);
		if (!ink) {
			this.tapePreviewEl.hide();
			return;
		}
		const rect = this.el.getBoundingClientRect();
		const scale = this.getScale();
		const origin = this.worldFromClient(rect.left, rect.top);
		this.tapePreviewEl.style.left = `${(ink.box.x - origin.x) * scale}px`;
		this.tapePreviewEl.style.top = `${(ink.box.y - origin.y) * scale}px`;
		this.tapePreviewEl.style.width = `${ink.box.width * scale}px`;
		this.tapePreviewEl.style.height = `${ink.box.height * scale}px`;
		setSvg(this.tapePreviewEl, ink.svg);
		this.tapePreviewEl.show();
	}

	private commitStroke(stroke: PencilStroke) {
		try {
			commitInkNode(this.tb, buildStrokesSvg([stroke]));
		} catch (err) {
			console.error("Canvas Kit: failed to save ink", err);
			new Notice("Canvas Kit: failed to save ink — see console.");
		}
	}

	private commitTape(a: { x: number; y: number }, b: { x: number; y: number }) {
		try {
			commitInkNode(
				this.tb,
				buildTapeSvg(a, b, this.tb.tapePattern, this.tb.plugin.settings.tapeImage)
			);
		} catch (err) {
			console.error("Canvas Kit: failed to save tape", err);
			new Notice("Canvas Kit: failed to save tape — see console.");
		}
	}

	protected onDestroy() {
		this.resizeObserver.disconnect();
	}
}

// --- Text tool: click to type right where the pointer landed ---

class TextEditOverlay extends ToolOverlay {
	private hint: HTMLElement;
	private pendingDown: { x: number; y: number } | null = null;
	constructor(tb: CanvasToolbar) {
		super(tb, "canvas-pencil-overlay-place");
		const hint = (this.hint = this.el.createDiv({
			cls: "canvas-pencil-hint",
			text: "Click to add text",
		}));
		hint.hide();
		this.el.addEventListener("pointermove", (e) => {
			if (this.gesturing()) return;
			const r = this.el.getBoundingClientRect();
			hint.style.left = `${e.clientX - r.left + 14}px`;
			hint.style.top = `${e.clientY - r.top + 14}px`;
			hint.show();
		});
		this.el.addEventListener("pointerleave", () => hint.hide());

		// Place on pointer-UP with a movement threshold, so a two-finger pan (or a
		// drag) never spawns an editor at the touch-down point.
		this.el.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			if (this.gesturing() || (e.pointerType === "touch" && !e.isPrimary)) return;
			this.pendingDown = { x: e.clientX, y: e.clientY };
			e.preventDefault();
			e.stopPropagation();
		});
		this.el.addEventListener("pointerup", (e) => {
			const at = this.pendingDown;
			this.pendingDown = null;
			if (!at || this.gesturing()) return;
			if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 8) return;
			e.preventDefault();
			e.stopPropagation();
			const w = this.worldFromClient(at.x, at.y);
			hint.hide();
			// Let further clicks reach the canvas (pan / commit-on-click-away)
			// while the inline editor is open.
			this.el.setCssStyles({ pointerEvents: "none" });
			const close = () => this.tb.revertToSelect();
			// Clicking an existing text node edits it in place; otherwise place new.
			const hit = this.tb.findTextNodeAt(w);
			if (hit) {
				this.tb.editTextNode(hit.node, hit.el, close);
				return;
			}
			// Anchor so the first glyph lands at the click point (offset by the
			// node's inner padding, which scales with the font size).
			const pad = this.tb.textSize * TEXT_PAD_EM;
			const origin = { x: w.x - pad, y: w.y - pad };
			this.tb.openTextEditor(origin, this.tb.textSize, null, null, "", close);
		});
	}

	protected onGestureStart() {
		this.pendingDown = null;
		this.hint.hide();
	}

	hideHint() {
		this.hint.hide();
	}

	onDestroy() {
		this.tb.activeTextEditor?.commit();
	}
}

// --- Drag-create tools: card / table / section (anchor at pointer-down corner) ---

const TABLE_CELL_W = 140;
const TABLE_CELL_H = 48;

class DragCreateOverlay extends ToolOverlay {
	private rectEl: HTMLElement;
	private labelEl: HTMLElement;
	private hintEl: HTMLElement;
	private hintText: string;
	private start: { x: number; y: number } | null = null; // client coords
	private startWorld: { x: number; y: number } | null = null;

	constructor(tb: CanvasToolbar, private kind: "card" | "table" | "section" | "image") {
		super(tb, "canvas-pencil-overlay-section");
		this.rectEl = this.el.createDiv({
			cls: `canvas-pencil-marquee${kind === "table" ? " canvas-pencil-marquee-table" : ""}`,
		});
		this.rectEl.hide();
		this.labelEl = this.el.createDiv({ cls: "canvas-pencil-hint" });
		this.labelEl.hide();

		const hints = {
			card: "Click and drag to set size",
			table: "Click and drag to set rows × columns",
			section: "Drag to create a section",
			image: "Pick an image, then drag to place it",
		};
		this.hintText = hints[kind];
		this.hintEl = this.el.createDiv({ cls: "canvas-pencil-hint", text: this.hintText });
		this.hintEl.hide();

		this.el.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			if (this.gesturing() || (e.pointerType === "touch" && !e.isPrimary)) return;
			this.el.setPointerCapture(e.pointerId);
			this.start = { x: e.clientX, y: e.clientY };
			this.startWorld = this.worldFromClient(e.clientX, e.clientY);
			this.hintEl.hide();
			e.preventDefault();
		});
		this.el.addEventListener("pointermove", (e) => {
			if (this.gesturing()) return;
			const r = this.el.getBoundingClientRect();
			if (!this.start) {
				// Reflect a loaded note / image in the cursor hint.
				const pending =
					this.kind === "image"
						? this.tb.pendingImageFile
						: this.kind === "card" && this.tb.cardMode === "existing"
							? this.tb.pendingExistingFile
							: null;
				this.hintEl.setText(pending ? `Drop "${pending.basename}"` : this.hintText);
				this.hintEl.style.left = `${e.clientX - r.left + 14}px`;
				this.hintEl.style.top = `${e.clientY - r.top + 14}px`;
				this.hintEl.show();
				return;
			}
			const left = Math.min(this.start.x, e.clientX) - r.left;
			const top = Math.min(this.start.y, e.clientY) - r.top;
			const w = Math.abs(e.clientX - this.start.x);
			const h = Math.abs(e.clientY - this.start.y);
			this.rectEl.style.left = `${left}px`;
			this.rectEl.style.top = `${top}px`;
			this.rectEl.style.width = `${w}px`;
			this.rectEl.style.height = `${h}px`;
			this.rectEl.show();

			if (this.kind === "table" && this.startWorld) {
				const endWorld = this.worldFromClient(e.clientX, e.clientY);
				const { cols, rows } = tableDims(this.startWorld, endWorld);
				this.rectEl.style.backgroundSize = `${w / cols}px ${h / rows}px`;
				this.labelEl.setText(`${rows} × ${cols}`);
				this.labelEl.style.left = `${e.clientX - r.left + 14}px`;
				this.labelEl.style.top = `${e.clientY - r.top + 14}px`;
				this.labelEl.show();
			}
		});
		this.el.addEventListener("pointerup", (e) => {
			if (!this.start || !this.startWorld) return;
			const endWorld = this.worldFromClient(e.clientX, e.clientY);
			const a = this.startWorld;
			this.start = this.startWorld = null;
			this.rectEl.hide();
			this.labelEl.hide();
			// create() returns false to keep the tool active (e.g. existing-note mode
			// re-opened its picker because nothing was chosen yet).
			if (this.create(a, endWorld) !== false) this.tb.revertToSelect();
		});
	}

	/** Second finger landed — this is a pan/zoom; abandon the marquee drag. */
	protected onGestureStart() {
		this.start = this.startWorld = null;
		this.rectEl.hide();
		this.labelEl.hide();
		this.hintEl.hide();
	}

	hideHint() {
		this.hintEl.hide();
		this.labelEl.hide();
	}

	/** Put a freshly-created group's label straight into rename mode. */
	private beginLabelRename(node: CanvasNodeLike) {
		const tryEdit = () => {
			try {
				node.startEditing?.();
			} catch {
				/* group may not expose startEditing — fall back to the label */
			}
			const label = node.nodeEl?.querySelector(
				".canvas-node-label"
			) as HTMLElement | null;
			if (!label) return false;
			label.focus();
			// Select the placeholder text so typing replaces it.
			const sel = label.ownerDocument.getSelection();
			if (sel) {
				const range = label.ownerDocument.createRange();
				range.selectNodeContents(label);
				sel.removeAllRanges();
				sel.addRange(range);
			}
			return true;
		};
		// The group's DOM mounts async — retry until the label exists.
		if (tryEdit()) return;
		window.requestAnimationFrame(tryEdit);
		window.setTimeout(tryEdit, 60);
		window.setTimeout(tryEdit, 200);
	}

	private create(a: { x: number; y: number }, b: { x: number; y: number }): boolean | void {
		const canvas = this.canvas;
		let x = Math.round(Math.min(a.x, b.x));
		let y = Math.round(Math.min(a.y, b.y));
		let width = Math.round(Math.abs(b.x - a.x));
		let height = Math.round(Math.abs(b.y - a.y));
		const dragged = width > 20 && height > 20;

		if (this.kind === "section") {
			if (!dragged) return;
			try {
				const node = canvas.createGroupNode?.({
					pos: { x, y },
					size: { width, height },
					label: "Section",
					save: true,
					focus: true,
				});
				canvas.requestSave?.();
				pushCanvasHistory(canvas);
				// Drop straight into renaming the section label.
				if (node) this.beginLabelRename(node);
			} catch (err) {
				console.error("Canvas Kit: couldn't create section", err);
				new Notice("Canvas Kit: couldn't create section.");
			}
			return;
		}

		if (this.kind === "card") {
			if (!dragged) {
				width = 320;
				height = 180;
				x = Math.round(a.x - width / 2);
				y = Math.round(a.y - height / 2);
			}
			const pos = { x, y };
			const size = { width, height };
			const mode = this.tb.cardMode;
			// New note: create + embed a real note in one gesture (no search detour).
			if (mode === "new") {
				void this.tb.createNoteCardAt(pos, size);
				return;
			}
			// Existing note (flow A): the note was picked from the sub-bar search and
			// is held in pendingExistingFile — this drag just places & sizes it. If
			// nothing's picked yet (search was dismissed), reopen it and keep the tool.
			if (mode === "existing") {
				const file = this.tb.pendingExistingFile;
				if (!file) {
					this.tb.setCardMode("existing");
					return false;
				}
				this.tb.placeExistingFile(pos, size, file);
				this.tb.pendingExistingFile = null;
				return;
			}
			// Empty card.
			const node = canvas.createTextNode?.({
				pos,
				size,
				text: "",
				save: true,
				focus: true,
			});
			node?.startEditing?.();
			canvas.requestSave?.();
			pushCanvasHistory(canvas);
			// Mount the [+]/embed affordance on the fresh empty card right away.
			this.tb.refreshNodeStyles();
			window.requestAnimationFrame(() => this.tb.refreshNodeStyles());
			window.setTimeout(() => this.tb.refreshNodeStyles(), 120);
			return;
		}

		if (this.kind === "image") {
			const file = this.tb.pendingImageFile;
			// Nothing picked (picker was dismissed / clicked outside) — exit the tool
			// instead of reopening, so a click outside the finder cancels cleanly.
			if (!file) return;
			const dims = this.tb.pendingImageDims;
			if (!dragged) {
				// Click = drop at a sensible default size, keeping the image's aspect.
				width = 400;
				height = dims && dims.w > 0 ? Math.round((width * dims.h) / dims.w) : 300;
				x = Math.round(a.x - width / 2);
				y = Math.round(a.y - height / 2);
			}
			this.tb.placeImageFile({ x, y }, { width, height }, file, dims);
			this.tb.pendingImageFile = null;
			this.tb.pendingImageDims = null;
			return;
		}

		// table
		let cols = 3;
		let rows = 3;
		if (dragged) {
			({ cols, rows } = tableDims(a, b));
		} else {
			width = cols * TABLE_CELL_W;
			height = rows * TABLE_CELL_H;
			x = Math.round(a.x - width / 2);
			y = Math.round(a.y - height / 2);
		}
		const headerCells = "|     ".repeat(cols) + "|";
		const sepCells = "| --- ".repeat(cols) + "|";
		const bodyRow = "|     ".repeat(cols) + "|";
		const text = [headerCells, sepCells, ...Array<string>(Math.max(1, rows - 1)).fill(bodyRow)].join(
			"\n"
		);
		// focus:false — focusing would open Obsidian's inline markdown editor.
		const node = canvas.createTextNode?.({
			pos: { x, y },
			size: { width, height },
			text,
			save: true,
			focus: false,
		});
		if (node) {
			tagNode(node, "table");
			canvas.requestSave?.();
			pushCanvasHistory(canvas);
			// Mount the interactive table right away and again after Obsidian's
			// own render settles, so the markdown preview never shows.
			const tb = this.tb;
			tb.refreshNodeStyles();
			window.requestAnimationFrame(() => tb.refreshNodeStyles());
			window.setTimeout(() => tb.refreshNodeStyles(), 80);
			window.setTimeout(() => tb.refreshNodeStyles(), 300);
		}
	}
}

function tableDims(
	a: { x: number; y: number },
	b: { x: number; y: number }
): { cols: number; rows: number } {
	const width = Math.abs(b.x - a.x);
	const height = Math.abs(b.y - a.y);
	return {
		cols: Math.min(10, Math.max(1, Math.round(width / TABLE_CELL_W))),
		rows: Math.min(20, Math.max(2, Math.round(height / TABLE_CELL_H))),
	};
}

// ---------- Interactive table widget ----------
//
// Table nodes are ordinary text nodes whose text is a markdown table. We never
// show Obsidian's markdown preview or editor for them; instead we render an
// HTML table that fills the node. Click once to select the node (canvas resize
// handles), click a cell while selected to edit it. Hovering shows "+" pills to
// append a row/column and drag handles to reorder rows/columns.

class TableWidget {
	renderedText = "";
	private cells: string[][] = [["", ""], ["", ""]];
	private colW: number[] = [];
	private rowH: number[] = [];
	private editingCell: HTMLTableCellElement | null = null;
	private rootEl: HTMLElement | null = null;
	private tableEl: HTMLTableElement | null = null;
	private addColEl: HTMLElement | null = null;
	private addRowEl: HTMLElement | null = null;
	private colHandles: HTMLElement[] = [];
	private rowHandles: HTMLElement[] = [];
	private colDividers: HTMLElement[] = [];
	private rowDividers: HTMLElement[] = [];
	private insertColDots: HTMLElement[] = [];
	private insertRowDots: HTMLElement[] = [];
	private insertLineEl: HTMLElement | null = null;
	private chromeTracker: ((e: PointerEvent) => void) | null = null;
	// Row/column selection (click a handle to select; then drag to reorder or delete).
	private selected: { axis: "row" | "col"; index: number } | null = null;
	private deleteBtnEl: HTMLElement | null = null;
	private lineSelOutside: ((e: PointerEvent) => void) | null = null;
	private lineSelKey: ((e: KeyboardEvent) => void) | null = null;
	private get doc(): Document {
		return this.nodeEl.ownerDocument;
	}
	private lastSyncedW = 0;
	private lastSyncedH = 0;

	constructor(
		private tb: CanvasToolbar,
		private node: CanvasNodeLike,
		private content: HTMLElement,
		private nodeEl: HTMLElement
	) {}

	isEditing(): boolean {
		return this.editingCell !== null;
	}

	/** Sweep hook: re-render on external text change, rescale on node resize. */
	syncFromNode() {
		if (this.isEditing()) return;
		const text = this.node.text ?? "";
		if (text !== this.renderedText || !this.tableEl?.isConnected) {
			this.render();
			return;
		}
		// Whole-node resize via the canvas handles scales the grid proportionally.
		const nw = this.node.width ?? 0;
		const nh = this.node.height ?? 0;
		let changed = false;
		if (this.lastSyncedW && nw && Math.abs(nw - this.lastSyncedW) > 3) {
			const f = nw / Math.max(1, sumArr(this.colW));
			this.colW = this.colW.map((w) => Math.max(50, Math.round(w * f)));
			changed = true;
		}
		if (this.lastSyncedH && nh && Math.abs(nh - this.lastSyncedH) > 3) {
			const f = nh / Math.max(1, sumArr(this.rowH));
			this.rowH = this.rowH.map((h) => Math.max(28, Math.round(h * f)));
			changed = true;
		}
		if (changed) {
			this.applySizes();
			this.layout();
			this.persistSizes();
			this.syncNodeSize();
		} else {
			this.layout(); // rows can grow with content
		}
	}

	render() {
		const text = this.node.text ?? "";
		this.renderedText = text;
		const parsed = parseMdTable(text);
		if (parsed) this.cells = parsed;
		this.editingCell = null;
		this.loadSizes();
		this.clearLineSelection(); // drop stale selection + its document listeners

		this.content.empty();
		const root = (this.rootEl = this.content.createDiv({ cls: "cp-table-root" }));
		// Keep canvas shortcuts/deletion away from cell typing.
		root.addEventListener("keydown", (e) => e.stopPropagation());

		const table = (this.tableEl = root.createEl("table", { cls: "cp-table" }));
		const colgroup = table.createEl("colgroup");
		for (let c = 0; c < this.cells[0].length; c++) colgroup.createEl("col");
		this.cells.forEach((row, r) => {
			const tr = table.createEl("tr");
			row.forEach((cellText, c) => {
				const td = tr.createEl("td");
				td.setText(cellText);
				td.addEventListener("pointerdown", (e) => {
					// First click selects the node (bubbles to canvas); a click
					// while selected goes straight into editing this cell.
					if (this.nodeEl.hasClass("is-focused") && e.button === 0) {
						e.stopPropagation();
						e.preventDefault();
						this.editCell(td, r, c);
					}
				});
				// Content growth changes row heights — keep chrome aligned.
				td.addEventListener("input", () =>
					window.requestAnimationFrame(() => this.layout())
				);
			});
		});
		this.applySizes();

		// "+" pills: append column (right edge) / row (bottom edge).
		this.addColEl = root.createDiv({
			cls: "cp-table-add cp-table-add-col",
			attr: { "aria-label": "Add column" },
		});
		setIcon(this.addColEl, "plus");
		this.addColEl.addEventListener("pointerdown", (e) => {
			e.stopPropagation();
			e.preventDefault();
			this.cells.forEach((row) => row.push(""));
			this.colW.push(TABLE_CELL_W);
			this.save();
		});
		this.addRowEl = root.createDiv({
			cls: "cp-table-add cp-table-add-row",
			attr: { "aria-label": "Add row" },
		});
		setIcon(this.addRowEl, "plus");
		this.addRowEl.addEventListener("pointerdown", (e) => {
			e.stopPropagation();
			e.preventDefault();
			this.cells.push(this.cells[0].map(() => ""));
			this.rowH.push(TABLE_CELL_H);
			this.save();
		});

		// Reorder handles (top/left edges) and resize dividers (between cells).
		const cols = this.cells[0].length;
		const rows = this.cells.length;
		this.colHandles = [];
		this.rowHandles = [];
		this.colDividers = [];
		this.rowDividers = [];
		for (let c = 0; c < cols; c++) {
			const h = root.createDiv({
				cls: "cp-table-handle cp-table-handle-col",
				attr: { "aria-label": "Drag to reorder column" },
			});
			this.bindReorder(h, "col", c);
			this.colHandles.push(h);
			if (c < cols - 1) {
				const d = root.createDiv({ cls: "cp-table-divider cp-table-divider-col" });
				this.bindResize(d, "col", c);
				this.colDividers.push(d);
			}
		}
		for (let r = 0; r < rows; r++) {
			const h = root.createDiv({
				cls: "cp-table-handle cp-table-handle-row",
				attr: { "aria-label": "Drag to reorder row" },
			});
			this.bindReorder(h, "row", r);
			this.rowHandles.push(h);
			if (r < rows - 1) {
				const d = root.createDiv({ cls: "cp-table-divider cp-table-divider-row" });
				this.bindResize(d, "row", r);
				this.rowDividers.push(d);
			}
		}

		// Insert dots: one per internal borderline; click inserts a row/column there.
		this.insertColDots = [];
		this.insertRowDots = [];
		this.insertLineEl = root.createDiv({ cls: "cp-insert-line" });
		this.insertLineEl.hide();
		for (let c = 0; c < cols - 1; c++) {
			const dot = root.createDiv({
				cls: "cp-insert cp-insert-col",
				attr: { "aria-label": "Insert column here" },
			});
			setIcon(dot, "plus");
			this.bindInsert(dot, "col", c);
			this.insertColDots.push(dot);
		}
		for (let r = 0; r < rows - 1; r++) {
			const dot = root.createDiv({
				cls: "cp-insert cp-insert-row",
				attr: { "aria-label": "Insert row here" },
			});
			setIcon(dot, "plus");
			this.bindInsert(dot, "row", r);
			this.insertRowDots.push(dot);
		}

		// FigJam-style proximity: only show the chrome adjacent to the pointer,
		// and only while the node is selected. Tracked at the canvas level so the
		// chrome survives the pointer sitting on (or slightly past) the table edge.
		this.bindChromeTracker();
		this.hideChrome();

		window.requestAnimationFrame(() => {
			this.layout();
			this.syncNodeSize();
		});
	}

	// --- proximity-based chrome visibility ---

	/** Track the pointer on the whole canvas so chrome persists when the pointer
	 *  rides the table border or strays slightly outside it. Self-cleaning: the
	 *  listener unhooks itself once this widget's table leaves the DOM. */
	private bindChromeTracker() {
		const wrapper = this.tb.view.canvas?.wrapperEl;
		if (!wrapper) return;
		if (this.chromeTracker) wrapper.removeEventListener("pointermove", this.chromeTracker);
		this.chromeTracker = (e: PointerEvent) => {
			if (!this.tableEl?.isConnected) {
				if (this.chromeTracker) {
					wrapper.removeEventListener("pointermove", this.chromeTracker);
					this.chromeTracker = null;
				}
				return;
			}
			this.updateChrome(e);
		};
		wrapper.addEventListener("pointermove", this.chromeTracker);
	}

	private updateChrome(e: PointerEvent) {
		if (!this.nodeEl.hasClass("is-focused")) {
			this.hideChrome();
			return;
		}
		const t = this.tableEl;
		if (!t || !t.isConnected) return;
		const rect = t.getBoundingClientRect();
		const M = 48; // keep edge chrome alive a little outside the table
		if (
			e.clientX < rect.left - M || e.clientX > rect.right + M ||
			e.clientY < rect.top - M || e.clientY > rect.bottom + M
		) {
			this.hideChrome();
			return;
		}
		const x = Math.min(Math.max(e.clientX, rect.left + 1), rect.right - 1);
		const y = Math.min(Math.max(e.clientY, rect.top + 1), rect.bottom - 1);
		let c = 0;
		let r = 0;
		const first = t.rows[0];
		for (let i = 0; i < (first?.cells.length ?? 0); i++) {
			const cr = first.cells[i].getBoundingClientRect();
			if (x >= cr.left && x <= cr.right) { c = i; break; }
		}
		for (let i = 0; i < t.rows.length; i++) {
			const rr = t.rows[i].getBoundingClientRect();
			if (y >= rr.top && y <= rr.bottom) { r = i; break; }
		}
		const cols = this.cells[0].length;
		const rows = this.cells.length;
		this.colHandles.forEach((h, i) => h.toggleClass("is-visible", i === c));
		this.rowHandles.forEach((h, i) => h.toggleClass("is-visible", i === r));
		this.addColEl?.toggleClass("is-visible", c === cols - 1);
		this.addRowEl?.toggleClass("is-visible", r === rows - 1);
		// Dots on the borderlines touching the hovered cell.
		this.insertColDots.forEach((d, i) =>
			d.toggleClass("is-visible", i === c - 1 || i === c)
		);
		this.insertRowDots.forEach((d, i) =>
			d.toggleClass("is-visible", i === r - 1 || i === r)
		);
	}

	private hideChrome() {
		const all = [
			...this.colHandles,
			...this.rowHandles,
			...this.insertColDots,
			...this.insertRowDots,
		];
		if (this.addColEl) all.push(this.addColEl);
		if (this.addRowEl) all.push(this.addRowEl);
		for (const el of all) el.removeClass("is-visible");
		this.insertLineEl?.hide();
	}

	// --- insert between rows/columns ---

	private bindInsert(dot: HTMLElement, axis: "row" | "col", boundary: number) {
		dot.addEventListener("pointerenter", () => this.showInsertLine(axis, boundary));
		dot.addEventListener("pointerleave", () => this.insertLineEl?.hide());
		dot.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.stopPropagation();
			e.preventDefault();
			this.insertLineEl?.hide();
			if (axis === "col") {
				this.cells.forEach((row) => row.splice(boundary + 1, 0, ""));
				this.colW.splice(boundary + 1, 0, TABLE_CELL_W);
			} else {
				this.cells.splice(boundary + 1, 0, this.cells[0].map(() => ""));
				this.rowH.splice(boundary + 1, 0, TABLE_CELL_H);
			}
			this.save();
		});
	}

	/** Highlight the borderline where the insert would happen. */
	private showInsertLine(axis: "row" | "col", boundary: number) {
		const t = this.tableEl;
		const line = this.insertLineEl;
		if (!t || !line) return;
		if (axis === "col") {
			const cell = t.rows[0]?.cells[boundary];
			if (!cell) return;
			line.style.left = `${cell.offsetLeft + cell.offsetWidth - 1.5}px`;
			line.setCssStyles({ top: "0px" });
			line.setCssStyles({ width: "3px" });
			line.style.height = `${t.offsetHeight}px`;
		} else {
			const tr = t.rows[boundary];
			if (!tr) return;
			line.style.top = `${tr.offsetTop + tr.offsetHeight - 1.5}px`;
			line.setCssStyles({ left: "0px" });
			line.setCssStyles({ height: "3px" });
			line.style.width = `${t.offsetWidth}px`;
		}
		line.show();
	}

	// --- sizing ---

	private loadSizes() {
		const cols = this.cells[0].length;
		const rows = this.cells.length;
		const data = this.node.getData?.();
		const pc = data?.pencilCols;
		const pr = data?.pencilRows;
		this.colW =
			Array.isArray(pc) && pc.length === cols ? pc.map((n) => Math.max(50, Number(n) || TABLE_CELL_W)) : [];
		this.rowH =
			Array.isArray(pr) && pr.length === rows ? pr.map((n) => Math.max(28, Number(n) || TABLE_CELL_H)) : [];
		if (this.colW.length !== cols) {
			const nw = this.node.width ?? cols * TABLE_CELL_W;
			this.colW = Array<number>(cols).fill(Math.max(50, Math.round(nw / cols)));
		}
		if (this.rowH.length !== rows) {
			const nh = this.node.height ?? rows * TABLE_CELL_H;
			this.rowH = Array<number>(rows).fill(Math.max(28, Math.round(nh / rows)));
		}
	}

	private applySizes() {
		const t = this.tableEl;
		if (!t) return;
		t.querySelectorAll("col").forEach((c, i) => {
			(c as HTMLElement).style.width = `${this.colW[i] ?? TABLE_CELL_W}px`;
		});
		t.style.width = `${sumArr(this.colW)}px`;
		// On <tr>, height acts as a minimum — content grows rows organically.
		Array.from(t.rows).forEach((tr, r) => {
			tr.style.height = `${this.rowH[r] ?? TABLE_CELL_H}px`;
		});
	}

	/** Position the +/reorder/divider chrome from measured cell geometry. */
	private layout() {
		const t = this.tableEl;
		if (!t || !t.isConnected) return;
		const tw = t.offsetWidth;
		const th = t.offsetHeight;
		if (this.addColEl) {
			this.addColEl.style.left = `${tw + 6}px`;
			this.addColEl.setCssStyles({ top: "0px" });
			this.addColEl.style.height = `${th}px`;
		}
		if (this.addRowEl) {
			this.addRowEl.style.top = `${th + 6}px`;
			this.addRowEl.setCssStyles({ left: "0px" });
			this.addRowEl.style.width = `${tw}px`;
		}
		const first = t.rows[0];
		this.colHandles.forEach((h, i) => {
			const cell = first?.cells[i];
			if (cell) h.style.left = `${cell.offsetLeft + cell.offsetWidth / 2}px`;
		});
		this.colDividers.forEach((d, i) => {
			const cell = first?.cells[i];
			if (cell) {
				d.style.left = `${cell.offsetLeft + cell.offsetWidth - 3}px`;
				d.setCssStyles({ top: "0px" });
				d.style.height = `${th}px`;
			}
		});
		this.rowHandles.forEach((h, r) => {
			const tr = t.rows[r];
			if (tr) h.style.top = `${tr.offsetTop + tr.offsetHeight / 2}px`;
		});
		this.rowDividers.forEach((d, r) => {
			const tr = t.rows[r];
			if (tr) {
				d.style.top = `${tr.offsetTop + tr.offsetHeight - 3}px`;
				d.setCssStyles({ left: "0px" });
				d.style.width = `${tw}px`;
			}
		});
		// Dots are translate-centered, so position by the borderline itself; they
		// share the same -12px axis line as the reorder handles.
		this.insertColDots.forEach((d, i) => {
			const cell = first?.cells[i];
			if (cell) {
				d.style.left = `${cell.offsetLeft + cell.offsetWidth}px`;
				d.setCssStyles({ top: "-12px" });
			}
		});
		this.insertRowDots.forEach((d, r) => {
			const tr = t.rows[r];
			if (tr) {
				d.style.top = `${tr.offsetTop + tr.offsetHeight}px`;
				d.setCssStyles({ left: "-12px" });
			}
		});
		this.positionDeleteBtn(); // follow the handle as the grid re-lays out
	}

	/** Drag a divider to resize the column left of / row above it. */
	private bindResize(div: HTMLElement, axis: "row" | "col", index: number) {
		div.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.stopPropagation();
			e.preventDefault();
			div.setPointerCapture(e.pointerId);
			div.addClass("is-resizing");
			const scale = canvasScale(this.tb.view.canvas!);
			const startX = e.clientX;
			const startY = e.clientY;
			const startSize = axis === "col" ? this.colW[index] : this.rowH[index];
			const onMove = (ev: PointerEvent) => {
				if (axis === "col") {
					this.colW[index] = Math.max(
						50,
						Math.round(startSize + (ev.clientX - startX) / scale)
					);
				} else {
					this.rowH[index] = Math.max(
						28,
						Math.round(startSize + (ev.clientY - startY) / scale)
					);
				}
				this.applySizes();
				this.layout();
			};
			const onUp = () => {
				div.removeEventListener("pointermove", onMove);
				div.removeClass("is-resizing");
				this.persistSizes();
				this.syncNodeSize();
			};
			div.addEventListener("pointermove", onMove);
			div.addEventListener("pointerup", onUp, { once: true });
		});
	}

	/** Grow/shrink the node to hug the table, so it never looks boxed. */
	private syncNodeSize() {
		const t = this.tableEl;
		if (!t || !t.isConnected || !this.node.getData || !this.node.setData) return;
		const w = t.offsetWidth;
		const h = t.offsetHeight;
		if (!w || !h) return;
		this.lastSyncedW = w;
		this.lastSyncedH = h;
		try {
			const data = this.node.getData();
			if (
				Math.abs((Number(data.width) || 0) - w) > 2 ||
				Math.abs((Number(data.height) || 0) - h) > 2
			) {
				data.width = w;
				data.height = h;
				this.node.setData(data);
				this.tb.view.canvas?.requestSave?.();
			}
		} catch (err) {
			console.warn("Canvas Kit: couldn't sync node size", err);
		}
	}

	private persistSizes() {
		if (!this.node.getData || !this.node.setData) return;
		try {
			const data = this.node.getData();
			data.pencilCols = this.colW.slice();
			data.pencilRows = this.rowH.slice();
			this.node.setData(data);
			this.tb.view.canvas?.requestSave?.();
		} catch (err) {
			console.warn("Canvas Kit: couldn't persist table sizes", err);
		}
	}

	private editCell(td: HTMLTableCellElement, r: number, c: number) {
		if (this.editingCell === td) return;
		this.finishEditing();
		this.editingCell = td;
		// Hide the node's selection ring while a cell is active — only the cell
		// should read as selected.
		this.nodeEl.addClass("cp-cell-editing");
		td.contentEditable = "true";
		td.addClass("is-editing-cell");
		td.focus();
		// Caret at end of existing content.
		const range = activeDocument.createRange();
		range.selectNodeContents(td);
		range.collapse(false);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);

		const commit = () => {
			td.contentEditable = "false";
			td.removeClass("is-editing-cell");
			this.nodeEl.removeClass("cp-cell-editing");
			this.tb.restoreViewportPosition();
			if (this.editingCell === td) this.editingCell = null;
			const v = (td.textContent ?? "").trim();
			if (v !== this.cells[r][c]) {
				this.cells[r][c] = v;
				this.save();
			} else {
				this.layout();
				this.syncNodeSize();
			}
		};
		td.addEventListener("blur", commit, { once: true });
		td.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") {
				e.preventDefault();
				td.blur();
			} else if (e.key === "Tab") {
				e.preventDefault();
				td.blur();
				this.editNeighbor(r, c, 0, e.shiftKey ? -1 : 1);
			} else if (e.key === "Enter") {
				e.preventDefault();
				td.blur();
				this.editNeighbor(r, c, 1, 0);
			}
		});
	}

	private editNeighbor(r: number, c: number, dr: number, dc: number) {
		let nr = r + dr;
		let nc = c + dc;
		if (nc >= this.cells[0].length) { nc = 0; nr++; }
		if (nc < 0) { nc = this.cells[0].length - 1; nr--; }
		if (nr < 0 || nr >= this.cells.length) return;
		// After save() the DOM is rebuilt; find the new cell next frame.
		window.requestAnimationFrame(() => {
			const table = this.content.querySelector<HTMLTableElement>(".cp-table");
			const td = table?.rows[nr]?.cells[nc];
			if (td) this.editCell(td, nr, nc);
		});
	}

	private finishEditing() {
		this.editingCell?.blur();
		this.editingCell = null;
	}

	private bindReorder(handle: HTMLElement, axis: "row" | "col", index: number) {
		handle.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.stopPropagation();
			e.preventDefault();
			handle.setPointerCapture(e.pointerId);
			const table = this.tableEl;
			if (!table) return;
			const count = axis === "row" ? this.cells.length : this.cells[0].length;
			const startX = e.clientX;
			const startY = e.clientY;
			const scale = canvasScale(this.tb.view.canvas!);
			let dragging = false;
			let ghost: HTMLElement | null = null;
			let target = index;

			const setSrc = (on: boolean) => {
				if (axis === "row") {
					table.rows[index]?.toggleClass("cp-drag-src", on);
				} else {
					for (const row of Array.from(table.rows)) {
						row.cells[index]?.toggleClass("cp-drag-src", on);
					}
				}
			};
			const moveGhost = (ev: PointerEvent) => {
				if (!ghost) return;
				const rr = this.rootEl!.getBoundingClientRect();
				if (axis === "row") {
					ghost.setCssStyles({ left: "0px" });
					ghost.style.top = `${(ev.clientY - rr.top) / scale - ghost.offsetHeight / 2}px`;
				} else {
					ghost.setCssStyles({ top: "0px" });
					ghost.style.left = `${(ev.clientX - rr.left) / scale - ghost.offsetWidth / 2}px`;
				}
			};
			// Drag begins only once the pointer moves past a small threshold — a plain
			// click instead SELECTS the row/column (so it can be deleted).
			const beginDrag = (ev: PointerEvent) => {
				dragging = true;
				this.clearLineSelection();
				handle.addClass("is-dragging");
				ghost = this.makeGhost(axis, index);
				setSrc(true);
				moveGhost(ev);
			};

			const onMove = (ev: PointerEvent) => {
				if (!dragging) {
					if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
					beginDrag(ev);
				} else {
					moveGhost(ev);
				}
				const rect = table.getBoundingClientRect();
				const t =
					axis === "row"
						? (ev.clientY - rect.top) / rect.height
						: (ev.clientX - rect.left) / rect.width;
				target = Math.max(0, Math.min(count - 1, Math.floor(t * count)));
				table.querySelectorAll("tr, td").forEach((el) =>
					el.removeClass("cp-drop-target")
				);
				if (target === index) return;
				if (axis === "row") {
					table.rows[target]?.addClass("cp-drop-target");
				} else {
					for (const row of Array.from(table.rows)) {
						row.cells[target]?.addClass("cp-drop-target");
					}
				}
			};
			const onUp = () => {
				handle.removeEventListener("pointermove", onMove);
				handle.removeEventListener("pointerup", onUp);
				if (!dragging) {
					// A click — select this row/column (toggle off if already selected).
					if (this.selected && this.selected.axis === axis && this.selected.index === index) {
						this.clearLineSelection();
					} else {
						this.selectLine(axis, index);
					}
					return;
				}
				handle.removeClass("is-dragging");
				ghost?.remove();
				setSrc(false);
				if (target !== index) {
					if (axis === "row") {
						const [row] = this.cells.splice(index, 1);
						this.cells.splice(target, 0, row);
						const [h] = this.rowH.splice(index, 1);
						this.rowH.splice(target, 0, h);
					} else {
						for (const row of this.cells) {
							const [cell] = row.splice(index, 1);
							row.splice(target, 0, cell);
						}
						const [w] = this.colW.splice(index, 1);
						this.colW.splice(target, 0, w);
					}
					this.save();
				} else {
					this.render(); // clear drop indicators
				}
			};
			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", onUp);
		});
	}

	/** Highlight a clicked row/column and show its delete button. */
	private selectLine(axis: "row" | "col", index: number) {
		this.clearLineSelection();
		const table = this.tableEl;
		const root = this.rootEl;
		if (!table || !root) return;
		this.selected = { axis, index };
		// Highlight the line's cells + its handle.
		const handles = axis === "row" ? this.rowHandles : this.colHandles;
		handles[index]?.addClass("is-selected");
		this.lineCells(axis, index).forEach((td) => td.addClass("cp-line-selected"));

		// Delete button next to the handle.
		const btn = (this.deleteBtnEl = root.createDiv({
			cls: "cp-table-delete",
			attr: { "aria-label": axis === "row" ? "Delete row" : "Delete column" },
		}));
		setIcon(btn, "trash-2");
		btn.addEventListener("pointerdown", (ev) => {
			ev.stopPropagation();
			ev.preventDefault();
			this.deleteLine(axis, index);
		});
		this.positionDeleteBtn();

		// Click anywhere outside the table clears the selection.
		this.lineSelOutside = (ev: PointerEvent) => {
			if (!root.contains(ev.target as Node)) this.clearLineSelection();
		};
		this.doc.addEventListener("pointerdown", this.lineSelOutside, true);
		// Delete / Backspace removes the selected line (and is kept from deleting the
		// whole canvas node).
		this.lineSelKey = (ev: KeyboardEvent) => {
			if ((ev.key === "Delete" || ev.key === "Backspace") && !this.isEditing()) {
				ev.preventDefault();
				ev.stopPropagation();
				this.deleteLine(axis, index);
			} else if (ev.key === "Escape") {
				this.clearLineSelection();
			}
		};
		this.doc.addEventListener("keydown", this.lineSelKey, true);
	}

	/** The <td>s belonging to a given row or column. */
	private lineCells(axis: "row" | "col", index: number): HTMLTableCellElement[] {
		const table = this.tableEl;
		if (!table) return [];
		if (axis === "row") return Array.from(table.rows[index]?.cells ?? []);
		return Array.from(table.rows).map((r) => r.cells[index]).filter(Boolean);
	}

	private positionDeleteBtn() {
		const btn = this.deleteBtnEl;
		const sel = this.selected;
		if (!btn || !sel) return;
		const handle = (sel.axis === "row" ? this.rowHandles : this.colHandles)[sel.index];
		if (!handle) return;
		// Sit just beyond the handle (which is already outside the grid edge).
		if (sel.axis === "row") {
			btn.style.top = handle.style.top;
			btn.setCssStyles({ left: "-34px" });
		} else {
			btn.style.left = handle.style.left;
			btn.setCssStyles({ top: "-34px" });
		}
	}

	private clearLineSelection() {
		if (this.selected) {
			const { axis, index } = this.selected;
			(axis === "row" ? this.rowHandles : this.colHandles)[index]?.removeClass("is-selected");
			this.lineCells(axis, index).forEach((td) => td.removeClass("cp-line-selected"));
		}
		this.selected = null;
		this.deleteBtnEl?.remove();
		this.deleteBtnEl = null;
		if (this.lineSelOutside) {
			this.doc.removeEventListener("pointerdown", this.lineSelOutside, true);
			this.lineSelOutside = null;
		}
		if (this.lineSelKey) {
			this.doc.removeEventListener("keydown", this.lineSelKey, true);
			this.lineSelKey = null;
		}
	}

	private deleteLine(axis: "row" | "col", index: number) {
		const rows = this.cells.length;
		const cols = this.cells[0]?.length ?? 0;
		// Keep at least a 1×1 grid.
		if ((axis === "row" && rows <= 1) || (axis === "col" && cols <= 1)) {
			new Notice("Canvas Kit: a table needs at least one row and column.");
			return;
		}
		if (axis === "row") {
			this.cells.splice(index, 1);
			this.rowH.splice(index, 1);
		} else {
			for (const row of this.cells) row.splice(index, 1);
			this.colW.splice(index, 1);
		}
		this.clearLineSelection();
		this.save();
	}

	/** Detached copy of a row/column that follows the pointer while reordering. */
	private makeGhost(axis: "row" | "col", index: number): HTMLElement {
		const t = this.tableEl!;
		const g = this.rootEl!.createDiv({ cls: "cp-table-ghost" });
		const gt = g.createEl("table", { cls: "cp-table" });
		if (axis === "row") {
			const src = t.rows[index];
			const tr = gt.createEl("tr");
			Array.from(src?.cells ?? []).forEach((cell) => {
				const td = tr.createEl("td");
				td.setText(cell.textContent ?? "");
				td.style.width = `${cell.offsetWidth}px`;
			});
			tr.style.height = `${src?.offsetHeight ?? TABLE_CELL_H}px`;
			g.style.width = `${t.offsetWidth}px`;
		} else {
			Array.from(t.rows).forEach((row) => {
				const cell = row.cells[index];
				const tr = gt.createEl("tr");
				const td = tr.createEl("td");
				td.setText(cell?.textContent ?? "");
				td.style.width = `${cell?.offsetWidth ?? TABLE_CELL_W}px`;
				tr.style.height = `${row.offsetHeight}px`;
			});
			g.style.width = `${t.rows[0]?.cells[index]?.offsetWidth ?? TABLE_CELL_W}px`;
		}
		gt.setCssStyles({ width: "100%" });
		return g;
	}

	private save() {
		const md = mdFromCells(this.cells);
		this.renderedText = md;
		// Write text + grid sizes in one data update when possible.
		if (this.node.getData && this.node.setData) {
			try {
				const data = this.node.getData();
				data.text = md;
				data.pencilCols = this.colW.slice();
				data.pencilRows = this.rowH.slice();
				this.node.setData(data);
			} catch (err) {
				console.warn("Canvas Kit: setData failed, falling back", err);
				setNodeText(this.node, md);
			}
		} else {
			setNodeText(this.node, md);
		}
		this.tb.view.canvas?.requestSave?.();
		pushCanvasHistory(this.tb.view.canvas);
		// Obsidian may re-render the node content after the text change; rebuild
		// our widget over it now and once more after its render settles.
		this.render();
		window.setTimeout(() => {
			if (!this.content.querySelector(".cp-table")) this.render();
			else this.tb.refreshNodeStyles();
		}, 150);
	}
}

function canvasScale(canvas: CanvasLike): number {
	if (typeof canvas.posFromEvt !== "function") return 1;
	const rect = canvas.wrapperEl.getBoundingClientRect();
	const a = canvas.posFromEvt({ clientX: rect.left, clientY: rect.top });
	const b = canvas.posFromEvt({ clientX: rect.left + 100, clientY: rect.top });
	const d = b.x - a.x;
	return d !== 0 ? 100 / d : 1; // screen px per canvas unit
}

function sumArr(a: number[]): number {
	return a.reduce((s, n) => s + n, 0);
}

/** Frameless ink: re-assert the bare SVG after Obsidian re-renders the node.
 *  The frameless chrome (no border/background/padding, overflow visible) lives in
 *  CSS on `.canvas-pencil-ink`; selection box-shadow is left alone. */
function enforceInkVisual(el: HTMLElement, text: string) {
	if (/<\s*script/i.test(text)) return;
	const content = el.querySelector<HTMLElement>(".canvas-node-content");
	if (!content) return;
	// Obsidian's markdown renderer may render the svg itself, but buried in
	// padded wrappers — only a bare direct child counts.
	const direct = content.firstElementChild;
	const isBareSvg =
		content.children.length === 1 && direct?.tagName.toLowerCase() === "svg";
	if (!isBareSvg) setSvg(content, text);
}

function blockDblClick(el: HTMLElement) {
	if (el.dataset.cpNoDbl) return;
	el.dataset.cpNoDbl = "1";
	el.addEventListener(
		"dblclick",
		(e) => {
			e.preventDefault();
			e.stopImmediatePropagation();
		},
		true
	);
}

function setNodeText(node: CanvasNodeLike, text: string) {
	const anyNode = node as unknown as { setText?: (t: string) => void };
	if (typeof anyNode.setText === "function") {
		anyNode.setText(text);
	} else if (node.getData && node.setData) {
		const data = node.getData();
		data.text = text;
		node.setData(data);
	}
}

function parseMdTable(text: string): string[][] | null {
	const lines = text.split("\n").filter((l) => l.trim().startsWith("|"));
	const rows: string[][] = [];
	for (const line of lines) {
		// Skip the header separator row (| --- | --- |).
		if (/^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-")) continue;
		const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
		rows.push(
			inner
				.split(/(?<!\\)\|/)
				.map((c) => c.trim().replace(/\\\|/g, "|"))
		);
	}
	if (!rows.length) return null;
	// Normalize ragged rows to the widest width.
	const width = Math.max(...rows.map((r) => r.length));
	for (const r of rows) while (r.length < width) r.push("");
	return rows;
}

function mdFromCells(cells: string[][]): string {
	const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
	const row = (r: string[]) => "| " + r.map((c) => esc(c) || "   ").join(" | ") + " |";
	return [
		row(cells[0]),
		"|" + cells[0].map(() => " --- ").join("|") + "|",
		...cells.slice(1).map(row),
	].join("\n");
}

function tagNode(node: CanvasNodeLike, kind: "text" | "table") {
	try {
		// unknownData is how Obsidian round-trips unrecognized node fields.
		if (node.unknownData) node.unknownData.pencilType = kind;
		if (node.getData && node.setData) {
			const data = node.getData();
			data.pencilType = kind;
			node.setData(data);
		}
	} catch (err) {
		console.warn("Canvas Kit: couldn't tag node", err);
	}
}

function pencilKind(node: CanvasNodeLike): string | undefined {
	const fromData = node.getData?.()?.pencilType;
	if (typeof fromData === "string") return fromData;
	const fromUnknown = node.unknownData?.pencilType;
	return typeof fromUnknown === "string" ? fromUnknown : undefined;
}

// ---------- Ink SVG builders ----------

interface InkSvg {
	svg: string;
	box: { x: number; y: number; width: number; height: number };
}

function buildStrokesSvg(strokes: PencilStroke[]): InkSvg | null {
	const PAD = 8;
	const parts: string[] = [];
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	const grow = (x: number, y: number) => {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	};

	for (const stroke of strokes) {
		if (stroke.highlight) {
			// Flat chisel: constant-width stroked ribbon with flat (butt) ends.
			if (stroke.worldPts.length < 2) continue;
			const half = stroke.size / 2;
			for (const [x, y] of stroke.worldPts) { grow(x - half, y - half); grow(x + half, y + half); }
			const d =
				`M${r2(stroke.worldPts[0][0])} ${r2(stroke.worldPts[0][1])}` +
				stroke.worldPts.slice(1).map(([x, y]) => `L${r2(x)} ${r2(y)}`).join("");
			parts.push(
				`<path d="${d}" fill="none" stroke="currentColor" stroke-width="${stroke.size}" stroke-opacity="${HIGHLIGHT_OPACITY}" stroke-linecap="butt" stroke-linejoin="round"/>`
			);
		} else {
			const outline = getStroke(stroke.worldPts, {
				size: stroke.size,
				thinning: 0,
				smoothing: 0.5,
				streamline: 0.4,
				simulatePressure: false,
			});
			if (outline.length < 2) continue;
			for (const [x, y] of outline) grow(x, y);
			parts.push(`<path d="${svgPathFromOutline(outline)}" fill="currentColor"/>`);
		}
	}
	if (!parts.length) return null;

	// Integer box == integer viewBox (no float/round mismatch). Aspect ratio is
	// preserved (default xMidYMid meet); because the node box aspect equals the
	// viewBox aspect exactly at creation, there is nothing to letterbox, so the
	// commit-time displacement is gone without distorting the stroke.
	const x = Math.floor(minX - PAD);
	const y = Math.floor(minY - PAD);
	const width = Math.max(1, Math.ceil(maxX + PAD) - x);
	const height = Math.max(1, Math.ceil(maxY + PAD) - y);

	// Paths use currentColor; the svg's own color is the drawn color, so the
	// stroke shows as drawn until Obsidian's node color (--canvas-color) overrides
	// it via CSS — letting the toolbar's color button recolor the stroke.
	const drawn = strokes[0]?.color ?? "#1e1e1e";
	const svg =
		`<svg class="${INK_MARK}" xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="${width}" height="${height}" style="color:${drawn}">${parts.join("")}</svg>`;
	return { svg, box: { x, y, width, height } };
}

function buildTapeSvg(
	a: { x: number; y: number },
	b: { x: number; y: number },
	patternId: string,
	customImage: string | null
): InkSvg | null {
	const len = Math.hypot(b.x - a.x, b.y - a.y);
	if (len < 20) return null;
	const ux = (b.x - a.x) / len;
	const uy = (b.y - a.y) / len;
	const vx = -uy;
	const vy = ux;
	const half = TAPE_THICKNESS / 2;
	const JAG = 7;
	const TEETH = 5;

	const pts: { x: number; y: number }[] = [];
	const edge = (
		from: { x: number; y: number },
		dirX: number, dirY: number,
		jagSignX: number, jagSignY: number
	) => {
		for (let i = 0; i <= TEETH * 2; i++) {
			const t = i / (TEETH * 2);
			const jag = i % 2 === 1 ? JAG : 0;
			pts.push({
				x: from.x + dirX * TAPE_THICKNESS * t + jagSignX * jag,
				y: from.y + dirY * TAPE_THICKNESS * t + jagSignY * jag,
			});
		}
	};
	edge({ x: a.x + vx * half, y: a.y + vy * half }, -vx, -vy, ux, uy);
	pts.push({ x: b.x - vx * half, y: b.y - vy * half });
	edge({ x: b.x - vx * half, y: b.y - vy * half }, vx, vy, -ux, -uy);

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of pts) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const PAD = 4;
	minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
	const width = Math.max(1, Math.round(maxX - minX));
	const height = Math.max(1, Math.round(maxY - minY));

	const d =
		`M${r2(pts[0].x)} ${r2(pts[0].y)}` +
		pts.slice(1).map((p) => `L${r2(p.x)} ${r2(p.y)}`).join("") +
		"Z";
	const angle = r2((Math.atan2(uy, ux) * 180) / Math.PI);
	const pid = `cpg${randomId().slice(0, 6)}`;

	let base: string;
	let defs: string;
	if (patternId === CUSTOM_TAPE_ID && customImage) {
		base = "#ffffff";
		defs =
			`<pattern id="${pid}" width="${CUSTOM_TILE}" height="${CUSTOM_TILE}" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})">` +
			`<image href="${customImage}" width="${CUSTOM_TILE}" height="${CUSTOM_TILE}" preserveAspectRatio="xMidYMid slice"/></pattern>`;
	} else {
		const pattern =
			TAPE_PATTERNS.find((p) => p.id === patternId) ?? TAPE_PATTERNS[0];
		base = pattern.base;
		defs = pattern.defs(pid, Number(angle));
	}

	const svg =
		`<svg class="${INK_MARK}" xmlns="http://www.w3.org/2000/svg" viewBox="${r2(minX)} ${r2(minY)} ${width} ${height}" width="${width}" height="${height}">` +
		`<defs>${defs}</defs>` +
		`<path d="${d}" fill="${base}"/>` +
		`<path d="${d}" fill="url(#${pid})"/>` +
		`</svg>`;
	return { svg, box: { x: Math.round(minX), y: Math.round(minY), width, height } };
}

function commitInkNode(tb: CanvasToolbar, ink: InkSvg | null) {
	if (!ink) return;
	const canvas = tb.view.canvas!;
	if (typeof canvas.createTextNode !== "function") {
		throw new Error("canvas.createTextNode unavailable");
	}
	canvas.createTextNode({
		pos: { x: ink.box.x, y: ink.box.y },
		size: { width: ink.box.width, height: ink.box.height },
		text: ink.svg,
		save: true,
		focus: false,
	});
	canvas.deselectAll?.();
	canvas.requestSave?.();
	pushCanvasHistory(canvas);
	tb.refreshNodeStyles();
}

// ---------- helpers ----------

function randomId(): string {
	return Math.random().toString(36).slice(2, 18);
}

function r2(n: number): string {
	return (Math.round(n * 100) / 100).toString();
}

function svgPathFromOutline(outline: number[][]): string {
	if (!outline.length) return "";
	let d = `M${r2(outline[0][0])} ${r2(outline[0][1])}`;
	for (let i = 1; i < outline.length; i++) {
		const [x0, y0] = outline[i - 1];
		const [x1, y1] = outline[i];
		d += ` Q${r2(x0)} ${r2(y0)} ${r2((x0 + x1) / 2)} ${r2((y0 + y1) / 2)}`;
	}
	return d + " Z";
}

// ---------- settings tab ----------

class CanvasPencilSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: CanvasPencilPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default marker color")
			.addColorPicker((cp) =>
				cp.setValue(this.plugin.settings.strokeColor).onChange(async (v) => {
					this.plugin.settings.strokeColor = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Default marker size")
			.setDesc("Stroke width in canvas units.")
			.addSlider((s) =>
				s
					.setLimits(2, 30, 1)
					.setValue(this.plugin.settings.strokeSize)
					.onChange(async (v) => {
						this.plugin.settings.strokeSize = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default text size")
			.setDesc("Starting font size for new text. Drag a node's handle to scale it; recolor via the node's color button.")
			.addSlider((s) =>
				s
					.setLimits(8, 120, 2)
					.setValue(this.plugin.settings.textSize)
					.onChange(async (v) => {
						this.plugin.settings.textSize = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Toolbar size")
			.setDesc("Scale Canvas Kit's toolbar. 100% is the default size.")
			.addSlider((s) =>
				s
					.setLimits(70, 160, 5)
					.setValue(Math.round((this.plugin.settings.toolbarScale || 1) * 100))
					.onChange(async (v) => {
						this.plugin.settings.toolbarScale = v / 100;
						await this.plugin.saveSettings();
						this.plugin.applyToolbarScale();
					})
			);

		new Setting(containerEl)
			.setName("Hide Obsidian's bottom bar")
			.setDesc(
				"Hide Obsidian's bottom add-to-canvas bar (add card / note / media). Canvas Kit's own toolbar replaces it."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.hideBottomBar).onChange(async (v) => {
					this.plugin.settings.hideBottomBar = v;
					await this.plugin.saveSettings();
					this.plugin.applyBottomBarVisibility();
				})
			);

		new Setting(containerEl)
			.setName("Custom tape image")
			.setDesc("Remove the image used by the tape tool's custom pattern.")
			.addButton((b) =>
				b.setButtonText("Remove image").onClick(async () => {
					this.plugin.settings.tapeImage = null;
					await this.plugin.saveSettings();
					new Notice("Custom tape image removed.");
				})
			);
	}
}