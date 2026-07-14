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

/* ── LTX Toggle ── */

.mll-ltx-toggle {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 3px;
    margin-left: 6px;
    cursor: pointer;
    font-size: 10px;
    font-weight: bold;
    color: #ddd;
}

.mll-ltx-toggle input[type="checkbox"] {
    width: 12px;
    height: 12px;
    margin: 0;
    cursor: pointer;
    accent-color: #4CAF50;
}

.mll-ltx-toggle.mll-ltx-active {
    color: #4CAF50;
}

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

.mll-row.mll-none-lora {
    opacity: 0.4;
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

/* ── Add Button ── */

.mll-add-btn {
    display: block;
    width: calc(100% - 8px);
    margin: 4px auto 2px;
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

/* ── Drag-and-Drop Overlay ── */

.mll-container.mll-drag-over {
    outline: 2px solid rgba(100, 150, 255, 0.7);
    outline-offset: -2px;
    background: rgba(100, 150, 255, 0.08);
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

        /** Creates a default empty LoRA row */
        const makeEmptyRow = () => ({
            on: true, lora: "None",
            str: 1.0, clip: 1.0,
            vid: 1.0, v2a: 1.0, aud: 1.0, a2v: 1.0, other: 1.0
        });

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
         */
        const showPrompt = (title, value, callback, event) => {
            const canvas = app.canvas;
            if (!canvas || typeof canvas.prompt !== "function") return;

            const dialog = canvas.prompt(title, value, callback, event);
            if (!dialog) return;

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
            return loraPath.replace(/\.[^.]+$/, "");
        };

        /**
         * Replaces the node-definition snapshot with the current backend
         * LoRA list. If refresh fails, retain the last known list.
         *
         * @param {object} nodeData
         * @returns {Promise<string[]>}
         */
        const refreshAvailableLoras = async (nodeData) => {
            try {
                const response = await api.fetchApi("/multi_lora_loader/loras", {
                    cache: "no-store",
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const result = await response.json();
                if (Array.isArray(result.loras)) {
                    nodeData.input.hidden.available_loras[0] = result.loras;
                }
            } catch (err) {
                console.warn("[MultiLoRA] Unable to refresh LoRA list:", err);
            }

            return nodeData.input.hidden.available_loras[0];
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
         * @param {string[]} loraList - available_loras from nodeData
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

            const loraList = nodeData.input.hidden.available_loras[0];
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
                    data.push({
                        on: false, lora: loraPath,
                        str: 1.0, clip: 1.0, vid: 1.0, v2a: 1.0,
                        aud: 1.0, a2v: 1.0, other: 1.0
                    });
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

        /**
         * Rebuilds the header content (column labels, LTX toggle, cog button).
         * Called on initial render and when LTX mode changes.
         *
         * @param {LGraphNode}  node
         * @param {HTMLElement}  headerEl      - The .mll-header div
         * @param {object}       nodeData
         * @param {HTMLElement}  rowsContainer - For triggering row rebuild
         */
        const renderHeader = (node, headerEl, nodeData, rowsContainer) => {
            headerEl.innerHTML = "";

            // Config editor button (⚙) — first in the header
            const cogBtn = document.createElement("span");
            cogBtn.className = "mll-cog-btn";
            cogBtn.textContent = "\u2699";
            cogBtn.title = "Edit LoRA config JSON";
            cogBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const data = JSON.parse(node.properties.lora_data || "[]");
                const compactJson = JSON.stringify(data);
                showPrompt("LoRA Config (JSON)", compactJson, (value) => {
                    try {
                        const parsed = JSON.parse(value);
                        if (!Array.isArray(parsed)) {
                            console.warn("[MultiLoRA] Invalid config: not an array");
                            return;
                        }
                        const sanitized = parsed.map(row => ({
                            on:    row.on !== undefined ? row.on : true,
                            lora:  row.lora || "None",
                            str:   row.str !== undefined ? parseFloat(row.str) : 1.0,
                            clip:  row.clip !== undefined ? parseFloat(row.clip) : 1.0,
                            vid:   row.vid !== undefined ? parseFloat(row.vid) : 1.0,
                            v2a:   row.v2a !== undefined ? parseFloat(row.v2a) : 1.0,
                            aud:   row.aud !== undefined ? parseFloat(row.aud) : 1.0,
                            a2v:   row.a2v !== undefined ? parseFloat(row.a2v) : 1.0,
                            other: row.other !== undefined ? parseFloat(row.other) : 1.0,
                        }));
                        node.properties.lora_data = JSON.stringify(sanitized);
                        syncToBackend(node);
                        resizeNode(node);
                        renderRows(node, rowsContainer, nodeData);
                    } catch (err) {
                        console.warn("[MultiLoRA] Invalid JSON, ignoring:", err);
                    }
                }, e);
            });
            headerEl.appendChild(cogBtn);

            // LTX mode toggle — after cog, before spacer
            const ltxToggle = document.createElement("label");
            ltxToggle.className = "mll-ltx-toggle";
            if (getLtxMode(node)) ltxToggle.classList.add("mll-ltx-active");

            const ltxCheckbox = document.createElement("input");
            ltxCheckbox.type = "checkbox";
            ltxCheckbox.checked = getLtxMode(node);
            ltxCheckbox.addEventListener("change", (e) => {
                e.stopPropagation();
                const checked = ltxCheckbox.checked;
                setLtxMode(node, checked);
                // Rebuild header (to show/hide column labels) and rows
                renderHeader(node, headerEl, nodeData, rowsContainer);
                renderRows(node, rowsContainer, nodeData);
                resizeNode(node);
            });
            // Stop pointer events from bubbling to prevent LiteGraph/Vue interference
            ltxCheckbox.addEventListener("pointerdown", (e) => e.stopPropagation());

            const ltxLabel = document.createElement("span");
            ltxLabel.textContent = "LTX";

            ltxToggle.appendChild(ltxCheckbox);
            ltxToggle.appendChild(ltxLabel);
            headerEl.appendChild(ltxToggle);

            // CLIP mode toggle — adds a per-row CLIP strength column
            const clipToggle = document.createElement("label");
            clipToggle.className = "mll-ltx-toggle";
            if (getClipMode(node)) clipToggle.classList.add("mll-ltx-active");

            const clipCheckbox = document.createElement("input");
            clipCheckbox.type = "checkbox";
            clipCheckbox.checked = getClipMode(node);
            clipCheckbox.addEventListener("change", (e) => {
                e.stopPropagation();
                setClipMode(node, clipCheckbox.checked);
                // Rebuild header (to show/hide the CLIP label) and rows
                renderHeader(node, headerEl, nodeData, rowsContainer);
                renderRows(node, rowsContainer, nodeData);
                resizeNode(node);
            });
            clipCheckbox.addEventListener("pointerdown", (e) => e.stopPropagation());

            const clipLabel = document.createElement("span");
            clipLabel.textContent = "CLIP";

            clipToggle.appendChild(clipCheckbox);
            clipToggle.appendChild(clipLabel);
            headerEl.appendChild(clipToggle);

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

            // Apply state classes
            const loraList = nodeData.input.hidden.available_loras[0];
            if (row.lora === "None") {
                rowEl.classList.add("mll-none-lora");
            } else if (!row.on) {
                rowEl.classList.add("mll-disabled");
            }
            if (row.lora !== "None" && !loraList.includes(row.lora)) {
                rowEl.classList.add("mll-missing-lora");
            }

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
            const displayName = formatLoraName(row.lora);
            nameEl.innerHTML = "";
            const bdi = document.createElement("bdi");
            bdi.textContent = displayName;
            nameEl.appendChild(bdi);
            if (row.lora !== "None" && !loraList.includes(row.lora)) {
                nameEl.title = "LoRA file not found";
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

            nameEl.addEventListener("click", async (e) => {
                e.stopPropagation();
                const loraList = await refreshAvailableLoras(nodeData);
                new LiteGraph.ContextMenu(loraList, {
                    event: e,
                    title: "Choose a lora",
                    className: "dark",
                    callback: (v) => {
                        const data = JSON.parse(node.properties.lora_data || "[]");
                        if (data[rowIdx]) {
                            data[rowIdx].lora = v;
                            node.properties.lora_data = JSON.stringify(data);
                            syncToBackend(node);
                            rebuildFn();
                        }
                    }
                });
            });
            nameEl.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (row.lora && row.lora !== "None") {
                    new LiteGraph.ContextMenu(
                        [{ content: "Show LoRA Info", callback: openInfoDialog }],
                        { event: e, title: formatLoraName(row.lora) }
                    );
                }
            });
            rowEl.appendChild(nameEl);

            // ── Number cells — only visible columns ──
            const visibleDefs = getVisibleNumDefs(node);
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

            // ── Trash ──
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

                const startX = e.clientX;
                const data = JSON.parse(node.properties.lora_data || "[]");
                if (!data[rowIdx]) return;
                const startVal = data[rowIdx][key];
                let moved = false;

                numEl.setPointerCapture(e.pointerId);

                const onMove = (me) => {
                    const deltaX = me.clientX - startX;
                    if (Math.abs(deltaX) > 2) {
                        moved = true;
                    }
                    if (moved) {
                        let newVal = startVal + (deltaX * 0.01);
                        newVal = Math.round(newVal * 100) / 100;
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
                        showPrompt("Value", currentVal, (v) => {
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

            // ── "+ Add LoRA" button ──
            const addBtn = document.createElement("button");
            addBtn.className = "mll-add-btn";
            addBtn.textContent = "+ Add LoRA";
            addBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const data = JSON.parse(nodeRef.properties.lora_data || "[]");
                data.push(makeEmptyRow());
                nodeRef.properties.lora_data = JSON.stringify(data);
                syncToBackend(nodeRef);
                resizeNode(nodeRef);
                renderRows(nodeRef, rowsContainer, nodeData);
            });
            container.appendChild(addBtn);

            // ── Initial render ──
            renderHeader(this, header, nodeData, rowsContainer);
            renderRows(this, rowsContainer, nodeData);

            // ── Store references for configure hook ──
            this._mllContainer = container;
            this._mllRowsContainer = rowsContainer;
            this._mllHeader = header;
            this._mllNodeData = nodeData;

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
