var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => NoDuplicatePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var POPOVER_SELECTOR = ".popover, .hover-popover, .hover-editor";
var NoDuplicatePlugin = class extends import_obsidian.Plugin {
  async onload() {
    console.log("No Duplicate Leaves (Optimized for ALL file types) loaded");
    this.register(
      around(import_obsidian.Workspace.prototype, {
        openLinkText: (next) => {
          const app = this.app;
          return function(linktext, sourcePath, newLeaf, openViewState) {
            if (newLeaf) return next.call(this, linktext, sourcePath, newLeaf, openViewState);
            const targetFile = app.metadataCache.getFirstLinkpathDest(
              (0, import_obsidian.getLinkpath)(linktext),
              sourcePath
            );
            const existingLeaf = targetFile ? findLeafByPath(app, targetFile.path) : null;
            if (!existingLeaf) {
              return next.call(this, linktext, sourcePath, newLeaf, openViewState);
            }
            focusLeaf(app, existingLeaf);
            if (hasDeepLinkPayload(linktext, openViewState)) {
              return next.call(this, linktext, sourcePath, false, openViewState);
            }
            return Promise.resolve();
          };
        }
      })
    );
    this.register(
      around(import_obsidian.WorkspaceLeaf.prototype, {
        openFile: (next) => {
          const app = this.app;
          return function(file, openState) {
            const existingLeaf = findLeafByPath(app, file.path, this);
            if (!existingLeaf) return next.call(this, file, openState);
            focusLeaf(app, existingLeaf, true);
            const isNewEmptyLeaf = this.view && !this.view.file && this.view.getViewType() === "empty";
            if (isNewEmptyLeaf) {
              const containerEl = this.containerEl;
              if (containerEl) {
                containerEl.addClass("unique-tab-hidden");
              }
              window.setTimeout(() => {
                this.detach();
              }, 0);
            }
            if (hasEditorStatePayload(openState)) {
              return next.call(existingLeaf, file, openState);
            }
            return Promise.resolve();
          };
        }
      })
    );
  }
  onunload() {
    console.log("No Duplicate Leaves unloaded");
  }
};
function findLeafByPath(app, path, ignoreLeaf = null) {
  let foundLeaf = null;
  app.workspace.iterateAllLeaves((leaf) => {
    if (foundLeaf) return;
    if (ignoreLeaf && leaf === ignoreLeaf) return;
    if (isInPopover(leaf)) return;
    const viewState = leaf.getViewState();
    const leafFile = viewState?.state?.file;
    const isMatch = typeof leafFile === "string" && leafFile.length > 0 && leafFile === path;
    if (isMatch) foundLeaf = leaf;
  });
  return foundLeaf;
}
function isInPopover(leaf) {
  const containerEl = leaf.containerEl;
  if (!containerEl || typeof containerEl.closest !== "function") return false;
  return containerEl.closest(POPOVER_SELECTOR) !== null;
}
function focusLeaf(app, leaf, delay = false) {
  if (delay) {
    window.setTimeout(() => {
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }, 10);
  } else {
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }
}
function hasDeepLinkPayload(linktext, openViewState) {
  return !!(0, import_obsidian.parseLinktext)(linktext).subpath || hasEditorStatePayload(openViewState);
}
function hasEditorStatePayload(openState) {
  if (!openState) return false;
  const { eState, state } = openState;
  return hasKeys(eState) || hasKeys(state);
}
function hasKeys(obj) {
  return !!obj && Object.keys(obj).length > 0;
}
function around(obj, factories) {
  const target = obj;
  const removers = Object.keys(factories).map((key) => {
    const prev = target[key];
    const next = factories[key](prev);
    const original = prev;
    target[key] = next;
    return () => {
      if (target[key] === next) target[key] = original;
    };
  });
  return () => removers.forEach((r) => r());
}
