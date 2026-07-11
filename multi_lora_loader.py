import os
import json
import folder_paths
from aiohttp import web
from server import PromptServer
import comfy.lora
import comfy.lora_convert
import comfy.sd
import comfy.utils
from comfy_execution.graph_utils import ExecutionBlocker
from .data_utils import update_node_in_workflow


@PromptServer.instance.routes.get("/multi_lora_loader/loras")
async def get_available_loras(request):
    """Return the current LoRA library instead of the initial node snapshot."""
    return web.json_response({
        "loras": ["None"] + folder_paths.get_filename_list("loras")
    })


class MultiLoRALoader:
    @classmethod
    def INPUT_TYPES(s):
        lora_list = ["None"] + folder_paths.get_filename_list("loras")
        return {
            "required": {
                # lora_data is managed entirely by the JS frontend via
                # node.properties — the hidden widget bridges data to Python.
                "lora_data": ("STRING", {"default": "[]", "multiline": False}),
                # When True, enables LTX-specific per-layer strength controls
                # (Vid, V2A, Aud, A2V, Other).  When False, uses standard
                # uniform LoRA application with just the STR value.
                "ltx_mode": ("BOOLEAN", {"default": False}),
                # When True, exposes a per-LoRA CLIP strength column (right
                # after STR) so CLIP can be scaled independently of the model.
                # When False, the STR value is used for both model and CLIP
                # (matching the previous behaviour).
                "clip_mode": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                # Model and CLIP are both optional — the node can still
                # output lora_data JSON even when neither is connected.
                "model": ("MODEL",),
                "clip": ("CLIP",),
                # When connected to a MultiLoRA_Cycle node, enables
                # automated iteration through LoRAs and strengths.
                # The cycle node's JS mutates lora_data before
                # serialization, so by the time Python runs the data
                # is already correct.
                "load_options": ("LOAD_OPTIONS",),
            },
            "hidden": {"available_loras": (lora_list,)}
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("model", "clip", "lora_data")
    FUNCTION = "load_loras"
    CATEGORY = "loaders"
    DESCRIPTION = "Multi-LoRA loader with optional LTX layer-specific strength control. Supports per-LoRA toggling, reordering, and bulk management."
    SEARCH_ALIASES = ["power lora loader", "lora stack", "multi lora", "lora loader"]

    # ─────────────────────────────────────────────
    #  Helper: Build rich LoRA info list
    # ─────────────────────────────────────────────

    @staticmethod
    def _build_lora_info(data, ltx_mode=False, clip_mode=False):
        """
        Build a list of rich LoRA info dicts from raw row data.

        Includes every row that has a LoRA selected (lora != "None"),
        regardless of whether it is enabled or disabled.  Each dict
        carries an ``enabled`` flag so consumers can filter as needed.

        When ltx_mode is False, the LTX-specific fields (video,
        video_to_audio, audio, audio_to_video, other) are omitted
        from the output.

        Returns:
            list[dict]: One entry per selected LoRA.
        """
        result = []
        for row in data:
            lora_name = row.get("lora")
            if not lora_name or lora_name == "None":
                continue

            full_path = folder_paths.get_full_path("loras", lora_name)

            # Fetch sidecar metadata (.json) if it exists next to the weights file
            info_data = {}
            if full_path:
                info_file = os.path.splitext(full_path)[0] + ".json"
                if os.path.exists(info_file):
                    try:
                        with open(info_file, "r", encoding="utf-8") as f:
                            info_data = json.load(f)
                    except Exception:
                        pass

            entry = {
                "name":            lora_name,
                "path":            full_path,
                "enabled":         bool(row.get("on", True)),
                "strength_model":  float(row.get("str", 1.0)),
                "metadata":        info_data,
            }

            if clip_mode:
                entry["strength_clip"] = float(
                    row.get("clip", row.get("str", 1.0))
                )

            if ltx_mode:
                entry["video"]           = float(row.get("vid", 1.0))
                entry["video_to_audio"]  = float(row.get("v2a", 1.0))
                entry["audio"]           = float(row.get("aud", 1.0))
                entry["audio_to_video"]  = float(row.get("a2v", 1.0))
                entry["other"]           = float(row.get("other", 1.0))

            result.append(entry)
        return result

    # ─────────────────────────────────────────────
    #  Helper: warn when LoRA keys fail to map
    # ─────────────────────────────────────────────

    @staticmethod
    def _warn_on_key_mismatch(lora_name, lora_dict, loaded):
        """Print a concise WARNING when not every LoRA module in the file
        mapped onto the model.

        ``loaded`` is the dict returned by ``comfy.lora.load_lora`` (one
        entry per successfully-mapped module).  We compare its size against
        the number of LoRA modules present in the raw file (counted via the
        ``lora_down``/``lora_B``/``lora.down`` style "down" tensors, which
        appear exactly once per module across the formats Comfy supports).

        Counts only — no key names.  Silent when everything matches, in
        line with the node's existing fail-quietly behaviour.
        """
        try:
            total = sum(
                1 for k in lora_dict.keys()
                if k.endswith(".lora_down.weight")        # regular / kohya
                or k.endswith(".lora_A.weight")           # diffusers / peft
                or k.endswith("_lora.down.weight")        # diffusers alt
                or k.endswith(".lora.down.weight")        # diffusers alt2
                or k.endswith(".lora_A")                   # mochi
                or k.endswith(".lora_linear_layer.down.weight")  # transformers
                or k.endswith(".lora_A.default.weight")    # qwen default
            )
        except Exception:
            return

        matched = len(loaded)
        if total > 0 and matched < total:
            print(
                f"[MultiLoRALoader] WARNING: {lora_name}: "
                f"{matched}/{total} LoRA modules mapped onto the model "
                f"({total - matched} unmatched). Mismatched keys are "
                f"ignored; output may differ from expectations."
            )

    # ─────────────────────────────────────────────
    #  Public API: loras()
    # ─────────────────────────────────────────────

    @classmethod
    def loras(cls, prompt_node: dict):
        """
        Returns a list of rich LoRA dicts for every LoRA that has been
        selected in the UI (lora != "None").  Each entry includes an
        ``enabled`` field so callers can distinguish active vs. disabled
        entries.  Useful for external scripts parsing the prompt dictionary.
        """
        inputs = prompt_node.get("inputs", {})
        lora_data_str = inputs.get("lora_data", "[]")
        ltx_mode = inputs.get("ltx_mode", False)
        clip_mode = inputs.get("clip_mode", False)
        try:
            data = json.loads(lora_data_str)
        except Exception:
            return []
        return cls._build_lora_info(
            data, ltx_mode=ltx_mode, clip_mode=clip_mode
        )

    # ─────────────────────────────────────────────
    #  Main Execution
    # ─────────────────────────────────────────────

    def load_loras(self, lora_data, ltx_mode=False, clip_mode=False,
                   model=None, clip=None,
                   available_loras=None, load_options=None):
        """
        Applies every active LoRA to the model (and optionally CLIP) and
        returns the patched model, CLIP, and a JSON string of rich LoRA
        info (for the lora_data output port).

        When no model/clip is connected, LoRA loading is skipped for that
        component but the lora_data JSON output is still produced.

        Two modes of operation:

        - **Standard mode** (ltx_mode=False): Uses ComfyUI's built-in
          ``comfy.sd.load_lora_for_models()`` to apply the LoRA uniformly
          to both model and CLIP using the STR strength value.

        - **LTX mode** (ltx_mode=True): Applies per-layer strength
          filtering specific to LTX2 models.  The Vid, V2A, Aud, A2V,
          and Other columns control individual attention layer strengths.
          CLIP is passed through unchanged (LTX LoRAs don't train CLIP).
        """
        try:
            data = json.loads(lora_data)
        except Exception:
            return (model, clip, "[]")

        # Build the rich info list for the STRING output
        lora_info_json = json.dumps(
            self._build_lora_info(data, ltx_mode=ltx_mode, clip_mode=clip_mode),
            indent=2
        )

        # If no model is connected, skip LoRA patching entirely
        if model is None:
            return (None, clip, lora_info_json)

        # Clone model to prevent mutating previous nodes
        new_model = model.clone()
        new_clip = clip

        # When a cycle node is driving iteration, allow zero-strength
        # LoRAs through (0 is a valid test strength).
        cycling = isinstance(load_options, dict) and load_options.get("cycling")

        for row in data:
            # Only apply LoRAs that are enabled, selected, and have non-zero strength
            if not row.get("on") or row.get("lora") == "None":
                continue
            if not cycling and float(row.get("str", 1.0)) == 0:
                continue

            lora_name = row.get("lora")
            path = folder_paths.get_full_path("loras", lora_name)
            if not path:
                print(f"[MultiLoRALoader] Warning: LoRA not found: {lora_name}")
                continue

            strength_model = float(row.get("str", 1.0))

            if ltx_mode:
                # ── LTX mode: per-layer-group strength scaling ──
                #
                # Each layer group (video, video_to_audio, audio,
                # audio_to_video, other) gets its own multiplier.  The
                # final per-layer scale applied to the LoRA is:
                #
                #     strength_model × group_multiplier
                #
                # We achieve this by splitting the loaded LoRA patches into
                # per-group buckets and calling add_patches() once per bucket
                # with that bucket's scaled strength.
                #
                # IMPORTANT: we deliberately DO NOT rewrite the per-key alpha
                # (patch tuple index [2]).  ComfyUI's calculate_weight does:
                #     alpha_term = (alpha / rank) if alpha is not None else 1.0
                #     weight += (strength * alpha_term) * lora_diff
                # Most LTX2 LoRAs ship WITHOUT an .alpha key, so alpha is None
                # and alpha_term is 1.0.  Writing alpha = multiplier would flip
                # that branch and divide by rank (multiplier / rank ≈ near-zero),
                # collapsing the LoRA and producing fuzzy output.  Passing the
                # multiplier through add_patches' strength is correct whether or
                # not the LoRA carries an alpha.
                video           = float(row.get("vid", 1.0))
                video_to_audio  = float(row.get("v2a", 1.0))
                audio           = float(row.get("aud", 1.0))
                audio_to_video  = float(row.get("a2v", 1.0))
                other           = float(row.get("other", 1.0))

                lora = comfy.utils.load_torch_file(path, safe_load=True)

                key_map = {}
                key_map = comfy.lora.model_lora_keys_unet(new_model.model, key_map)
                loaded = comfy.lora.load_lora(lora, key_map)

                self._warn_on_key_mismatch(lora_name, lora, loaded)

                # Split patches into per-group buckets using the same
                # prioritised keyword matching used by KJNodes' loader.
                buckets = {
                    "video":          (video, {}),
                    "video_to_audio": (video_to_audio, {}),
                    "audio":          (audio, {}),
                    "audio_to_video": (audio_to_video, {}),
                    "other":          (other, {}),
                }

                for key in list(loaded.keys()):
                    key_str = key if isinstance(key, str) else (
                        key[0] if isinstance(key, tuple) else str(key)
                    )

                    # Order matters: most specific patterns first.
                    if "video_to_audio_attn" in key_str:
                        group = "video_to_audio"
                    elif "audio_to_video_attn" in key_str:
                        group = "audio_to_video"
                    elif "audio_attn" in key_str or "audio_ff.net" in key_str:
                        group = "audio"
                    elif "attn" in key_str or "ff.net" in key_str:
                        group = "video"
                    else:
                        group = "other"

                    buckets[group][1][key] = loaded[key]

                # Apply each bucket with its own scaled strength.  A
                # multiplier of 0 drops the bucket entirely (no patch added).
                for _group, (multiplier, patches) in buckets.items():
                    if not patches:
                        continue
                    if multiplier == 0:
                        continue
                    new_model.add_patches(patches, strength_model * multiplier)
                # CLIP unchanged in LTX mode (LTX LoRAs don't train CLIP)

            else:
                # ── Standard mode: uniform LoRA application ──
                lora_file = comfy.utils.load_torch_file(path, safe_load=True)

                # Diagnostic: replicate the model+clip key mapping that
                # load_lora_for_models performs internally so we can warn
                # when some modules fail to map.  load_lora_for_models does
                # not expose its loaded dict, so we recompute it here.
                try:
                    diag_map = {}
                    diag_map = comfy.lora.model_lora_keys_unet(
                        new_model.model, diag_map
                    )
                    if new_clip is not None:
                        diag_map = comfy.lora.model_lora_keys_clip(
                            new_clip.cond_stage_model, diag_map
                        )
                    diag_lora = comfy.lora_convert.convert_lora(lora_file)
                    diag_loaded = comfy.lora.load_lora(
                        diag_lora, diag_map, log_missing=False
                    )
                    self._warn_on_key_mismatch(lora_name, diag_lora, diag_loaded)
                except Exception:
                    pass

                # In clip_mode the CLIP strength is taken from the per-row
                # "clip" value; otherwise STR is reused for both (previous
                # behaviour).
                strength_clip = (
                    float(row.get("clip", strength_model))
                    if clip_mode else strength_model
                )

                new_model, new_clip = comfy.sd.load_lora_for_models(
                    new_model, new_clip, lora_file,
                    strength_model, strength_clip
                )

        return (new_model, new_clip, lora_info_json)


# ═══════════════════════════════════════════════════════════════
#  Deprecated stub — keeps old workflows loadable
# ═══════════════════════════════════════════════════════════════

class PowerLTXLoraLoaderExtra:
    """Deprecated — renamed to MultiLoRALoader."""

    DESCRIPTION = (
        "[DEPRECATED] This node has been renamed to 'Multi LoRA Loader'. "
        "To migrate: copy the JSON data below, add a new Multi LoRA Loader "
        "node, click its cog button (\u2699), and paste the data in."
    )

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "lora_data": ("STRING", {
                    "default": "[]",
                    "multiline": True,
                }),
            },
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "noop"
    CATEGORY = "loaders"
    DEPRECATED = True

    def noop(self, lora_data="[]"):
        return {}


# ═══════════════════════════════════════════════════════════════
#  Utility: Parse a JSON string into a Python object
# ═══════════════════════════════════════════════════════════════

class MultiLoRA_ParseJSON:
    """Parses a JSON string into a native Python object (list, dict, etc.).

    Useful for feeding structured data to nodes that accept any-type
    inputs (e.g. Power Puter) but cannot decode JSON strings themselves.
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "json_string": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("data",)
    FUNCTION = "parse"
    CATEGORY = "loaders"
    DESCRIPTION = "Parses a JSON string into a Python object (list, dict, number, etc.) so it can be consumed by nodes that accept any-type inputs."

    def parse(self, json_string):
        try:
            return (json.loads(json_string),)
        except Exception as e:
            raise ValueError(f"[Parse JSON] Invalid JSON: {e}")


# ═══════════════════════════════════════════════════════════════
#  MultiLoRA Cycle — iterate LoRAs × strengths across queue runs
# ═══════════════════════════════════════════════════════════════

class MultiLoRA_Cycle:
    """Cycles through LoRAs and strengths in a connected MultiLoRALoader.

    Connect the ``load_options`` output to a MultiLoRALoader's
    ``load_options`` input.  The companion JS frontend handles all
    mutation of the loader's LoRA table via the ``beforeQueued`` hook
    — by the time Python executes, the loader already has the correct
    ``lora_data`` for this iteration.

    The Python side packages informational metadata into the
    ``LOAD_OPTIONS`` output so the loader (and downstream nodes)
    can detect that cycling is active.
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "strengths": ("STRING", {
                    "default": "0.5,0.75,1.0",
                    "tooltip": "Comma-separated strength values to cycle through for each LoRA.",
                }),
                "lora_index": ("INT", {
                    "default": 1, "min": 1, "max": 9999, "step": 1,
                    "tooltip": "Current LoRA position (1-based). Auto-incremented by the JS frontend when mode is 'increment'.",
                }),
                "strength_index": ("INT", {
                    "default": 1, "min": 1, "max": 9999, "step": 1,
                    "tooltip": "Current strength position (1-based). Auto-incremented each queue run.",
                }),
                "mode": (["increment", "fixed"], {
                    "default": "increment",
                    "tooltip": "'increment' auto-advances each run; 'fixed' stays on the current indices.",
                }),
                "loop": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "When all combinations are exhausted, wrap back to the start instead of stopping.",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "prompt": "PROMPT",
            },
        }

    RETURN_TYPES = ("LOAD_OPTIONS",)
    RETURN_NAMES = ("load_options",)
    FUNCTION = "cycle"
    CATEGORY = "loaders"
    DESCRIPTION = (
        "Cycles through LoRAs and strength values in a connected "
        "Multi LoRA Loader.  Set strengths as a comma-separated list, "
        "connect to the loader, and queue repeatedly to iterate."
    )

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always re-execute — the whole point is that state changes each run.
        return float("NaN")

    @staticmethod
    def _count_loader_loras(prompt, unique_id):
        """Count non-"None" LoRA rows in the connected MultiLoRALoader.

        Walks the prompt dict to find a MultiLoRALoader whose
        ``load_options`` input is linked to this cycle node, then
        parses its ``lora_data`` and counts valid rows.

        Returns 0 if no loader is found or data is unparseable.
        """
        if not prompt or unique_id is None:
            return 0

        uid_str = str(unique_id)
        for _node_id, node_data in prompt.items():
            if node_data.get("class_type") != "MultiLoRALoader":
                continue
            inputs = node_data.get("inputs", {})
            lo = inputs.get("load_options")
            # Connected inputs are serialised as [source_node_id, output_index]
            if isinstance(lo, list) and len(lo) >= 2 and str(lo[0]) == uid_str:
                try:
                    rows = json.loads(inputs.get("lora_data", "[]"))
                    return sum(
                        1 for r in rows
                        if r.get("lora") and r["lora"] != "None"
                    )
                except Exception:
                    return 0
        return 0

    def cycle(self, strengths, lora_index, strength_index, mode, loop,
              unique_id=None, extra_pnginfo=None, prompt=None):
        # Parse the strength list
        strength_list = []
        for s in strengths.split(","):
            s = s.strip()
            if s:
                try:
                    strength_list.append(float(s))
                except ValueError:
                    pass
        if not strength_list:
            strength_list = [1.0]

        # Convert 1-based user indices to 0-based internal indices
        s_idx = max(0, min(strength_index - 1, len(strength_list) - 1))
        active_strength = strength_list[s_idx]

        # ── Halt execution when all combinations are exhausted ──
        # In increment mode with loop off, the JS frontend sets
        # lora_index past the end once every LoRA × strength pair
        # has been processed.  Return an ExecutionBlocker to stop
        # downstream execution and halt instant-mode auto-queue.
        if mode == "increment" and not loop:
            lora_count = self._count_loader_loras(prompt, unique_id)
            if lora_count > 0 and lora_index > lora_count:
                return (ExecutionBlocker(
                    "MultiLoRA Cycle complete \u2014 all LoRA/strength "
                    "combinations have been processed."
                ),)

        # ── Patch saved metadata so loaded workflows use "fixed" mode ──
        # This only affects the data embedded in output files (PNG/video
        # metadata).  The live workflow's mode widget is not changed.
        #
        # Widget order in widgets_values:
        #   0: strengths
        #   1: lora_index
        #   2: strength_index
        #   3: mode           ← change to "fixed"
        #   4: loop
        MODE_WIDGET_INDEX = 3

        # Update the workflow JSON (becomes EXTRA_PNGINFO in output files)
        workflow = None
        if isinstance(extra_pnginfo, list) and len(extra_pnginfo) > 0:
            workflow = extra_pnginfo[0].get("workflow")
        elif isinstance(extra_pnginfo, dict):
            workflow = extra_pnginfo.get("workflow")

        if workflow:
            def apply_cycle_changes(node):
                if "widgets_values" in node:
                    if len(node["widgets_values"]) > MODE_WIDGET_INDEX:
                        node["widgets_values"][MODE_WIDGET_INDEX] = "fixed"

            update_node_in_workflow(workflow, unique_id, apply_cycle_changes)

        # Update the prompt dict (API-format data saved alongside workflow)
        if prompt and unique_id is not None:
            node_id_str = str(unique_id)
            if node_id_str in prompt:
                prompt[node_id_str]["inputs"]["mode"] = "fixed"

        return ({
            "cycling": True,
            "lora_index": lora_index,
            "strength_index": strength_index,
            "strength": active_strength,
            "total_strengths": len(strength_list),
            "mode": mode,
            "loop": loop,
        },)
