import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ═══════════════════════════════════════════════════════════════
//  MultiLoRALoader — HTML DOM Widget Frontend
// ═══════════════════════════════════════════════════════════════
//
//  Renders the entire LoRA list UI as HTML DOM elements inside a
//  single DOM widget registered via addDOMWidget().  Works on both
//  the legacy LiteGraph canvas renderer and Nodes 2.0 Vue renderer.
//
//  Data model: all LoRA rows are stored as a JSON string in
//  node.properties.lora_data.  A hidden "lora_data" widget bridges
//  the data to the Python backend for serialization.
//
//  LTX mode: when enabled, shows per-layer strength columns
//  (Vid, V2A, Aud, A2V, Other) for LTX2-specific LoRA control.
//  When disabled, only the STR column is shown and LoRAs are
//  applied uniformly via ComfyUI's standard loader.
// ═══════════════════════════════════════════════════════════════

/**
 * The LoRA filename list, shared by every node instance.
 *
 * ComfyUI sends this list once, inside the node definition, which each
 * node instance would otherwise capture in a closure at registration
 * time.  Refreshing node definitions builds a *new* node class, so nodes
 * already on the canvas would keep showing the old list until the page
 * was reloaded.  Keeping it at module scope lets refreshComboInNode()
 * below update the list for every live node.
 *
 * @type {string[]}
 */
let availableLoras = ["None"];

// ─────────────────────────────────────────────
//  User Preferences (per browser, all nodes)
// ─────────────────────────────────────────────

const PREFS_KEY = "multi_lora_loader.settings";
const PREF_DEFAULTS = { step: 0.05, default_strength: 0.8, hide_folders: false, json_help_open: false };
/** Shift always steps by this, whatever the coarse step is */
const FINE_STEP = 0.01;
/** Scrub: pixels of horizontal travel per step, after a small dead zone */
const SCRUB_PIXELS_PER_STEP = 4;
const SCRUB_DEAD_ZONE = 2;

const loadPrefs = () => {
    try {
        const stored = JSON.parse(window.localStorage?.getItem(PREFS_KEY) || "{}");
        return { ...PREF_DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
    } catch {
        return { ...PREF_DEFAULTS };
    }
};

let prefs = loadPrefs();

const savePrefs = () => {
    try {
        window.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
        // Storage blocked: the preference still applies for this session.
    }
};

/** Coarse step, guarded against bad stored values */
const getStep = () => {
    const s = Number(prefs.step);
    return Number.isFinite(s) && s > 0 ? s : PREF_DEFAULTS.step;
};

/** Model / CLIP strength a newly added LoRA row starts at */
const getDefaultStrength = () => {
    const s = Number(prefs.default_strength);
    return Number.isFinite(s) ? s : PREF_DEFAULTS.default_strength;
};

/** Every live MultiLoRALoader node, so preference changes re-render them all */
const _liveNodes = new Set();

// ─────────────────────────────────────────────
//  LoRA Rank Lookup (batched + cached)
// ─────────────────────────────────────────────
//
//  Ranks come from POST /multi_lora_loader/ranks, which reads only the
//  safetensors header and keeps a persistent server-side cache, so a
//  file is only read again if it changes.  Here, each name is fetched
//  at most once per page session: switching workflows renders straight
//  from _rankResults, and any new names requested in the same tick are
//  sent together in one request.

/** name -> rank info object (or null when unknown) */
const _rankResults = new Map();
/** name -> Promise<info|null>, for lookups in flight */
const _rankPending = new Map();
/** names waiting for the next batched request -> resolve fn */
let _rankQueue = new Map();
let _rankFlushScheduled = false;
/** Last defs object seen by refreshComboInNode (one clear per refresh) */
let _lastRefreshDefs = null;

const flushRankQueue = async () => {
    _rankFlushScheduled = false;
    const queue = _rankQueue;
    _rankQueue = new Map();
    const names = [...queue.keys()];
    let data = {};
    let ok = false;
    try {
        const resp = await api.fetchApi("/multi_lora_loader/ranks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ names }),
        });
        if (resp.ok) {
            data = await resp.json();
            ok = true;
        }
    } catch (err) {
        console.warn("[MultiLoRA] Rank lookup failed:", err);
    }
    for (const [name, resolve] of queue) {
        const info = data[name] ?? null;
        // On failure don't cache, so a later render can retry.
        if (ok) _rankResults.set(name, info);
        _rankPending.delete(name);
        resolve(info);
    }
};

/**
 * Returns a Promise for a LoRA's rank info, batching uncached lookups.
 * @param {string} name
 * @returns {Promise<{rank:number,min:number,max:number,alpha:?number}|null>}
 */
const fetchLoraRank = (name) => {
    if (_rankResults.has(name)) return Promise.resolve(_rankResults.get(name));
    if (_rankPending.has(name)) return _rankPending.get(name);
    const p = new Promise(resolve => _rankQueue.set(name, resolve));
    _rankPending.set(name, p);
    if (!_rankFlushScheduled) {
        _rankFlushScheduled = true;
        setTimeout(flushRankQueue, 0);
    }
    return p;
};

/**
 * Fills a rank label element from rank info.
 * @param {HTMLElement} el
 * @param {object|null} info
 */
const applyRankLabel = (el, info) => {
    if (info && !info.rank && info.kind) {
        el.textContent = `(${info.kind})`;
        el.title = `${info.kind} (no single rank)`;
        return;
    }
    if (!info || !info.rank) {
        el.textContent = "";
        el.title = "";
        return;
    }
    const mixed = info.min !== info.max;
    el.textContent = mixed ? `(r${info.min}-${info.max})` : `(r${info.rank})`;
    let title = mixed
        ? `LoRA rank varies by layer: ${info.min}–${info.max} (most common ${info.rank})`
        : `LoRA rank ${info.rank}`;
    if (info.alpha != null) title += `, alpha ${info.alpha}`;
    el.title = title;
};

// ─────────────────────────────────────────────
//  CSS Injection (once per page load)
// ─────────────────────────────────────────────

let _stylesInjected = false;

function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;

    const style = document.createElement("style");
    style.textContent = `
/* ── MultiLoRALoader DOM Widget Styles ── */

.mll-container {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11px;
    color: #ddd;
    user-select: none;
    -webkit-user-select: none;
    overflow: hidden;
    padding: 2px 0;
    width: 100%;
    box-sizing: border-box;
}

/* ── Header ── */

.mll-header {
    display: flex;
    align-items: center;
    height: 22px;
    padding: 0 4px;
    margin-bottom: 2px;
}

.mll-header-spacer {
    flex: 1 1 0;
    min-width: 125px;
}

.mll-col-label {
    width: 50px;
    flex: 0 0 50px;
    text-align: center;
    font-weight: bold;
    font-size: 10px;
    color: #ddd;
    letter-spacing: 0.3px;
}

.mll-cog-btn {
    flex: 0 0 auto;
    width: 22px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 3px;
    color: #ddd;
    font-size: 13px;
    cursor: pointer;
    margin-right: 2px;
    line-height: 1;
}
.mll-cog-btn:hover {
    background: #3a3a3a;
    color: #fff;
}

/* ── Settings Popup (cog) ── */

.mll-pop {
    position: fixed;
    z-index: 10000;
    width: 460px;
    max-width: calc(100vw - 16px);
    background: #1c1f23;
    border: 1px solid #3a4047;
    border-radius: 7px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
    font: 12px system-ui, sans-serif;
    color: #d7dde2;
    display: flex;
    flex-direction: column;
}
.mll-pop * { box-sizing: border-box; }

.mll-pop-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 10px;
    border-bottom: 1px solid #2c3238;
    color: #4CAF50;
    font-weight: 600;
}
.mll-pop-close {
    margin-left: auto;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: #9ba2aa;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
}
.mll-pop-close:hover { background: #2c3238; color: #fff; }

.mll-pop-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 10px 10px;
    max-height: 75vh;
    overflow-y: auto;
}
.mll-pop-body > * { flex-shrink: 0; }

.mll-pop-section {
    padding: 10px 0 3px;
    color: #9ba2aa;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.mll-pop-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 32px;
    padding: 3px 0;
}
.mll-pop-label { flex: 1 1 auto; min-width: 0; }
.mll-pop-hint {
    display: block;
    color: #9ba2aa;
    font-size: 10.5px;
    line-height: 1.35;
    margin-top: 1px;
}

.mll-pop-toggle {
    width: 30px;
    height: 16px;
    border-radius: 8px;
    border: none;
    background: #3a4047;
    cursor: pointer;
    position: relative;
    flex: none;
    padding: 0;
}
.mll-pop-toggle::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #9ba2aa;
    transition: left 0.12s;
}
.mll-pop-toggle.on { background: #4CAF50; }
.mll-pop-toggle.on::after { left: 16px; background: #fff; }

.mll-pop-input {
    width: 72px;
    height: 24px;
    flex: none;
    padding: 0 4px 0 8px;
    border: 1px solid #3a4047;
    border-radius: 5px;
    background: #23272c;
    color: inherit;
    font: inherit;
    text-align: center;
    outline: none;
}
.mll-pop-input:focus { border-color: #4CAF50; }

.mll-pop-text {
    color: #b9c2c9;
    line-height: 1.45;
    padding: 2px 0 6px;
}

.mll-pop-help {
    margin: 0 0 8px;
    border: 1px solid #2c3238;
    border-radius: 5px;
    background: #202428;
}
.mll-pop-help > summary {
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    color: #b9c2c9;
    font-size: 11px;
    cursor: pointer;
    user-select: none;
}
.mll-pop-help > summary::-webkit-details-marker { display: none; }
.mll-pop-help > summary::before {
    content: "\\25B8";
    color: #4CAF50;
    font-size: 10px;
    transition: transform 0.12s;
}
.mll-pop-help[open] > summary::before { transform: rotate(90deg); }
.mll-pop-help > summary:hover { color: #fff; }
.mll-pop-help[open] > summary { border-bottom: 1px solid #2c3238; }
.mll-pop-help-body { padding: 6px 8px 0; }

.mll-pop-keys {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 3px 10px;
    padding: 0 0 8px;
    font-size: 11px;
}
.mll-pop-keys .term {
    color: #4CAF50;
    font-family: ui-monospace, Consolas, monospace;
    font-weight: 600;
    white-space: nowrap;
}
.mll-pop-keys .detail { color: #9ba2aa; line-height: 1.35; }

.mll-pop-json {
    width: 100%;
    min-height: 90px;
    max-height: 45vh;
    resize: vertical;
    padding: 7px 8px;
    border: 1px solid #3a4047;
    border-radius: 5px;
    background: #15181b;
    color: #d7dde2;
    font: 11px/1.45 ui-monospace, Consolas, monospace;
    white-space: pre;
    overflow: auto;
    outline: none;
    tab-size: 2;
}
.mll-pop-json:focus { border-color: #4CAF50; }
.mll-pop-json.invalid { border-color: #f44336; }

.mll-pop-status {
    min-height: 16px;
    padding-top: 4px;
    font-size: 11px;
    color: #9ba2aa;
}
.mll-pop-status.error { color: #ff8a80; }
.mll-pop-status.ok { color: #4CAF50; }

.mll-pop-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 10px;
    border-top: 1px solid #2c3238;
}
.mll-pop-btn {
    height: 24px;
    border: 1px solid #3a4047;
    border-radius: 5px;
    background: #23272c;
    color: #d7dde2;
    cursor: pointer;
    padding: 0 12px;
    font: inherit;
}
.mll-pop-btn:hover { border-color: #4CAF50; }
.mll-pop-btn.primary { border-color: #4CAF50; color: #4CAF50; }
.mll-pop-btn.primary:hover { background: #4CAF50; color: #0b2410; }
.mll-pop-foot .spacer { flex: 1; }

/* ── Row Container ── */

.mll-rows {
    display: flex;
    flex-direction: column;
}

/* ── Individual Row ── */

.mll-row {
    display: flex;
    align-items: center;
    height: 24px;
    padding: 0 4px;
    border-radius: 2px;
    transition: background 0.08s;
}

.mll-row:nth-child(odd) {
    background: rgba(0, 0, 0, 0.1);
}
.mll-row:nth-child(even) {
    background: rgba(255, 255, 255, 0.03);
}

.mll-row.mll-dragging {
    background: rgba(100, 150, 255, 0.25) !important;
    outline: 1.5px solid rgba(100, 150, 255, 0.6);
    z-index: 10;
}

.mll-row.mll-drop-above {
    border-top: 2px solid rgba(100, 150, 255, 0.7);
}

.mll-row.mll-drop-below {
    border-bottom: 2px solid rgba(100, 150, 255, 0.7);
}

.mll-row.mll-disabled {
    opacity: 0.35;
}

/* ── Empty Slot ── */

.mll-name.mll-empty-slot {
    margin: 0 4px;
    height: 18px;
    line-height: 16px;
    border: 1px dashed rgba(255, 255, 255, 0.22);
    border-radius: 3px;
    color: #888;
    font-style: italic;
}
.mll-name.mll-empty-slot bdi {
    direction: ltr;
}
.mll-name.mll-empty-slot:hover {
    border-color: #4CAF50;
    color: #ddd;
}
.mll-row.mll-none-lora .mll-toggle-dot {
    opacity: 0.5;
}

/* ── Divider ── */

.mll-row.mll-divider {
    background: transparent !important;
    gap: 8px;
}
.mll-divider-label {
    flex: 0 1 auto;
    min-width: 0;
    padding-left: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #4CAF50;
    font-weight: bold;
    font-size: 11px;
    letter-spacing: 0.3px;
    cursor: default;
}
.mll-divider-line {
    flex: 1 1 0;
    height: 1px;
    margin-left: 4px;
    background: linear-gradient(to right, rgba(76, 175, 80, 0.6), rgba(76, 175, 80, 0.08));
}

.mll-row.mll-missing-lora .mll-name bdi {
    text-decoration: line-through;
    color: #f44336;
}

/* ── Grip ── */

.mll-grip {
    flex: 0 0 18px;
    text-align: center;
    cursor: grab;
    font-size: 12px;
    color: #aaa;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 2px;
    line-height: 20px;
    height: 20px;
}
.mll-grip:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #ddd;
}

/* ── Toggle ── */

.mll-toggle {
    flex: 0 0 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.mll-toggle-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    transition: background 0.1s;
}

.mll-toggle-dot.mll-on    { background: #4CAF50; }
.mll-toggle-dot.mll-off   { background: #f44336; }
.mll-toggle-dot.mll-empty { background: #888; }

/* ── LoRA Name ── */

.mll-name {
    flex: 1 1 0;
    min-width: 150px;
    display: flex;
    align-items: center;
    padding: 0 4px;
    cursor: pointer;
    font-size: 11px;
    line-height: 24px;
    color: #ddd;
}

.mll-name bdi {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
}

.mll-name:hover {
    color: #fff;
}

/* ── Number Cell ── */

.mll-num {
    flex: 0 0 46px;
    height: 16px;
    background: #111;
    border-radius: 2px;
    text-align: center;
    line-height: 16px;
    font-size: 11px;
    color: #00FFCC;
    cursor: ew-resize;
    margin: 0 2px;
    overflow: hidden;
}

.mll-num:hover {
    background: #1a1a1a;
}

/* ── Trash ── */

.mll-trash {
    flex: 0 0 24px;
    text-align: center;
    color: #f44336;
    cursor: pointer;
    font-size: 13px;
    line-height: 24px;
}
.mll-trash:hover {
    color: #ff6659;
}

/* ── Add Buttons ── */

.mll-add-bar {
    display: flex;
    gap: 4px;
    margin: 4px 4px 2px;
}

.mll-add-btn {
    flex: 1 1 auto;
    margin: 0;
    padding: 5px 0;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 4px;
    color: #ddd;
    font-size: 11px;
    font-family: inherit;
    text-align: center;
    cursor: pointer;
    transition: background 0.1s;
}
.mll-add-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
}
.mll-add-btn.mll-add-divider {
    flex: 0 0 auto;
    padding: 5px 14px;
    color: #4CAF50;
}

/* ── Drag-and-Drop Overlay ── */

.mll-container.mll-drag-over {
    outline: 2px solid rgba(100, 150, 255, 0.7);
    outline-offset: -2px;
    background: rgba(100, 150, 255, 0.08);
}

/* ── Rank Label ── */

.mll-rank {
    color: #999;
    font-size: 10px;
    margin-left: 4px;
    flex: 0 0 auto;
    white-space: nowrap;
}

/* ── Info Badge ── */

.mll-info-badge {
    color: #888;
    font-size: 11px;
    font-weight: 900;
    margin-left: 4px;
    flex: 0 0 auto;
    cursor: pointer;
    text-shadow: 0 0 1px currentColor;
}

.mll-info-badge.mll-info-civitai {
    color: #4CAF50;
}

.mll-info-badge.mll-info-notfound {
    text-decoration: line-through;
}
`;
    document.head.appendChild(style);
}


// ═══════════════════════════════════════════════════════════════
//  Extension Registration
// ═══════════════════════════════════════════════════════════════

app.registerExtension({
    name: "phazei.MultiLoRALoader",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "MultiLoRALoader") return;

        availableLoras = nodeData.input.hidden.available_loras[0];

        // ─────────────────────────────────────────────
        //  Constants
        // ─────────────────────────────────────────────

        const MIN_WIDTH = 500;

        /** Always-visible base column */
        const STR_DEF   = { key: "str",  label: "STR"  };
        /** Optional CLIP column (shown when clip_mode is on) */
        const CLIP_DEF  = { key: "clip", label: "CLIP" };
        /** LTX-specific columns (shown when ltx_mode is on) */
        const LTX_DEFS  = [
            { key: "vid",   label: "Vid"   },
            { key: "v2a",   label: "V2A"   },
            { key: "aud",   label: "Aud"   },
            { key: "a2v",   label: "A2V"   },
            { key: "other", label: "Other" },
        ];

        /**
         * Creates a new LoRA row.  Model / CLIP strength start at the
         * "Default strength" preference; the LTX layer values are
         * multipliers on top of that, so they start at 1.0.
         */
        /**
         * A divider is a "None" row carrying a `label`.  Everything that
         * applies or cycles LoRAs already skips "None" rows, so dividers
         * need no backend support.  An empty label draws a plain line.
         * @param {object} row
         * @returns {boolean}
         */
        const isDividerRow = (row) => row.lora === "None" && typeof row.label === "string";

        const makeEmptyRow = (lora = "None", on = true) => {
            const s = getDefaultStrength();
            return {
                on, lora,
                str: s, clip: s,
                vid: 1.0, v2a: 1.0, aud: 1.0, a2v: 1.0, other: 1.0
            };
        };

        // ─────────────────────────────────────────────
        //  LTX Mode Helpers
        // ─────────────────────────────────────────────

        /**
         * Reads the current ltx_mode value from the hidden widget.
         * @param {LGraphNode} node
         * @returns {boolean}
         */
        const getLtxMode = (node) => {
            const w = node.widgets?.find(w => w.name === "ltx_mode");
            return w ? w.value : false;
        };

        /**
         * Sets the ltx_mode value on the hidden widget.
         * @param {LGraphNode} node
         * @param {boolean} val
         */
        const setLtxMode = (node, val) => {
            const w = node.widgets?.find(w => w.name === "ltx_mode");
            if (w) w.value = val;
        };

        /**
         * Reads the current clip_mode value from the hidden widget.
         * @param {LGraphNode} node
         * @returns {boolean}
         */
        const getClipMode = (node) => {
            const w = node.widgets?.find(w => w.name === "clip_mode");
            return w ? w.value : false;
        };

        /**
         * Sets the clip_mode value on the hidden widget.
         * @param {LGraphNode} node
         * @param {boolean} val
         */
        const setClipMode = (node, val) => {
            const w = node.widgets?.find(w => w.name === "clip_mode");
            if (w) w.value = val;
        };

        /**
         * Returns the column definitions to display based on the active
         * modes.  Order: STR, [CLIP], then the LTX columns.
         * @param {LGraphNode} node
         * @returns {Array}
         */
        const getVisibleNumDefs = (node) => {
            const defs = [STR_DEF];
            if (getClipMode(node)) defs.push(CLIP_DEF);
            if (getLtxMode(node)) defs.push(...LTX_DEFS);
            return defs;
        };

        // ─────────────────────────────────────────────
        //  rgthree LoRA Info Dialog (lazy-loaded)
        // ─────────────────────────────────────────────

        let _RgthreeLoraInfoDialog = null;
        let _LoraInfoService = null;
        const _loraInfoCache = new Map();

        const getLoraInfoService = async () => {
            if (!_LoraInfoService) {
                try {
                    const mod = await import("/rgthree/common/model_info_service.js");
                    _LoraInfoService = mod.LORA_INFO_SERVICE;
                } catch (err) {
                    console.warn("[MultiLoRA] rgthree-comfy LoRA info service not available:", err);
                }
            }
            return _LoraInfoService;
        };

        /**
         * Updates an existing info badge's color/title based on info.
         * Green when any info (Civitai or local) is available, gray otherwise.
         * @param {HTMLElement} badge
         * @param {object|null} info
         */
        const updateInfoBadge = (badge, info) => {
            const civitai = info?.raw?.civitai;
            const fetched = !!civitai;
            // Civitai's by-hash endpoint returns an { error } payload (and no
            // modelId) when the model isn't found.
            const notFound = fetched && (!!civitai.error || !civitai.modelId);
            const found = fetched && !notFound;
            badge.classList.toggle("mll-info-civitai", found);
            badge.classList.toggle("mll-info-notfound", notFound);
            badge.title = found
                ? "Civitai info available"
                : notFound
                    ? "Model not found on Civitai"
                    : "No Civitai info";
        };

        /**
         * Opens the rgthree LoRA info dialog. Returns the dialog
         * instance (or null if rgthree is unavailable) so callers
         * can listen for the "close" event.
         * @param {string} loraName
         * @returns {Promise<EventTarget|null>}
         */
        const showLoraInfo = async (loraName) => {
            if (!_RgthreeLoraInfoDialog) {
                try {
                    const mod = await import("/extensions/rgthree-comfy/dialog_info.js");
                    _RgthreeLoraInfoDialog = mod.RgthreeLoraInfoDialog;
                } catch (err) {
                    console.warn("[MultiLoRA] rgthree-comfy LoRA info dialog not available:", err);
                }
                if (!_RgthreeLoraInfoDialog) return null;
            }
            return new _RgthreeLoraInfoDialog(loraName).show();
        };

        // ─────────────────────────────────────────────
        //  Prompt Helper
        // ─────────────────────────────────────────────

        /**
         * Wrapper around canvas.prompt() that adds outside-click-to-close
         * behavior for Nodes 2.0.
         *
         * @param {string}   title    - Dialog title
         * @param {*}        value    - Initial value
         * @param {Function} callback - Called with the entered value
         * @param {Event}    event    - Positioning event (needs clientX/clientY)
         * @returns {HTMLElement|null} The dialog element
         */
        const showPrompt = (title, value, callback, event) => {
            const canvas = app.canvas;
            if (!canvas || typeof canvas.prompt !== "function") return null;

            const dialog = canvas.prompt(title, value, callback, event);
            if (!dialog) return null;

            // Add outside-click close for Nodes 2.0 compatibility
            setTimeout(() => {
                const onOutsideClick = (e) => {
                    if (dialog.contains(e.target)) return;
                    dialog.close();
                    document.removeEventListener("pointerdown", onOutsideClick, true);
                };
                document.addEventListener("pointerdown", onOutsideClick, true);

                const origClose = dialog.close.bind(dialog);
                dialog.close = () => {
                    document.removeEventListener("pointerdown", onOutsideClick, true);
                    origClose();
                };
            }, 60);
            return dialog;
        };

        // ─────────────────────────────────────────────
        //  Backend Sync
        // ─────────────────────────────────────────────

        /**
         * Pushes the UI data into the hidden widget that ComfyUI serialises
         * for Python.  Only rows with a LoRA selected (lora !== "None") are
         * sent.
         *
         * @param {LGraphNode} node
         */
        const syncToBackend = (node) => {
            const widget = node.widgets?.find(w => w.name === "lora_data");
            if (!widget) return;

            const allRows = JSON.parse(node.properties.lora_data || "[]");

            // With CLIP mode off the backend patches CLIP at "str", so keep
            // "clip" mirroring it.  Otherwise a stale hidden value would
            // resurface when the CLIP column is switched on.
            if (!getClipMode(node)) {
                let changed = false;
                for (const row of allRows) {
                    if (row.str !== undefined && row.clip !== row.str) {
                        row.clip = row.str;
                        changed = true;
                    }
                }
                if (changed) node.properties.lora_data = JSON.stringify(allRows);
            }

            const selectedRows = allRows.filter(row => row.lora !== "None");
            widget.value = JSON.stringify(selectedRows);
        };

        // ─────────────────────────────────────────────
        //  Height Calculation
        // ─────────────────────────────────────────────

        /**
         * Computes the desired DOM widget height based on row count.
         *
         * @param {LGraphNode} node
         * @returns {number} Height in pixels
         */
        const computeWidgetHeight = (node) => {
            const data = JSON.parse(node.properties.lora_data || "[]");
            // header(24) + rows(24 each) + add-btn(30) + padding(22)
            return 24 + (data.length * 24) + 30 + 22;
        };

        // ─────────────────────────────────────────────
        //  DOM Rendering
        // ─────────────────────────────────────────────

        /**
         * Formats a LoRA name for display: strips extension, keeps subpath.
         *
         * @param {string} loraPath
         * @returns {string}
         */
        const formatLoraName = (loraPath) => {
            if (!loraPath || loraPath === "None") return "None";
            let name = loraPath.replace(/\.[^.]+$/, "");
            if (prefs.hide_folders) name = name.split(/[/\\]/).pop();
            return name;
        };

        // ─────────────────────────────────────────────
        //  Drag-and-Drop Helpers
        // ─────────────────────────────────────────────

        /** File extensions recognised as LoRA weights */
        const LORA_EXTENSIONS = [".safetensors", ".ckpt", ".pt", ".bin"];

        /**
         * Returns all entries in loraList whose basename matches the
         * given filename (case-insensitive).
         *
         * @param {string}   filename - Basename from a dropped File object
         * @param {string[]} loraList - Currently available LoRA paths
         * @returns {string[]} Matching LoRA paths (may be empty)
         */
        const matchLorasByFilename = (filename, loraList) => {
            const needle = filename.toLowerCase();
            return loraList.filter(loraPath => {
                if (loraPath === "None") return false;
                const basename = loraPath.split(/[/\\]/).pop().toLowerCase();
                return basename === needle;
            });
        };

        /**
         * Returns true if a DragEvent is carrying files.
         * @param {DragEvent} e
         * @returns {boolean}
         */
        const isDraggingFiles = (e) => !!e?.dataTransfer?.types?.includes("Files");

        /**
         * Core drop handler shared by both the DOM-widget container
         * listener and the prototype onDragDrop callback.
         *
         * Matches dropped LoRA filenames against the available list,
         * adds new rows, and alerts on any unmatched files.
         *
         * @param {LGraphNode} node
         * @param {FileList|File[]} files
         * @returns {boolean} true if any LoRA-like files were processed
         */
        const handleLoraFileDrop = (node, files) => {
            const droppedFiles = Array.from(files).filter(f =>
                LORA_EXTENSIONS.some(ext => f.name.toLowerCase().endsWith(ext))
            );
            if (droppedFiles.length === 0) return false;

            const loraList = availableLoras;
            const data = JSON.parse(node.properties.lora_data || "[]");
            const notFound = [];

            for (const file of droppedFiles) {
                const matches = matchLorasByFilename(file.name, loraList);
                if (matches.length === 0) {
                    notFound.push(file.name);
                    continue;
                }
                for (const loraPath of matches) {
                    // Skip if this LoRA is already in the list
                    if (data.some(row => row.lora === loraPath)) continue;
                    data.push(makeEmptyRow(loraPath, false));
                }
            }

            node.properties.lora_data = JSON.stringify(data);
            syncToBackend(node);
            resizeNode(node);

            if (node._mllRowsContainer && node._mllNodeData) {
                renderRows(node, node._mllRowsContainer, node._mllNodeData);
            }

            if (notFound.length > 0) {
                alert(
                    "The following files were not found in your LoRA library:\n\n"
                    + notFound.join("\n")
                    + "\n\nDrag-and-drop matches by filename \u2014 it does not "
                    + "copy files. To use these LoRAs, copy them into your "
                    + "ComfyUI models/loras directory first, then refresh "
                    + "the browser and try again."
                );
            }

            return true;
        };

        // ─────────────────────────────────────────────
        //  Settings Popup (cog)
        // ─────────────────────────────────────────────

        const NUM_KEYS = ["str", "clip", "vid", "v2a", "aud", "a2v", "other"];

        /**
         * Validates parsed config JSON and fills in missing values.
         * Throws an Error with a user-facing message when invalid.
         *
         * @param {*} parsed
         * @returns {object[]}
         */
        const sanitizeConfig = (parsed) => {
            if (!Array.isArray(parsed)) {
                throw new Error("The config must be a list: [ {...}, {...} ]");
            }
            return parsed.map((row, i) => {
                if (!row || typeof row !== "object" || Array.isArray(row)) {
                    throw new Error(`Row ${i + 1} is not an object { ... }`);
                }
                if (row.lora !== undefined && typeof row.lora !== "string") {
                    throw new Error(`Row ${i + 1}: "lora" must be a string`);
                }
                const out = {
                    on:   row.on !== undefined ? !!row.on : true,
                    lora: row.lora || "None",
                };
                for (const key of NUM_KEYS) {
                    if (row[key] === undefined || row[key] === null) {
                        out[key] = 1.0;
                        continue;
                    }
                    const n = parseFloat(row[key]);
                    if (isNaN(n)) {
                        throw new Error(`Row ${i + 1}: "${key}" is not a number`);
                    }
                    out[key] = n;
                }
                if (row.label !== undefined && row.label !== null) {
                    if (out.lora !== "None") {
                        throw new Error(`Row ${i + 1}: a "label" row is a divider, so its "lora" must be "None"`);
                    }
                    out.label = String(row.label);
                }
                return out;
            });
        };

        /**
         * Pretty-prints rows one per line, so long stacks stay readable
         * and line-oriented edits (copy/delete a row) are easy.
         *
         * @param {object[]} rows
         * @returns {string}
         */
        const formatConfig = (rows) => {
            if (!rows.length) return "[]";
            return "[\n" + rows.map(r => "  " + JSON.stringify(r)).join(",\n") + "\n]";
        };

        /** The open popup, if any: { element, abort } */
        let _activePopup = null;

        const closeConfigPopup = () => {
            if (!_activePopup) return;
            _activePopup.abort.abort();
            _activePopup.element.remove();
            _activePopup = null;
        };

        const el = (tag, className, text) => {
            const e = document.createElement(tag);
            if (className) e.className = className;
            if (text !== undefined) e.textContent = text;
            return e;
        };

        /**
         * Opens the settings popup: mode toggles plus the config JSON editor.
         *
         * @param {LGraphNode}  node
         * @param {HTMLElement}  anchorEl      - Element to position next to
         * @param {HTMLElement}  headerEl
         * @param {object}       nodeData
         * @param {HTMLElement}  rowsContainer
         */
        const openConfigPopup = (node, anchorEl, headerEl, nodeData, rowsContainer) => {
            closeConfigPopup();

            const pop = el("div", "mll-pop");

            // ── Head ──
            const head = el("div", "mll-pop-head");
            const close = el("button", "mll-pop-close", "\u00D7");
            close.type = "button";
            close.title = "Close (Esc)";
            close.addEventListener("click", closeConfigPopup);
            head.append(el("span", "", "\u2699"), el("span", "", "Multi LoRA Loader settings"), close);

            const body = el("div", "mll-pop-body");

            // Filled in once the JSON box below exists.
            let textarea = null;
            let appliedText = "";
            let refreshJson = () => {};

            // ── Mode toggles ──
            body.append(el("div", "mll-pop-section", "This node \u2014 strength columns"));

            const addToggle = (label, hint, get, set) => {
                const row = el("div", "mll-pop-row");
                const labelBox = el("div", "mll-pop-label", label);
                labelBox.append(el("span", "mll-pop-hint", hint));
                const toggle = el("button", "mll-pop-toggle" + (get(node) ? " on" : ""));
                toggle.type = "button";
                toggle.addEventListener("click", () => {
                    const next = !toggle.classList.contains("on");
                    toggle.classList.toggle("on", next);
                    set(node, next);
                    renderHeader(node, headerEl, nodeData, rowsContainer);
                    renderRows(node, rowsContainer, nodeData);
                    resizeNode(node);
                    // Show any CLIP values the sync just linked to STR,
                    // unless the user has unapplied edits in the box.
                    if (textarea.value === appliedText) refreshJson();
                });
                row.append(labelBox, toggle);
                body.append(row);
            };

            addToggle(
                "Separate CLIP strength",
                "Adds a CLIP column so each LoRA can patch the text encoder at its "
                    + "own strength. Off: STR is used for both model and CLIP, "
                    + "so switching it on starts each CLIP at its STR.",
                getClipMode, setClipMode,
            );
            addToggle(
                "LTX per-layer strengths",
                "For LTX-2 audio/video models. Adds Vid, V2A, Aud, A2V and Other "
                    + "columns to scale each layer group separately. CLIP is "
                    + "passed through unchanged in this mode.",
                getLtxMode, setLtxMode,
            );

            // ── Preferences (all nodes, this browser) ──
            body.append(el("div", "mll-pop-section", "Preferences \u2014 all Multi LoRA nodes"));

            const rerenderAll = () => {
                for (const n of _liveNodes) {
                    if (n._mllRowsContainer && n._mllNodeData) {
                        renderRows(n, n._mllRowsContainer, n._mllNodeData);
                    }
                }
            };

            /**
             * A number preference row.  `accept` returns the value to store
             * (rounded to 0.01) or null to reject; `get` reads it back.
             */
            const addNumberPref = (label, hint, key, get, { min, max, step, accept }) => {
                const row = el("div", "mll-pop-row");
                const labelBox = el("div", "mll-pop-label", label);
                labelBox.append(el("span", "mll-pop-hint", hint));
                const input = el("input", "mll-pop-input");
                input.type = "number";
                input.min = String(min);
                input.max = String(max);
                input.step = String(step);
                input.value = get().toFixed(2);
                const commitValue = () => {
                    const v = Math.round(parseFloat(input.value) * 100) / 100;
                    if (Number.isFinite(v) && accept(v)) {
                        prefs[key] = Math.min(Math.max(v, min), max);
                        savePrefs();
                    }
                    input.value = get().toFixed(2);
                };
                input.addEventListener("change", commitValue);
                input.addEventListener("keydown", (e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                        e.preventDefault();
                        commitValue();
                    }
                });
                row.append(labelBox, input);
                body.append(row);
            };

            addNumberPref(
                "Default strength",
                "Strength a newly added or dropped LoRA starts at.",
                "default_strength", getDefaultStrength,
                { min: -10, max: 10, step: 0.05, accept: () => true },
            );
            addNumberPref(
                "Strength step",
                "Scrub and arrow-key step. Shift always steps by 0.01.",
                "step", getStep,
                { min: 0.01, max: 1, step: 0.01, accept: (v) => v > 0 },
            );
            {
                const row = el("div", "mll-pop-row");
                const labelBox = el("div", "mll-pop-label", "Hide folder names");
                labelBox.append(el("span", "mll-pop-hint",
                    "Rows show just the file name; the full path stays in the "
                    + "tooltip and the picker keeps its folders."));
                const toggle = el("button", "mll-pop-toggle" + (prefs.hide_folders ? " on" : ""));
                toggle.type = "button";
                toggle.addEventListener("click", () => {
                    prefs.hide_folders = !prefs.hide_folders;
                    toggle.classList.toggle("on", prefs.hide_folders);
                    savePrefs();
                    rerenderAll();
                });
                row.append(labelBox, toggle);
                body.append(row);
            }

            // ── Config JSON ──
            body.append(el("div", "mll-pop-section", "LoRA config (JSON)"));

            // Help text in a collapsible accordion; open/closed is remembered.
            const help = el("details", "mll-pop-help");
            help.open = !!prefs.json_help_open;
            help.addEventListener("toggle", () => {
                prefs.json_help_open = help.open;
                savePrefs();
            });
            help.append(el("summary", "", "How to use / what the fields mean"));

            const helpBody = el("div", "mll-pop-help-body");
            helpBody.append(el("div", "mll-pop-text",
                "Every row of this node, one LoRA per line. Copy it to share or "
                + "back up a stack, or edit / paste a config here and press Apply "
                + "(Ctrl+Enter). Missing values default to 1.0."));

            const keys = el("div", "mll-pop-keys");
            const keyDocs = [
                ["on", "true / false \u2014 whether the row is applied"],
                ["lora", "file path inside models/loras, as shown in the picker (\"None\" = empty slot)"],
                ["label", "makes a \"None\" row a divider with this heading (\"\" = plain line)"],
                ["str", "model strength"],
                ["clip", "CLIP strength (used when Separate CLIP strength is on; follows str while it's off)"],
                ["vid  v2a  aud  a2v  other", "LTX layer multipliers on str: video, video\u2192audio, audio, audio\u2192video, everything else (used in LTX mode)"],
            ];
            for (const [term, detail] of keyDocs) {
                keys.append(el("span", "term", term), el("span", "detail", detail));
            }
            helpBody.append(keys);
            help.append(helpBody);
            body.append(help);

            const data = JSON.parse(node.properties.lora_data || "[]");
            appliedText = formatConfig(data);
            textarea = el("textarea", "mll-pop-json");
            textarea.spellcheck = false;
            textarea.value = appliedText;
            textarea.rows = Math.min(Math.max(data.length + 2, 4), 16);
            body.append(textarea);

            const status = el("div", "mll-pop-status");
            body.append(status);

            /** Shows the node's stored config (as synced to the backend) */
            refreshJson = () => {
                appliedText = formatConfig(JSON.parse(node.properties.lora_data || "[]"));
                textarea.value = appliedText;
            };

            const setStatus = (text, kind) => {
                status.textContent = text;
                status.className = "mll-pop-status" + (kind ? " " + kind : "");
                textarea.classList.toggle("invalid", kind === "error");
            };

            /** Applies the textarea; returns false (and shows why) on error. */
            const applyJson = () => {
                let sanitized;
                try {
                    sanitized = sanitizeConfig(JSON.parse(textarea.value));
                } catch (err) {
                    setStatus(err instanceof SyntaxError ? "Invalid JSON: " + err.message : err.message, "error");
                    return false;
                }
                node.properties.lora_data = JSON.stringify(sanitized);
                syncToBackend(node);
                resizeNode(node);
                renderRows(node, rowsContainer, nodeData);
                refreshJson();
                const n = sanitized.length;
                setStatus(`Applied ${n} row${n === 1 ? "" : "s"}.`, "ok");
                return true;
            };

            textarea.addEventListener("input", () => {
                setStatus(textarea.value !== appliedText ? "Unapplied changes" : "", "");
            });
            textarea.addEventListener("keydown", (e) => {
                // Keep typing out of ComfyUI's shortcuts (Ctrl+Enter would queue).
                e.stopPropagation();
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    applyJson();
                } else if (e.key === "Tab" && !e.shiftKey) {
                    e.preventDefault();
                    textarea.setRangeText("  ", textarea.selectionStart, textarea.selectionEnd, "end");
                }
            });
            textarea.addEventListener("keyup", (e) => e.stopPropagation());

            // ── Foot ──
            const foot = el("div", "mll-pop-foot");
            const copyBtn = el("button", "mll-pop-btn", "Copy");
            copyBtn.type = "button";
            copyBtn.title = "Copy the JSON to the clipboard";
            copyBtn.addEventListener("click", async () => {
                try {
                    await navigator.clipboard.writeText(textarea.value);
                    setStatus("Copied to clipboard.", "ok");
                } catch {
                    textarea.select();
                    setStatus("Clipboard blocked \u2014 text selected, press Ctrl+C.", "");
                }
            });
            const applyBtn = el("button", "mll-pop-btn", "Apply");
            applyBtn.type = "button";
            applyBtn.title = "Apply the JSON to this node (Ctrl+Enter)";
            applyBtn.addEventListener("click", applyJson);
            const doneBtn = el("button", "mll-pop-btn primary", "Done");
            doneBtn.type = "button";
            doneBtn.title = "Apply any JSON changes and close";
            doneBtn.addEventListener("click", () => {
                if (textarea.value !== appliedText && !applyJson()) return;
                closeConfigPopup();
            });
            foot.append(copyBtn, el("span", "spacer"), applyBtn, doneBtn);

            pop.append(head, body, foot);
            document.body.append(pop);

            // ── Position next to the cog, flipping above if needed ──
            const anchor = anchorEl.getBoundingClientRect();
            const place = () => {
                const rect = pop.getBoundingClientRect();
                const left = Math.min(anchor.left, window.innerWidth - rect.width - 8);
                let top = anchor.bottom + 4;
                if (top + rect.height > window.innerHeight - 8) {
                    top = Math.max(8, anchor.top - rect.height - 4);
                }
                pop.style.left = `${Math.max(8, left)}px`;
                pop.style.top = `${top}px`;
            };
            place();
            requestAnimationFrame(place);

            // Outside click / Escape close it (unapplied JSON edits are dropped).
            const abort = new AbortController();
            document.addEventListener("pointerdown", (e) => {
                if (pop.contains(e.target)) return;
                // This node's cog toggles the popup itself (the header, and
                // so the cog, is rebuilt when a column mode changes).
                if (headerEl.contains(e.target) && e.target.closest?.(".mll-cog-btn")) return;
                closeConfigPopup();
            }, { capture: true, signal: abort.signal });
            window.addEventListener("keydown", (e) => {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    closeConfigPopup();
                }
            }, { capture: true, signal: abort.signal });
            pop.addEventListener("wheel", (e) => e.stopPropagation());

            _activePopup = { element: pop, abort, node };
        };

        /**
         * Rebuilds the header content (cog button and column labels).
         * Called on initial render and when a column mode changes.
         *
         * @param {LGraphNode}  node
         * @param {HTMLElement}  headerEl      - The .mll-header div
         * @param {object}       nodeData
         * @param {HTMLElement}  rowsContainer - For triggering row rebuild
         */
        const renderHeader = (node, headerEl, nodeData, rowsContainer) => {
            headerEl.innerHTML = "";

            // Settings button (⚙) — first in the header
            const cogBtn = document.createElement("span");
            cogBtn.className = "mll-cog-btn";
            cogBtn.textContent = "\u2699";
            cogBtn.title = "Settings: CLIP / LTX columns and LoRA config JSON";
            cogBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
            cogBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (_activePopup?.node === node) {
                    closeConfigPopup();
                    return;
                }
                openConfigPopup(node, cogBtn, headerEl, nodeData, rowsContainer);
            });
            headerEl.appendChild(cogBtn);

            // Spacer pushes column labels to the right
            const headerSpacer = document.createElement("span");
            headerSpacer.className = "mll-header-spacer";
            headerEl.appendChild(headerSpacer);

            // Column labels — only visible columns
            const visibleDefs = getVisibleNumDefs(node);
            for (const def of visibleDefs) {
                const label = document.createElement("span");
                label.className = "mll-col-label";
                label.textContent = def.label;
                headerEl.appendChild(label);
            }

            // End spacer — matches the trash column width so labels align
            const endSpacer = document.createElement("span");
            endSpacer.style.flex = "0 0 24px";
            headerEl.appendChild(endSpacer);
        };

        /**
         * Creates a single row DOM element for a LoRA entry.
         *
         * @param {object}     row       - Row data { on, lora, str, vid, ... }
         * @param {number}     rowIdx    - Index in the data array
         * @param {LGraphNode} node      - The owning node
         * @param {object}     nodeData  - Node definition data (for lora list)
         * @param {Function}   rebuildFn - Callback to rebuild all rows after data change
         * @returns {HTMLElement}
         */
        const createRowElement = (row, rowIdx, node, nodeData, rebuildFn) => {
            const rowEl = document.createElement("div");
            rowEl.className = "mll-row";

            const loraList = availableLoras;

            // ── Grip handle ──
            const grip = document.createElement("span");
            grip.className = "mll-grip";
            grip.textContent = "☰";
            grip.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                startDragReorder(e, rowEl, rowIdx, node, rebuildFn);
            });
            rowEl.appendChild(grip);

            // ── Trash (appended last by each row kind) ──
            const trash = document.createElement("span");
            trash.className = "mll-trash";
            trash.textContent = "\u2715";
            trash.addEventListener("click", (e) => {
                e.stopPropagation();
                const data = JSON.parse(node.properties.lora_data || "[]");
                data.splice(rowIdx, 1);
                node.properties.lora_data = JSON.stringify(data);
                syncToBackend(node);
                resizeNode(node);
                rebuildFn();
            });

            /** Applies `mutate` to this row's stored data, then re-renders */
            const updateRow = (mutate) => {
                const data = JSON.parse(node.properties.lora_data || "[]");
                if (!data[rowIdx]) return;
                mutate(data[rowIdx]);
                node.properties.lora_data = JSON.stringify(data);
                syncToBackend(node);
                rebuildFn();
            };

            /** Prompts for a divider name and stores it as this row's label */
            const promptDividerName = (e) => {
                showPrompt("Divider name", isDividerRow(row) ? row.label : "", (v) => {
                    updateRow(r => { r.label = String(v ?? "").trim(); });
                }, e);
            };

            // ── Divider: a labelled line, no dot or strength boxes ──
            if (isDividerRow(row)) {
                rowEl.classList.add("mll-divider");
                const labelEl = document.createElement("span");
                labelEl.className = "mll-divider-label";
                labelEl.textContent = row.label;
                labelEl.title = "Double-click to rename";
                const line = document.createElement("span");
                line.className = "mll-divider-line";

                rowEl.addEventListener("dblclick", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    promptDividerName(e);
                });
                rowEl.addEventListener("contextmenu", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    new LiteGraph.ContextMenu([
                        { content: "Rename divider\u2026", callback: () => promptDividerName(e) },
                        { content: "Convert to empty slot", callback: () => updateRow(r => { delete r.label; }) },
                    ], { event: e, title: row.label || "Divider" });
                });

                if (row.label) rowEl.appendChild(labelEl);
                rowEl.appendChild(line);
                rowEl.appendChild(trash);
                return rowEl;
            }

            // Apply state classes
            if (row.lora === "None") {
                rowEl.classList.add("mll-none-lora");
            } else if (!row.on) {
                rowEl.classList.add("mll-disabled");
            }
            if (row.lora !== "None" && !loraList.includes(row.lora)) {
                rowEl.classList.add("mll-missing-lora");
            }

            // ── Toggle dot ──
            const toggle = document.createElement("span");
            toggle.className = "mll-toggle";
            const dot = document.createElement("span");
            dot.className = "mll-toggle-dot";
            if (row.lora === "None") {
                dot.classList.add("mll-empty");
            } else if (row.on) {
                dot.classList.add("mll-on");
            } else {
                dot.classList.add("mll-off");
            }
            toggle.appendChild(dot);
            toggle.addEventListener("click", (e) => {
                e.stopPropagation();
                const data = JSON.parse(node.properties.lora_data || "[]");
                if (data[rowIdx]) {
                    data[rowIdx].on = !data[rowIdx].on;
                    node.properties.lora_data = JSON.stringify(data);
                    syncToBackend(node);
                    rebuildFn();
                }
            });
            rowEl.appendChild(toggle);

            // ── LoRA name ──
            const nameEl = document.createElement("span");
            nameEl.className = "mll-name";
            const isEmpty = row.lora === "None";
            const bdi = document.createElement("bdi");
            if (isEmpty) {
                // Empty slot: a placeholder inviting a pick, not a "None" value
                nameEl.classList.add("mll-empty-slot");
                nameEl.title = "Click to choose a LoRA \u2014 right-click to make it a divider";
                bdi.textContent = "Choose a LoRA\u2026";
            } else {
                bdi.textContent = formatLoraName(row.lora);
            }
            nameEl.appendChild(bdi);
            if (row.lora !== "None" && !loraList.includes(row.lora)) {
                nameEl.title = "LoRA file not found: " + row.lora;
            } else if (row.lora !== "None" && prefs.hide_folders) {
                nameEl.title = row.lora;
            }

            // ── Info badge (always shown for real LoRAs) ──
            // Opens the LoRA info dialog and refreshes the cache on close.
            const openInfoDialog = async () => {
                const dialog = await showLoraInfo(row.lora);
                if (dialog) {
                    dialog.addEventListener("close", async () => {
                        const svc = await getLoraInfoService();
                        if (svc) {
                            // Read cached info without forcing a refresh —
                            // passing refresh=true here would trigger a
                            // Civitai fetch on close even if the user never
                            // clicked "fetch info from civitai".
                            const info = await svc.getInfo(row.lora, false, true);
                            _loraInfoCache.set(row.lora, info);
                            rebuildFn();
                        }
                    });
                }
            };
            if (row.lora && row.lora !== "None") {
                // ── Rank label, left of the info badge ──
                // Filled synchronously when cached (no blink on rebuild),
                // otherwise via one batched request.  Skipped for missing
                // files.
                if (loraList.includes(row.lora)) {
                    const rankEl = document.createElement("span");
                    rankEl.className = "mll-rank";
                    if (_rankResults.has(row.lora)) {
                        applyRankLabel(rankEl, _rankResults.get(row.lora));
                    } else {
                        fetchLoraRank(row.lora).then(info => applyRankLabel(rankEl, info));
                    }
                    nameEl.appendChild(rankEl);
                }

                const badge = document.createElement("span");
                badge.className = "mll-info-badge";
                badge.textContent = "\u24D8";  // circled i
                badge.title = "No LoRA info";
                badge.addEventListener("click", (e) => {
                    e.stopPropagation();
                    openInfoDialog();
                });
                nameEl.appendChild(badge);

                // Color the badge green when info is available (cache-first
                // to avoid blink on rebuild).
                if (_loraInfoCache.has(row.lora)) {
                    updateInfoBadge(badge, _loraInfoCache.get(row.lora));
                } else {
                    getLoraInfoService().then(svc => {
                        if (!svc) return;
                        svc.getInfo(row.lora, false, true).then(info => {
                            _loraInfoCache.set(row.lora, info);
                            updateInfoBadge(badge, info);
                        });
                    });
                }
            }

            nameEl.addEventListener("click", (e) => {
                e.stopPropagation();
                const loraList = availableLoras;
                new LiteGraph.ContextMenu(loraList, {
                    event: e,
                    title: "Choose a lora",
                    className: "dark",
                    callback: (v) => updateRow(r => { r.lora = v; }),
                });
            });
            nameEl.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isEmpty) {
                    new LiteGraph.ContextMenu(
                        [{ content: "Make divider\u2026", callback: () => promptDividerName(e) }],
                        { event: e, title: "Empty slot" }
                    );
                } else if (row.lora) {
                    new LiteGraph.ContextMenu(
                        [{ content: "Show LoRA Info", callback: openInfoDialog }],
                        { event: e, title: formatLoraName(row.lora) }
                    );
                }
            });
            rowEl.appendChild(nameEl);

            // ── Number cells — only visible columns (none on empty slots) ──
            const visibleDefs = isEmpty ? [] : getVisibleNumDefs(node);
            for (const numDef of visibleDefs) {
                const numEl = document.createElement("span");
                numEl.className = "mll-num";
                // Older saved rows may lack newer keys (e.g. "clip"); default
                // any missing value to 1.0 so rendering never crashes.
                let cellVal = row[numDef.key];
                if (cellVal === undefined || cellVal === null) {
                    cellVal = 1.0;
                    row[numDef.key] = cellVal;
                }
                numEl.textContent = cellVal.toFixed(2);
                numEl.dataset.key = numDef.key;

                setupNumberDrag(numEl, numDef.key, rowIdx, node, rebuildFn);
                rowEl.appendChild(numEl);
            }

            rowEl.appendChild(trash);

            return rowEl;
        };

        /**
         * Rebuilds all row DOM elements from the current lora_data.
         *
         * @param {LGraphNode}  node
         * @param {HTMLElement}  rowsContainer
         * @param {object}       nodeData
         */
        const renderRows = (node, rowsContainer, nodeData) => {
            rowsContainer.innerHTML = "";
            const data = JSON.parse(node.properties.lora_data || "[]");

            const rebuildFn = () => renderRows(node, rowsContainer, nodeData);

            for (let i = 0; i < data.length; i++) {
                const rowEl = createRowElement(data[i], i, node, nodeData, rebuildFn);
                rowsContainer.appendChild(rowEl);
            }

            syncToBackend(node);
        };

        // ─────────────────────────────────────────────
        //  Number Cell Drag-to-Slide + Click-to-Type
        // ─────────────────────────────────────────────

        /**
         * Attaches drag-to-slide and click-to-type behavior to a number cell.
         *
         * @param {HTMLElement} numEl
         * @param {string}      key
         * @param {number}      rowIdx
         * @param {LGraphNode}  node
         * @param {Function}    rebuildFn
         */
        const setupNumberDrag = (numEl, key, rowIdx, node, rebuildFn) => {
            numEl.addEventListener("pointerdown", (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();

                const data = JSON.parse(node.properties.lora_data || "[]");
                if (!data[rowIdx]) return;
                const startVal = data[rowIdx][key];
                // Scrub origin; re-based whenever Shift changes so switching
                // between coarse and fine mid-drag never jumps the value.
                let originX = e.clientX;
                let originVal = startVal;
                let originFine = e.shiftKey;
                let lastVal = startVal;
                let moved = false;

                numEl.setPointerCapture(e.pointerId);

                const onMove = (me) => {
                    if (!moved && Math.abs(me.clientX - originX) > SCRUB_DEAD_ZONE) {
                        moved = true;
                        originX += Math.sign(me.clientX - originX) * SCRUB_DEAD_ZONE;
                    }
                    if (moved) {
                        if (me.shiftKey !== originFine) {
                            originX = me.clientX;
                            originVal = lastVal;
                            originFine = me.shiftKey;
                        }
                        const step = originFine ? FINE_STEP : getStep();
                        const steps = Math.round((me.clientX - originX) / SCRUB_PIXELS_PER_STEP);
                        const newVal = Math.round((originVal + steps * step) * 100) / 100;
                        if (newVal === lastVal) return;
                        lastVal = newVal;
                        numEl.textContent = newVal.toFixed(2);
                        const curData = JSON.parse(node.properties.lora_data || "[]");
                        if (curData[rowIdx]) {
                            curData[rowIdx][key] = newVal;
                            node.properties.lora_data = JSON.stringify(curData);
                            syncToBackend(node);
                        }
                    }
                };

                const onUp = (ue) => {
                    numEl.releasePointerCapture(ue.pointerId);
                    numEl.removeEventListener("pointermove", onMove);
                    numEl.removeEventListener("pointerup", onUp);

                    if (!moved) {
                        const curData = JSON.parse(node.properties.lora_data || "[]");
                        const currentVal = curData[rowIdx]?.[key] ?? startVal;
                        const dialog = showPrompt("Value", currentVal, (v) => {
                            const parsed = parseFloat(v);
                            if (!isNaN(parsed)) {
                                const freshData = JSON.parse(node.properties.lora_data || "[]");
                                if (freshData[rowIdx]) {
                                    freshData[rowIdx][key] = parsed;
                                    node.properties.lora_data = JSON.stringify(freshData);
                                    syncToBackend(node);
                                    rebuildFn();
                                }
                            }
                        }, ue);
                        // ArrowUp / ArrowDown step the typed value (Shift = fine).
                        const input = dialog?.querySelector("input");
                        input?.addEventListener("keydown", (ke) => {
                            if (ke.key !== "ArrowUp" && ke.key !== "ArrowDown") return;
                            ke.preventDefault();
                            ke.stopPropagation();
                            const base = parseFloat(input.value);
                            const step = (ke.shiftKey ? FINE_STEP : getStep()) * (ke.key === "ArrowUp" ? 1 : -1);
                            const next = Math.round(((isNaN(base) ? currentVal : base) + step) * 100) / 100;
                            input.value = next.toFixed(2);
                            input.select();
                        });
                    }
                };

                numEl.addEventListener("pointermove", onMove);
                numEl.addEventListener("pointerup", onUp);
            });
        };

        // ─────────────────────────────────────────────
        //  Row Drag Reorder
        // ─────────────────────────────────────────────

        /**
         * Initiates drag-to-reorder on a grip pointerdown event.
         *
         * @param {PointerEvent} e
         * @param {HTMLElement}  rowEl
         * @param {number}       dragIdx
         * @param {LGraphNode}   node
         * @param {Function}     rebuildFn
         */
        const startDragReorder = (e, rowEl, dragIdx, node, rebuildFn) => {
            const rowsContainer = rowEl.parentElement;
            if (!rowsContainer) return;

            rowEl.classList.add("mll-dragging");
            let currentIdx = dragIdx;
            const pointerId = e.pointerId;

            /**
             * Computes the row index under the pointer, accounting for
             * canvas zoom.  In LG legacy mode the DOM widget is scaled
             * via CSS transform, so getBoundingClientRect() returns
             * screen-scaled dimensions.  We use the first row's actual
             * rendered height to derive the correct index regardless
             * of zoom level.
             */
            const getHoverIdx = (clientY, dataLen) => {
                const firstRow = rowsContainer.children[0];
                if (!firstRow) return 0;
                const scaledRowH = firstRow.getBoundingClientRect().height;
                const containerTop = rowsContainer.getBoundingClientRect().top;
                const relativeY = clientY - containerTop;
                let idx = Math.floor(relativeY / scaledRowH);
                return Math.max(0, Math.min(idx, dataLen - 1));
            };

            const onMove = (me) => {
                if (me.pointerId !== pointerId) return;

                const data = JSON.parse(node.properties.lora_data || "[]");
                const hoverIdx = getHoverIdx(me.clientY, data.length);

                if (hoverIdx !== currentIdx) {
                    // Swap data
                    const item = data.splice(currentIdx, 1)[0];
                    data.splice(hoverIdx, 0, item);
                    node.properties.lora_data = JSON.stringify(data);
                    syncToBackend(node);

                    // Swap DOM elements
                    const draggedEl = rowsContainer.children[currentIdx];
                    const targetEl = rowsContainer.children[hoverIdx];
                    if (draggedEl && targetEl) {
                        if (hoverIdx < currentIdx) {
                            rowsContainer.insertBefore(draggedEl, targetEl);
                        } else {
                            rowsContainer.insertBefore(draggedEl, targetEl.nextSibling);
                        }
                    }

                    currentIdx = hoverIdx;
                }
            };

            const onUp = (ue) => {
                if (ue.pointerId !== pointerId) return;

                document.removeEventListener("pointermove", onMove, true);
                document.removeEventListener("pointerup", onUp, true);

                rowEl.classList.remove("mll-dragging");
                rebuildFn();
            };

            // Listen on document in capture phase — survives DOM element
            // repositioning (pointer capture is lost when elements move).
            document.addEventListener("pointermove", onMove, true);
            document.addEventListener("pointerup", onUp, true);
        };

        // ─────────────────────────────────────────────
        //  Node Resize Helper
        // ─────────────────────────────────────────────

        /**
         * Recomputes node size after rows are added or removed.
         *
         * @param {LGraphNode} node
         */
        const resizeNode = (node) => {
            const sz = node.computeSize();
            node.setSize([Math.max(sz[0], node.size[0]), sz[1]]);
            node.setDirtyCanvas(true, true);
        };

        // ─────────────────────────────────────────────
        //  Size Calculation
        // ─────────────────────────────────────────────

        nodeType.prototype.computeSize = function () {
            const data = JSON.parse(this.properties.lora_data || "[]");
            const widgetH = computeWidgetHeight(this);
            const height = 56 + widgetH + 10;
            return [MIN_WIDTH, height];
        };

        // ─────────────────────────────────────────────
        //  Node Lifecycle — onNodeCreated
        // ─────────────────────────────────────────────

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);

            injectStyles();

            // Initialise properties with one empty slot if this is a new node
            this.properties = this.properties || {};
            if (!this.properties.lora_data) {
                this.properties.lora_data = JSON.stringify([makeEmptyRow()]);
            }

            // ── Hide backend-only widgets from both renderers ──
            // "converted-widget" prevents LiteGraph canvas drawing.
            // canvasOnly = true prevents Vue/Nodes 2.0 rendering.
            const hideWidget = (name) => {
                const w = this.widgets?.find(w => w.name === name);
                if (w) {
                    w.type = "converted-widget";
                    w.options = w.options || {};
                    w.options.canvasOnly = true;
                    w.computeSize = () => [0, -4];
                    w.draw = () => {};
                }
            };
            hideWidget("lora_data");
            hideWidget("ltx_mode");
            hideWidget("clip_mode");

            // Remove the lora_data, ltx_mode and clip_mode input slots —
            // they're managed internally via properties and hidden widgets.
            for (const slotName of ["lora_data", "ltx_mode", "clip_mode"]) {
                const slotIdx = this.inputs?.findIndex(inp => inp.name === slotName);
                if (slotIdx !== undefined && slotIdx >= 0) {
                    this.removeInput(slotIdx);
                }
            }

            // ── Build the DOM widget ──

            const container = document.createElement("div");
            container.className = "mll-container";

            // Forward wheel events to the canvas so zooming works
            // even when the mouse is over this DOM widget.
            container.addEventListener("wheel", (e) => {
                e.preventDefault();
                const canvas = app.canvas?.canvas || document.querySelector("canvas");
                if (canvas) {
                    canvas.dispatchEvent(new WheelEvent("wheel", e));
                }
            }, { passive: false });

            const nodeRef = this;

            // ── Drag-and-drop directly on the DOM widget ──
            // The DOM widget overlay sits above the canvas in both
            // LiteGraph and Nodes 2.0 Vue renderers, intercepting
            // drag events before ComfyUI's canvas-level dispatch
            // can route them to node.onDragOver / onDragDrop.
            // We handle dragover/drop here with stopPropagation so
            // the app-level handler never tries to open the files
            // as a workflow ("Unable to find workflow" toast).

            container.addEventListener("dragover", (e) => {
                if (!isDraggingFiles(e)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
                container.classList.add("mll-drag-over");
            });

            container.addEventListener("dragleave", (e) => {
                // Only remove the highlight when leaving the container
                // itself, not when moving between child elements.
                if (container.contains(e.relatedTarget)) return;
                container.classList.remove("mll-drag-over");
            });

            container.addEventListener("drop", (e) => {
                e.preventDefault();
                e.stopPropagation();
                container.classList.remove("mll-drag-over");

                const files = e?.dataTransfer?.files;
                if (files && files.length > 0) {
                    handleLoraFileDrop(nodeRef, files);
                }
            });

            // ── Header ──
            const header = document.createElement("div");
            header.className = "mll-header";
            container.appendChild(header);

            // ── Row container ──
            const rowsContainer = document.createElement("div");
            rowsContainer.className = "mll-rows";
            container.appendChild(rowsContainer);

            // ── "+ Add LoRA" / "+ Divider" buttons ──
            const appendRow = (row) => {
                const data = JSON.parse(nodeRef.properties.lora_data || "[]");
                data.push(row);
                nodeRef.properties.lora_data = JSON.stringify(data);
                syncToBackend(nodeRef);
                resizeNode(nodeRef);
                renderRows(nodeRef, rowsContainer, nodeData);
            };

            const addBar = document.createElement("div");
            addBar.className = "mll-add-bar";

            const addBtn = document.createElement("button");
            addBtn.className = "mll-add-btn";
            addBtn.textContent = "+ Add LoRA";
            addBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                appendRow(makeEmptyRow());
            });

            const addDividerBtn = document.createElement("button");
            addDividerBtn.className = "mll-add-btn mll-add-divider";
            addDividerBtn.textContent = "+ Divider";
            addDividerBtn.title = "Add a labelled divider to group LoRAs";
            addDividerBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                showPrompt("Divider name", "", (v) => {
                    appendRow({ ...makeEmptyRow(), label: String(v ?? "").trim() });
                }, e);
            });

            addBar.append(addBtn, addDividerBtn);
            container.appendChild(addBar);

            // ── Initial render ──
            renderHeader(this, header, nodeData, rowsContainer);
            renderRows(this, rowsContainer, nodeData);

            // ── Store references for configure hook ──
            this._mllContainer = container;
            this._mllRowsContainer = rowsContainer;
            this._mllHeader = header;
            this._mllNodeData = nodeData;
            _liveNodes.add(this);

            // ── Public API for external nodes (e.g. MultiLoRA Cycle) ──
            this.updateLoraData = (newData) => {
                nodeRef.properties.lora_data = newData;
                syncToBackend(nodeRef);
                resizeNode(nodeRef);
                renderRows(nodeRef, rowsContainer, nodeData);
            };

            // ── Register as DOM widget ──
            this.addDOMWidget("lora_ui", "custom", container, {
                hideOnZoom: true,
                getMinHeight: () => computeWidgetHeight(nodeRef),
                getMaxHeight: () => computeWidgetHeight(nodeRef),
                getValue: () => nodeRef.properties.lora_data || "[]",
                setValue: (v) => {
                    if (typeof v === "string") {
                        nodeRef.properties.lora_data = v;
                        renderRows(nodeRef, rowsContainer, nodeData);
                    }
                },
            });

            // Force correct initial size
            requestAnimationFrame(() => {
                const sz = this.computeSize();
                this.setSize([Math.max(sz[0], this.size?.[0] || 0), sz[1]]);
                this.setDirtyCanvas(true, true);
            });
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            _liveNodes.delete(this);
            if (_activePopup?.node === this) closeConfigPopup();
            return origOnRemoved?.apply(this, arguments);
        };

        // ─────────────────────────────────────────────
        //  Configure — re-render after workflow load
        // ─────────────────────────────────────────────

        const origConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (data) {
            origConfigure?.apply(this, arguments);

            // After loading from a saved workflow, re-render header and rows
            // from the restored state (properties.lora_data + ltx_mode widget).
            if (this._mllRowsContainer && this._mllNodeData && this._mllHeader) {
                renderHeader(this, this._mllHeader, this._mllNodeData, this._mllRowsContainer);
                renderRows(this, this._mllRowsContainer, this._mllNodeData);
                requestAnimationFrame(() => resizeNode(this));
            }
        };

        // ─────────────────────────────────────────────
        //  Refresh — pick up newly added LoRA files
        // ─────────────────────────────────────────────

        /**
         * Called by ComfyUI on every live node when node definitions are
         * refreshed ("R" hotkey / Refresh Node Definitions menu item).
         *
         * The list is taken straight from the supplied defs rather than
         * from re-registration: reloadNodeDefs() doesn't await
         * registerNodeDef(), so beforeRegisterNodeDef can land after this
         * runs.  Rows are re-rendered so "missing LoRA" styling reflects
         * what's actually on disk now.
         *
         * @param {object} defs - Fresh node definitions keyed by node name
         */
        nodeType.prototype.refreshComboInNode = function (defs) {
            const list = defs?.MultiLoRALoader?.input?.hidden?.available_loras?.[0];
            if (list) availableLoras = list;

            // Forget session-cached ranks once per refresh so retrained /
            // replaced files are re-checked (the server re-reads only files
            // whose size or mtime changed).
            if (defs && defs !== _lastRefreshDefs) {
                _lastRefreshDefs = defs;
                _rankResults.clear();
            }

            if (this._mllRowsContainer && this._mllNodeData) {
                renderRows(this, this._mllRowsContainer, this._mllNodeData);
            }
        };

        // ─────────────────────────────────────────────
        //  Drag-and-Drop — add LoRAs by dropping files
        // ─────────────────────────────────────────────

        const origOnDragOver = nodeType.prototype.onDragOver;
        /**
         * Accepts drag events when files are being dragged over the node.
         * Chains with any existing onDragOver handler.
         */
        nodeType.prototype.onDragOver = function (e) {
            if (origOnDragOver) {
                const handled = origOnDragOver.apply(this, arguments);
                if (handled != null) return handled;
            }
            // Accept if the drag contains files
            return !!e?.dataTransfer?.types?.includes("Files");
        };

        const origOnDragDrop = nodeType.prototype.onDragDrop;
        /**
         * Handles file drops on the non-DOM-widget area of the node
         * (e.g. title bar in LiteGraph mode).  Delegates to the
         * shared handleLoraFileDrop helper.
         */
        nodeType.prototype.onDragDrop = async function (e) {
            if (origOnDragDrop) {
                const handled = await origOnDragDrop.apply(this, arguments);
                if (handled) return handled;
            }

            const files = e?.dataTransfer?.files;
            if (!files || files.length === 0) return false;

            const result = handleLoraFileDrop(this, files);
            if (result) {
                // Stop the event from reaching app.ts's document-level
                // drop handler which would otherwise try to open the
                // files as a workflow ("Unable to find workflow" toast).
                e.preventDefault();
                e.stopPropagation();
            }
            return result;
        };
    }
});
