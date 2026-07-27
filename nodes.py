"""
ArtemKo7v Local Folder Image -- backend part.

This node is intentionally "dumb": it knows nothing about the folder on the
client machine. All filesystem work happens in the frontend extension
(js/local_folder_image.js), which -- before the prompt is submitted -- uploads
exactly ONE file into the server temp directory and writes its relative path
into the `filename` widget.

Index selection, range validation and exhaustion checks also live in the
frontend, because only the browser knows how many files the chosen folder has.
"""

import os

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths


def _resolve_temp_path(relative: str) -> str:
    """Resolve a path inside the ComfyUI temp directory, rejecting traversal."""
    if not relative:
        raise ValueError(
            "No file was uploaded. Pick a folder on the node and queue the "
            "workflow from the browser."
        )

    base = os.path.realpath(folder_paths.get_temp_directory())
    full = os.path.realpath(os.path.join(base, relative))

    if full != base and not full.startswith(base + os.sep):
        raise ValueError(f"Rejected path outside the temp directory: {relative}")

    return full


def _load_image_and_mask(path: str):
    """Load an image as an (1, H, W, 3) tensor plus a mask from its alpha channel."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)

    if img.mode == "I":
        # 32-bit integer images need to be scaled down before conversion.
        img = img.point(lambda i: i * (1 / 255))

    rgb = img.convert("RGB")
    arr = np.array(rgb).astype(np.float32) / 255.0
    image = torch.from_numpy(arr)[None, ]

    if "A" in img.getbands():
        alpha = np.array(img.getchannel("A")).astype(np.float32) / 255.0
        mask = 1.0 - torch.from_numpy(alpha)
    else:
        mask = torch.zeros((64, 64), dtype=torch.float32)

    return image, mask.unsqueeze(0)


class ArtemKo7vLocalFolderImage:
    """Load one image, selected by index, from a folder on the client machine."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 1-based position of the file inside the sorted, filtered list.
                # The upper bound is tightened by the frontend once a folder is
                # picked; the value here only needs to be permissive.
                "file_index": ("INT", {
                    "default": 1, "min": 1, "max": 0xFFFFFFFF, "step": 1,
                }),
                # What to do with file_index *after* the current run.
                "index_mode": (
                    ["fixed", "increment", "decrement", "random"],
                    {"default": "increment"},
                ),
                # Wrap around at the ends of the list. Ignored (treated as true)
                # for "fixed" and "random".
                "loop": ("BOOLEAN", {"default": True}),
                # Whether subfolders are included in the file list.
                "scan": (["top_level", "recursive"], {"default": "top_level"}),
                # Comma-separated extension filter.
                "extensions": ("STRING", {"default": "png,jpg,jpeg,webp,bmp"}),
                # Filled in automatically by the frontend on every run.
                "filename": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "INT")
    RETURN_NAMES = ("image", "mask", "filename", "file_index")
    FUNCTION = "load"
    CATEGORY = "ArtemKo7v/image"

    @classmethod
    def IS_CHANGED(cls, file_index, index_mode, loop, scan, extensions, filename):
        # Always re-execute. Without this, selecting the same file twice in a
        # row would return a cached result instead of reloading it.
        return float("nan")

    def load(self, file_index, index_mode, loop, scan, extensions, filename):
        path = _resolve_temp_path(filename)

        if not os.path.isfile(path):
            raise FileNotFoundError(
                f"Uploaded file not found on the server: {filename}. "
                "The workflow was probably queued outside the browser, or the "
                "temp directory has been cleared."
            )

        image, mask = _load_image_and_mask(path)
        return (image, mask, os.path.basename(filename), int(file_index))


NODE_CLASS_MAPPINGS = {
    "ArtemKo7vLocalFolderImage": ArtemKo7vLocalFolderImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ArtemKo7vLocalFolderImage": "Local Folder Image (client folder)",
}
