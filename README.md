# Multi LoRA Loader

A powerful multi-LoRA management node for ComfyUI with optional LTX2 layer-specific strength control, drag-and-drop reordering, and rgthree LoRA info integration.

> **Renamed from Power LTX LoRA Loader Extra.** If you have existing workflows using the old node, see [Migration](#migration) below.

![Workflow Diagram](./example_workflows/power_ltx_lora_loader.png)

## Features

- **Multi-LoRA Support**: Load and apply multiple LoRAs simultaneously with individual strength controls
- **Two Modes**:
  - **Standard mode**: Single strength value per LoRA, applied uniformly via ComfyUI's built-in loader
  - **LTX mode**: Per-layer strength control for LTX2 video/audio models (enable in the cog settings)
- **Independent CLIP Strength**: Enable **Separate CLIP strength** in the cog settings to add a per-LoRA CLIP strength column (right after STR), letting you scale CLIP separately from the model. When off, the STR value is used for both model and CLIP (previous behaviour)
- **LTX Layer Controls** (when LTX mode is enabled):
  - **STR** (Strength Model): Overall model strength
  - **Vid** (Video): Video attention layers
  - **V2A** (Video-to-Audio): Cross-modal attention (video to audio)
  - **Aud** (Audio): Audio-specific layers
  - **A2V** (Audio-to-Video): Cross-modal attention (audio to video)
  - **Other**: Remaining network components
- **Dividers**: Labelled heading rows to split a long list into groups. They're stored as `"None"` rows with a `label`, so they're never loaded or cycled
- **Intuitive UI**: Drag-and-drop row reordering, toggle enable/disable, click-to-edit or drag-to-slide values
- **Drag-and-Drop File Import**: Drop LoRA files onto the node to quickly add them — matches by filename against your existing LoRA library; new rows start at the default strength
- **LoRA Rank Display**: Each LoRA shows its rank (e.g. `(r16)`) next to its name, read from the file header and cached, so you can spot high-rank LoRAs that may not play well with a given model. See [LoRA Rank](#lora-rank)
- **Missing LoRA Detection**: LoRAs that no longer exist on disk are shown with red strikethrough text on session load, so you can spot moved or deleted files at a glance
- **rgthree LoRA Info Integration**: Right-click any LoRA name to open the rgthree LoRA info dialog (requires [rgthree-comfy](https://github.com/rgthree/rgthree-comfy)). LoRAs with fetched info display a circled info badge next to their name (green for Civitai data, gray for local info). Fetching new info from Civitai in the dialog updates the badge immediately on close
- **Optional Model/CLIP Input**: Use as a standalone LoRA manager even without model or CLIP connected
- **JSON Output**: Export a rich JSON structure of all selected LoRAs for external processing
- **Settings Popup**: The cog button opens the node's settings — CLIP / LTX column modes, default strength for new LoRAs (0.8), strength step, hiding folder names, and a JSON editor to copy/paste the entire LoRA configuration
- **Sidecar Metadata Support**: Automatically loads metadata from `.json` sidecar files alongside LoRA weights
- **MultiLoRA Cycle** (companion node): Automatically iterate through LoRAs at multiple strengths for batch testing — ideal for evaluating training checkpoints
- **Parse JSON** (companion node): Convert the `lora_data` JSON output into a Python object for use with scripting nodes like [rgthree](https://github.com/rgthree/rgthree-comfy)'s Power Puter

## Installation

1. Clone or download this repository into your ComfyUI `custom_nodes` directory:
   ```bash
   cd ComfyUI/custom_nodes
   git clone https://github.com/phazei/ComfyUI-MultiLoraLoader.git
   ```

2. Restart ComfyUI or reload the browser page.

3. The node will appear in the node menu under **Loaders > Multi LoRA Loader**. You can also search for "power lora loader", "lora stack", or "multi lora".

## Usage

### Basic Workflow

1. Add a **Multi LoRA Loader** node
2. Connect model and/or CLIP inputs (both optional)
3. Click **+ Add LoRA** to add rows (and **+ Divider** to add headings that group them)
4. Click the LoRA name field to open a menu of available LoRAs
5. Adjust strength values by:
   - **Dragging** left/right, in steps of the configured strength step (default 0.05; hold Shift for 0.01)
   - **Single clicking** to type an exact value (ArrowUp/ArrowDown step it; Shift for 0.01)
6. Toggle the dot on/off to enable/disable individual LoRAs
7. Drag rows by the grip handle to reorder
8. Click the X to delete a row
9. Open the cog settings and enable **LTX per-layer strengths** to show per-layer strength columns
10. Open the cog settings and enable **Separate CLIP strength** to show a separate CLIP strength column

### UI Elements

| Element | Action | Purpose |
|---------|--------|---------|
| **Cog** | Click | Open settings: CLIP / LTX column modes, default strength for new LoRAs (0.8), strength step, hide folder names, and the config JSON editor |
| **Grip** | Drag vertically | Reorder LoRA rows |
| **Dot** (Toggle) | Click | Enable/disable the LoRA |
| **LoRA Name** | Left-click | Open LoRA selection menu |
| **LoRA Name** | Right-click | Show LoRA Info (requires rgthree-comfy) |
| **Rank** `(r16)` | Hover | LoRA rank (hover for details, incl. alpha when stored) |
| **Info badge** | — | Indicates fetched LoRA info (green = Civitai, gray = local) |
| **~~Strikethrough~~** | — | LoRA file not found on disk (hover for tooltip) |
| **STR / CLIP / Vid / V2A / Aud / A2V / Other** | Drag or click | Adjust strengths (CLIP shown when Separate CLIP strength is enabled) |
| **X** (Trash) | Click | Delete the row |
| **+ Add LoRA** | Click | Add a new empty slot (click its *Choose a LoRA…* box to pick one; right-click to make it a divider) |
| **+ Divider** | Click | Add a labelled divider to group LoRAs. Double-click a divider to rename it; right-click to rename or turn it back into an empty slot |
| **Drop zone** | Drop files | Drop LoRA files to add by filename match (files must already be in your loras directory) |

> **Note on drag-and-drop:** No files are copied — this is a shortcut for selecting LoRAs from the menu. Dropped files are matched by filename (case-insensitive) against LoRAs already in your ComfyUI `models/loras` directory. If a file isn't found, an alert lists the unmatched filenames. For a LoRA you only just copied into that directory, press `R` first so ComfyUI picks it up.

### Inputs and Outputs

**Inputs** (all optional):
- **model**: Model to apply LoRAs to
- **clip**: CLIP to apply LoRAs to (standard mode only)
- **load_options**: Connect a [MultiLoRA Cycle](#multilora-cycle) node here for automated iteration

**Outputs**:
- **model**: The input model with all active LoRAs applied
- **clip**: The input CLIP with LoRAs applied (standard mode only; LTX mode passes CLIP through unchanged). With Separate CLIP strength enabled, each LoRA's CLIP strength comes from its own CLIP column instead of reusing STR
- **lora_data**: JSON string containing metadata for all selected LoRAs (enabled and disabled)

### rgthree Integration

This node integrates with [rgthree-comfy](https://github.com/rgthree/rgthree-comfy) for LoRA metadata viewing:

- **Right-click** any LoRA name and select **Show LoRA Info** to open rgthree's info dialog with Civitai data, trained words, sample images, and editable notes
- LoRAs that have fetched info display a small circled info badge next to their name:
  - **Green** badge: Civitai data has been fetched
  - **Gray** badge: Local info file exists
  - **No badge**: No info available yet (use the dialog to fetch it)

Info is cached after first fetch, so toggling, reordering, or adding LoRAs won't cause badge flicker. Closing the info dialog after fetching new data from Civitai automatically refreshes the badge.

If rgthree-comfy is not installed, the info features are simply not shown.

### LoRA Rank

Each LoRA row shows the LoRA's rank just left of the info badge. Some models respond poorly to high-rank LoRAs, so this helps when choosing which ones to stack.

| Label | Meaning |
|-------|---------|
| `(r32)` | Rank 32 across all layers |
| `(r8-32)` | Rank varies by layer (hover for the most common value) |
| `(LoKr)` | Unfactorized LoKr — has no single rank |
| *(none)* | Rank couldn't be determined (non-safetensors file or unrecognised format) |

Hovering the label shows the rank, plus the network alpha when the trainer stored it (`ss_network_alpha`).

The rank is read from the safetensors **header only**. No weights are loaded, so lookups are fast even for large files. Supported formats include kohya, diffusers/PEFT, LoCon, LoHa, and factorized LoKr.

**Caching:** results are saved to `ComfyUI/user/multi_lora_loader/rank_cache.json`, keyed by each file's size and modified time. A file is only read again if it changes. In the browser, each LoRA is looked up at most once per page session, so switching workflows sends no new requests for LoRAs already seen. Pressing `R` (**Refresh Node Definitions**) clears the browser's copy, so a retrained checkpoint saved under the same filename is picked up.

### Example Output

The `lora_data` output includes all LoRAs with selected weights:

```json
[
  {
    "name": "my_lora.safetensors",
    "path": "/path/to/my_lora.safetensors",
    "enabled": true,
    "strength_model": 1.0,
    "strength_clip": 1.0,
    "video": 0.8,
    "video_to_audio": 1.0,
    "audio": 0.5,
    "audio_to_video": 1.0,
    "other": 1.0,
    "metadata": {...}
  }
]
```

> `strength_clip` is only present when Separate CLIP strength is enabled; the LTX layer keys (`video`, `audio`, etc.) are only present in LTX mode.

## Sharing and Batch Editing

### Using the Config Editor (cog button)

The easiest way to share or batch-edit your LoRA configuration:

1. Click the cog button in the header of the node
2. The **LoRA config (JSON)** box shows every row, one LoRA per line — click **Copy** to put it on the clipboard
3. Edit it in place (or paste an edited config back in)
4. Press **Apply** (or Ctrl+Enter); **Done** also applies any pending edit before closing
5. Invalid JSON is reported under the box and the config stays unchanged

**Example config:**
```json
[{"on":true,"lora":"style_lora.safetensors","str":1.0,"clip":1.0,"vid":0.8,"v2a":1.0,"aud":0.5,"a2v":1.0,"other":1.0},{"on":false,"lora":"face_detail.safetensors","str":0.7,"clip":0.7,"vid":1.0,"v2a":1.0,"aud":1.0,"a2v":1.0,"other":1.0}]
```

> The `clip` key holds each row's CLIP strength; it's only applied when Separate CLIP strength is enabled (otherwise `str` is used for CLIP too, and `clip` is kept equal to `str`, so switching the CLIP column on starts each row's CLIP at its STR).

### Workflow JSON Editing

You can also hand-edit workflows in the saved JSON file:

1. Open the workflow JSON file
2. Locate your node's `properties.lora_data` field
3. Edit the LoRA list directly
4. Save and reload in ComfyUI

## Companion Nodes

### MultiLoRA Cycle

Automatically iterates through LoRAs in your Multi LoRA Loader at multiple strength values across queue runs. Designed for batch-testing LoRA training checkpoints — load all your checkpoints into the loader, set a list of strengths to test, and let it cycle through every combination.

![MultiLoRA Cycle](./example_workflows/multi_lora_cycle.png)

#### Setup

1. Add LoRAs to your **Multi LoRA Loader** (via the UI, cog button, or drag-and-drop)
2. Add a **MultiLoRA Cycle** node (found under **Loaders**)
3. Connect its `load_options` output to the loader's `load_options` input
4. Set your test strengths as a comma-separated list (e.g. `0.5,0.75,1.0,1.25`)
5. Set `mode` to `increment`
6. Enable **auto-queue** in ComfyUI and hit **Queue**

The cycle node walks through every LoRA at every strength, one per queue run. The loader's UI updates in real time to show which LoRA is active and at what strength.

#### Widgets

| Widget | Type | Description |
|--------|------|-------------|
| **strengths** | STRING | Comma-separated strength values to test (e.g. `0.5,0.75,1.0`). Negative and zero values are valid. |
| **lora_index** | INT | Current LoRA position (1-based). Auto-incremented when all strengths for the current LoRA are exhausted. |
| **strength_index** | INT | Current strength position (1-based). Auto-incremented each queue run. |
| **mode** | COMBO | `increment` auto-advances each run; `fixed` stays on the current indices. |
| **loop** | BOOLEAN | When all combinations are exhausted, wrap back to the start instead of stopping. |

#### Display

The node shows a status line at the bottom:

```
my_training-000800 (3/7) | STR: 0.75 (2/4)
```

This tells you: LoRA 3 of 7 is active, at strength value 2 of 4 (0.75). When all combinations are done and `loop` is off, it shows `Done (7 LoRAs x 4 strengths)`.

#### How Cycling Works

- Each queue run increments `strength_index`
- When `strength_index` exceeds the number of strengths, it resets to 1 and `lora_index` advances
- When `lora_index` exceeds the number of LoRAs: wraps to 1 if `loop` is on, or stops (all LoRAs disabled) if off
- The first queue run after setting up uses the current indices as-is (no increment on the first run)

#### Stopping and Resuming

- Stop auto-queue at any time — the indices stay where they are
- Manually adjust `lora_index` or `strength_index` to jump to any position
- The display updates immediately when you change the indices

#### Saved Metadata

When output files are generated, the cycle node's `mode` is automatically saved as `fixed` in the workflow metadata. This means loading a workflow from an output file won't accidentally start auto-cycling — you'll see the exact LoRA and strength that produced that output.

---

### Parse JSON

Converts a JSON string into a native Python object (list, dict, number, etc.). Connect it to the Multi LoRA Loader's `lora_data` output to feed structured LoRA data to nodes that accept any-type inputs.

![Parse JSON](./example_workflows/parse_json.png)

| Port | Type | Description |
|------|------|-------------|
| **json_string** (input) | STRING | A JSON-encoded string (e.g. the `lora_data` output) |
| **data** (output) | * (any) | The parsed Python object |

#### Usage with Power Puter

This node pairs well with [rgthree-comfy](https://github.com/rgthree/rgthree-comfy)'s **Power Puter** node, which lets you write inline Python expressions in your workflow. Connect the Parse JSON output to a Power Puter input to extract and format LoRA information.

**Example:** Generate a text overlay showing active LoRA names and strengths:

```python
'\n'.join([l['name'].split('\\')[-1].rsplit('.', 1)[0] + ': ' + str(l['strength_model']) for l in a if l['enabled']]) if a else 'No active loras'
```

This produces output like:
```
my_training-000800: 0.75
style_lora: 1.0
```

---

## Migration

This node was previously called **Power LTX LoRA Loader Extra**. If you load an old workflow:

1. The old node will appear with a "Node Renamed" notice and your LoRA data visible in a text box
2. Copy the JSON data from the text box
3. Add a new **Multi LoRA Loader** node
4. Click the cog button on the new node and paste the data in
5. Enable **LTX per-layer strengths** in the cog settings if your workflow used LTX layer-specific strengths
6. Delete the old deprecated node

## Troubleshooting

### LoRA name shows red strikethrough
- The LoRA file was not found in your `models/loras` directory
- It may have been moved, renamed, or deleted
- Hover over the name for a "LoRA file not found" tooltip
- The LoRA will be skipped during execution but its configuration is preserved

### LoRA doesn't appear in the menu
- Ensure the LoRA file is in your ComfyUI `models/loras` directory
- Press `R` (**Refresh Node Definitions**) to re-read the LoRA folder — no browser reload needed

### Disabled LoRAs don't affect the model
- Disabled LoRAs (toggle off) are kept in your configuration but not applied
- Your full configuration including disabled LoRAs is preserved in the workflow

### Can't shrink the node after expanding it
- Drag the node's resize handle to make it narrower
- The node enforces a minimum width of 500px

### Rank label missing or out of date
- Only `.safetensors` files are supported; `.ckpt`/`.pt`/`.bin` show no rank
- After replacing a LoRA file under the same name, press `R` to re-check it
- Deleting `ComfyUI/user/multi_lora_loader/rank_cache.json` forces every file to be re-read

### LoRA Info / right-click menu not working
- Requires [rgthree-comfy](https://github.com/rgthree/rgthree-comfy) to be installed
- If rgthree is not available, the info features are silently disabled

## License

Apache 2.0. See LICENSE file.

## Credits

Built on the **Power Lora Loader** concept by [rgthree](https://github.com/rgthree/rgthree-comfy), extended with multi-LoRA management, LTX2 layer-specific strength control, and rgthree info dialog integration.

## Contributing

Contributions, bug reports, and feature requests are welcome! Please open an issue or submit a pull request at [github.com/phazei/ComfyUI-MultiLoraLoader](https://github.com/phazei/ComfyUI-MultiLoraLoader).
