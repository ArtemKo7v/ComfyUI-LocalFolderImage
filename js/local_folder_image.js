import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "ArtemKo7vLocalFolderImage";
const SUBFOLDER = "artemko7v_local_folder_image";

/* -------------------------------------------------------------- helpers */

function widgetOf(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function widgetValue(node, name, fallback) {
  const w = widgetOf(node, name);
  return w ? w.value : fallback;
}

function parseExtensions(raw) {
  return String(raw || "")
    .split(/[,;\s]+/)
    .map((x) => x.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
}

function extensionOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/**
 * Natural, locale-aware comparison so that "img2" sorts before "img10".
 * A stable order is essential: file_index is only meaningful if the list
 * does not reshuffle between runs.
 */
function comparePaths(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Apply the current filter widgets to the stored File references.
 *
 * A File is a lazy handle to data on disk, not the bytes themselves, so
 * re-filtering thousands of them on every run costs nothing.
 */
function filteredFiles(node) {
  const all = node._allFiles || [];
  const extensions = parseExtensions(
    widgetValue(node, "extensions", "png,jpg,jpeg,webp,bmp")
  );
  const recursive = widgetValue(node, "scan", "top_level") === "recursive";

  const out = [];
  for (const file of all) {
    const relative = file.webkitRelativePath || file.name;
    // webkitdirectory is always recursive; "top_level" is enforced here by
    // keeping only paths of the form "<picked folder>/<file>".
    if (!recursive && relative.split("/").length > 2) continue;
    if (extensions.length && !extensions.includes(extensionOf(file.name))) continue;
    if (file.size === 0) continue;
    out.push(file);
  }

  out.sort((a, b) =>
    comparePaths(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name)
  );
  return out;
}

function effectiveLoop(node) {
  const mode = widgetValue(node, "index_mode", "fixed");
  // loop is meaningless for "fixed" and "random": those never run off the end.
  if (mode === "fixed" || mode === "random") return true;
  return widgetValue(node, "loop", true) !== false;
}

function notifyError(message) {
  try {
    app.extensionManager?.toast?.add({
      severity: "error",
      summary: "Local Folder Image",
      detail: message,
      life: 8000,
    });
  } catch (e) {
    /* toast API not available on this frontend version */
  }
  const error = new Error(`[Local Folder Image] ${message}`);
  console.error(error);
  return error;
}

/* ------------------------------------------------------------ node state */

function refreshLabel(node) {
  if (!node._pickButton) return;

  const total = node._allFiles?.length || 0;
  if (!total) {
    node._pickButton.name = "Pick folder...";
  } else {
    const usable = filteredFiles(node).length;
    const suffix = node._exhausted ? " - exhausted" : "";
    node._pickButton.name = `Folder: ${usable} / ${total} files${suffix}`;
  }
  node.setDirtyCanvas(true, true);
}

/** Keep the file_index spinner bounded by the real file count. */
function syncIndexLimits(node) {
  const indexWidget = widgetOf(node, "file_index");
  if (!indexWidget) return;

  const count = filteredFiles(node).length;
  indexWidget.options = indexWidget.options || {};
  indexWidget.options.min = 1;
  indexWidget.options.max = count > 0 ? count : 0xffffffff;

  if (count > 0 && Number(indexWidget.value) > count) {
    indexWidget.value = count;
  }
}

/** loop is forced on and greyed out for the modes that cannot run off the end. */
function syncLoopWidget(node) {
  const loopWidget = widgetOf(node, "loop");
  if (!loopWidget) return;

  const mode = widgetValue(node, "index_mode", "fixed");
  const forced = mode === "fixed" || mode === "random";
  loopWidget.disabled = forced;
  if (forced) loopWidget.value = true;
}

function clearExhausted(node) {
  if (node._exhausted) {
    node._exhausted = false;
    refreshLabel(node);
  }
}

function syncAll(node) {
  syncLoopWidget(node);
  syncIndexLimits(node);
  refreshLabel(node);
}

/** Chain a listener onto an existing widget callback without replacing it. */
function onWidgetChange(node, name, handler) {
  const widget = widgetOf(node, name);
  if (!widget) return;

  const original = widget.callback;
  widget.callback = function (...args) {
    const result = original?.apply(this, args);
    try {
      handler();
    } catch (e) {
      console.error("[Local Folder Image] widget handler failed:", e);
    }
    return result;
  };
}

/* ------------------------------------------------------------------- UI */

function setupNode(node) {
  node._allFiles = null;
  node._exhausted = false;

  const input = document.createElement("input");
  input.type = "file";
  input.webkitdirectory = true;
  input.multiple = true;
  input.style.display = "none";
  document.body.appendChild(input);
  node._dirInput = input;

  input.addEventListener("change", () => {
    node._allFiles = Array.from(input.files || []);
    node._exhausted = false;

    const indexWidget = widgetOf(node, "file_index");
    if (indexWidget) indexWidget.value = 1;

    syncAll(node);
    // Reset so that picking the same folder again still fires "change".
    input.value = "";
  });

  // Added last on purpose: a trailing non-serialised widget cannot shift the
  // widgets_values indices of the widgets declared in INPUT_TYPES.
  const button = node.addWidget("button", "Pick folder...", "", () => {
    // Must be called from a user gesture, which a widget click is.
    input.click();
  });
  button.serialize = false;
  node._pickButton = button;

  const filenameWidget = widgetOf(node, "filename");
  if (filenameWidget) {
    // The uploaded path is per-run state; storing it in the workflow is noise.
    filenameWidget.serialize = false;
  }

  // Any manual edit means the user wants to keep going.
  onWidgetChange(node, "file_index", () => clearExhausted(node));
  onWidgetChange(node, "loop", () => clearExhausted(node));
  onWidgetChange(node, "index_mode", () => {
    clearExhausted(node);
    syncLoopWidget(node);
  });
  onWidgetChange(node, "extensions", () => {
    clearExhausted(node);
    syncIndexLimits(node);
    refreshLabel(node);
  });
  onWidgetChange(node, "scan", () => {
    clearExhausted(node);
    syncIndexLimits(node);
    refreshLabel(node);
  });

  syncAll(node);
}

/* --------------------------------------------------------------- upload */

async function uploadFile(file) {
  const body = new FormData();
  body.append("image", file, file.name);
  body.append("type", "temp");
  body.append("subfolder", SUBFOLDER);
  body.append("overwrite", "true");

  // fetch streams the Blob straight off disk, so peak memory is the network
  // buffer rather than the whole file.
  const response = await api.fetchApi("/upload/image", { method: "POST", body });
  if (response.status !== 200) {
    throw new Error(`server returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

/* ----------------------------------------------------- index advancement */

/**
 * Move file_index on for the *next* run, mirroring how control_after_generate
 * works for seeds: the displayed value is the one that was just used.
 *
 * With loop disabled, running off either end does not raise here -- it marks
 * the node exhausted so that the *next* queue attempt is the one that fails.
 */
function advanceIndex(node, current, count) {
  const indexWidget = widgetOf(node, "file_index");
  if (!indexWidget) return;

  const mode = widgetValue(node, "index_mode", "fixed");
  const loop = effectiveLoop(node);

  let next = current;

  if (mode === "fixed") {
    return;
  } else if (mode === "random") {
    next = 1 + Math.floor(Math.random() * count);
  } else if (mode === "increment") {
    if (current < count) {
      next = current + 1;
    } else if (loop) {
      next = 1;
    } else {
      node._exhausted = true;
      refreshLabel(node);
      return;
    }
  } else if (mode === "decrement") {
    if (current > 1) {
      next = current - 1;
    } else if (loop) {
      next = count;
    } else {
      node._exhausted = true;
      refreshLabel(node);
      return;
    }
  }

  indexWidget.value = next;
  node.setDirtyCanvas(true, true);
}

/* ------------------------------------------------------------ per-run work */

async function prepareNode(node) {
  if (!node._allFiles || node._allFiles.length === 0) {
    throw notifyError(`node #${node.id}: no folder selected. Click "Pick folder...".`);
  }

  const files = filteredFiles(node);
  const count = files.length;

  if (count === 0) {
    throw notifyError(
      `node #${node.id}: the selected folder contains no files matching ` +
        `"${widgetValue(node, "extensions", "")}" (scan: ` +
        `${widgetValue(node, "scan", "top_level")}).`
    );
  }

  const mode = widgetValue(node, "index_mode", "fixed");

  if (node._exhausted) {
    throw notifyError(
      `node #${node.id}: all ${count} files have been iterated (${mode} with ` +
        "loop disabled). Set file_index manually, enable loop, or pick a folder again."
    );
  }

  const index = Number(widgetValue(node, "file_index", 1));

  if (!Number.isFinite(index) || !Number.isInteger(index) || index < 1 || index > count) {
    throw notifyError(
      `node #${node.id}: file_index ${index} is out of range. ` +
        `Valid range is 1..${count}.`
    );
  }

  const file = files[index - 1];
  let uploaded;
  try {
    uploaded = await uploadFile(file);
  } catch (error) {
    // A File is a snapshot taken when the folder was picked. If the file has
    // since been deleted or rewritten, reading it fails. Substituting another
    // file would silently break the index contract, so surface it instead.
    throw notifyError(
      `node #${node.id}: could not read "${file.webkitRelativePath || file.name}" ` +
        `(index ${index}): ${error.message}. Pick the folder again to refresh the list.`
    );
  }

  const filenameWidget = widgetOf(node, "filename");
  if (filenameWidget) filenameWidget.value = uploaded;

  advanceIndex(node, index, count);
}

/* -------------------------------------------------------------- the hook */

/**
 * graphToPrompt is patched rather than queuePrompt: with a batch count above 1
 * the frontend calls graphToPrompt once per queued item, so each item gets its
 * own file and its own index advancement.
 *
 * Throwing here aborts queueing before anything reaches the server, which is
 * how "the next run must not start" is enforced.
 */
function installHook() {
  const original = app.graphToPrompt;
  if (!original || original.__artemKo7vLocalFolderImage) return;

  const patched = async function (...args) {
    const nodes = app.graph?._nodes ?? app.graph?.nodes ?? [];
    for (const node of nodes) {
      if (node.comfyClass !== NODE_CLASS && node.type !== NODE_CLASS) continue;
      if (node.mode === 2 || node.mode === 4) continue; // muted / bypassed
      await prepareNode(node);
    }
    return original.apply(this, args);
  };

  patched.__artemKo7vLocalFolderImage = true;
  app.graphToPrompt = patched;
}

/* ---------------------------------------------------------- registration */

app.registerExtension({
  name: "artemko7v.LocalFolderImage",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      setupNode(this);
      return result;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = onConfigure?.apply(this, arguments);
      // A loaded workflow never carries a folder selection.
      this._allFiles = null;
      this._exhausted = false;
      syncAll(this);
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._dirInput?.remove();
      this._dirInput = null;
      this._allFiles = null; // release the File references
      return onRemoved?.apply(this, arguments);
    };
  },

  async setup() {
    installHook();
  },
});
