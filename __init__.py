from .multi_lora_loader import MultiLoRALoader, PowerLTXLoraLoaderExtra, MultiLoRA_ParseJSON, MultiLoRA_Cycle
from .lora_rank import register_routes

register_routes()

NODE_CLASS_MAPPINGS = {
    "MultiLoRALoader": MultiLoRALoader,
    "PowerLTXLoraLoaderExtra": PowerLTXLoraLoaderExtra,
    "MultiLoRA_ParseJSON": MultiLoRA_ParseJSON,
    "MultiLoRA_Cycle": MultiLoRA_Cycle,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiLoRALoader": "Multi LoRA Loader",
    "PowerLTXLoraLoaderExtra": "Power LTX LoRA Loader Extra (Deprecated)",
    "MultiLoRA_ParseJSON": "Parse JSON (MultiLoRA)",
    "MultiLoRA_Cycle": "MultiLoRA Cycle",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
