"""LoRA rank detection for the Multi LoRA Loader UI.

The rank of a LoRA is the first dimension of each module's "down"
matrix (``lora_down.weight`` / ``lora_A.weight`` / ...).  Safetensors
files start with a JSON header listing every tensor's shape, so the
rank can be read from that header alone -- no tensor data is loaded.

Results are cached in a small JSON file keyed by LoRA name and
validated against the file's size and mtime, so each LoRA file is only
read once (until it changes).  Later lookups need only an ``os.stat``.
"""

import asyncio
import json
import os
import struct
import threading
from collections import Counter

import folder_paths

# Suffixes of the per-module "down" tensor, whose shape[0] is the rank.
# Mirrors the formats counted in MultiLoRALoader._warn_on_key_mismatch.
_DOWN_SUFFIXES = (
    ".lora_down.weight",              # regular / kohya (incl. LoCon conv)
    ".lora_A.weight",                 # diffusers / peft
    "_lora.down.weight",              # diffusers alt
    ".lora.down.weight",              # diffusers alt2
    ".lora_A",                        # mochi
    ".lora_linear_layer.down.weight", # transformers
    ".lora_A.default.weight",         # qwen default
    ".hada_w1_b",                     # LyCORIS LoHa ([rank, in])
    ".lokr_w2_b",                     # LyCORIS LoKr, factorized ([rank, in])
)

# Refuse absurd header sizes (corrupt / non-safetensors file).
_MAX_HEADER_BYTES = 100 * 1024 * 1024

_CACHE_VERSION = 2  # bump when read_rank_info output changes
_cache_lock = threading.Lock()
_cache = None  # lazily loaded: {lora_name: {"size", "mtime", "info"}}


def _cache_path():
    try:
        base = folder_paths.get_user_directory()
    except Exception:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "multi_lora_loader", "rank_cache.json")


def _load_cache():
    global _cache
    if _cache is not None:
        return _cache
    _cache = {}
    try:
        with open(_cache_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("version") == _CACHE_VERSION:
            _cache = data.get("entries", {})
    except Exception:
        pass
    return _cache


def _save_cache():
    path = _cache_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"version": _CACHE_VERSION, "entries": _cache}, f)
        os.replace(tmp, path)
    except Exception as e:
        print(f"[MultiLoRALoader] Could not save rank cache: {e}")


def read_rank_info(path):
    """Read rank info from a safetensors header.

    Returns a dict ``{"rank", "min", "max", "alpha"}`` (alpha only when
    the trainer stored ``ss_network_alpha`` metadata), or ``None`` when
    the rank can't be determined (non-safetensors file, unknown format).
    """
    if not path.lower().endswith(".safetensors"):
        return None
    try:
        with open(path, "rb") as f:
            raw_len = f.read(8)
            if len(raw_len) != 8:
                return None
            (header_len,) = struct.unpack("<Q", raw_len)
            if header_len <= 0 or header_len > _MAX_HEADER_BYTES:
                return None
            header = json.loads(f.read(header_len))
    except Exception:
        return None

    meta = header.get("__metadata__") or {}

    ranks = Counter()
    is_lokr = False
    for key, entry in header.items():
        if key == "__metadata__" or not isinstance(entry, dict):
            continue
        if ".lokr_w" in key:
            is_lokr = True
        if key.endswith(_DOWN_SUFFIXES):
            shape = entry.get("shape") or []
            if shape:
                ranks[int(shape[0])] += 1

    alpha = meta.get("ss_network_alpha")
    try:
        alpha = float(alpha) if alpha not in (None, "", "None") else None
    except (TypeError, ValueError):
        alpha = None

    if ranks:
        rank = ranks.most_common(1)[0][0]
        return {"rank": rank, "min": min(ranks), "max": max(ranks), "alpha": alpha}

    # Fall back to kohya metadata.
    try:
        dim = int(meta.get("ss_network_dim"))
        return {"rank": dim, "min": dim, "max": dim, "alpha": alpha}
    except (TypeError, ValueError):
        pass

    # Unfactorized LoKr has no rank (full Kronecker factors) -- report the
    # type so the UI can still say what it is.
    if is_lokr:
        return {"rank": None, "kind": "LoKr"}
    return None


def get_ranks(names):
    """Return ``{name: info_or_None}`` for each LoRA name, using the cache."""
    result = {}
    dirty = False
    with _cache_lock:
        cache = _load_cache()
        for name in names:
            if not isinstance(name, str) or not name or name == "None":
                continue
            path = folder_paths.get_full_path("loras", name)
            if not path:
                result[name] = None
                continue
            try:
                st = os.stat(path)
            except OSError:
                result[name] = None
                continue

            entry = cache.get(name)
            if entry and entry.get("size") == st.st_size and entry.get("mtime") == st.st_mtime_ns:
                result[name] = entry.get("info")
                continue

            info = read_rank_info(path)
            cache[name] = {"size": st.st_size, "mtime": st.st_mtime_ns, "info": info}
            result[name] = info
            dirty = True

        if dirty:
            _save_cache()
    return result


def register_routes():
    """Register ``POST /multi_lora_loader/ranks`` on the ComfyUI server.

    Body: ``{"names": [lora_name, ...]}`` -> ``{lora_name: info|null}``.
    """
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    @PromptServer.instance.routes.post("/multi_lora_loader/ranks")
    async def _ranks(request):
        try:
            body = await request.json()
            names = body.get("names") or []
            if not isinstance(names, list):
                names = []
        except Exception:
            return web.json_response({}, status=400)
        loop = asyncio.get_running_loop()
        data = await loop.run_in_executor(None, get_ranks, names)
        return web.json_response(data)
