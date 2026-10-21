import {
    App,
    Plugin,
    WorkspaceLeaf,
    Workspace,
    getLinkpath,
    parseLinktext,
    TFile,
    OpenViewState
} from "obsidian";

type AnyFunction = (...args: unknown[]) => unknown;

/**
 * 悬浮预览（Hover Editor、原生 page preview）里的 leaf 同样会出现在 workspace 的 leaf 迭代中，
 * 但它们不是用户真正“打开的标签”。把焦点抢到预览窗口会让链接看起来“没反应”，所以要排除掉。
 */
const POPOVER_SELECTOR = '.popover, .hover-popover, .hover-editor';

export default class NoDuplicatePlugin extends Plugin {
    async onload() {
        console.log("No Duplicate Leaves (Optimized for ALL file types) loaded");

        // 1. 拦截 openLinkText (通过链接点击打开)
        this.register(
            around(Workspace.prototype, {
                openLinkText: (next: AnyFunction) => {
                    const app = this.app;
                    return function (this: Workspace, linktext: string, sourcePath: string, newLeaf?: boolean | "split" | "tab" | "window", openViewState?: OpenViewState): Promise<void> {
                        // 显式要求新标签（例如 Ctrl/Cmd + 点击）时完全透传，不劫持
                        if (newLeaf) return next.call(this, linktext, sourcePath, newLeaf, openViewState) as Promise<void>;

                        const targetFile = app.metadataCache.getFirstLinkpathDest(
                            getLinkpath(linktext),
                            sourcePath
                        );

                        const existingLeaf = targetFile ? findLeafByPath(app, targetFile.path) : null;

                        // 目标没有已打开的标签：交给内层（PDF++ / Obsidian 原生）正常打开
                        if (!existingLeaf) {
                            return next.call(this, linktext, sourcePath, newLeaf, openViewState) as Promise<void>;
                        }

                        // 先把视线切到已有标签
                        focusLeaf(app, existingLeaf);

                        // 带锚点 / 选区等深链接信息时不能就此返回：必须把原始链接交回内层链，
                        // 让排在内层的插件（PDF++：应用 eState.subpath 并用 highlightSubpath 画出选区高亮）
                        // 或原生实现（PDFView.setState / MarkdownView 的 setEphemeralState）
                        // 在这个已经激活的标签上完成定位。
                        if (hasDeepLinkPayload(linktext, openViewState)) {
                            return next.call(this, linktext, sourcePath, false, openViewState) as Promise<void>;
                        }

                        // 普通链接：只聚焦已有标签，不产生新标签
                        return Promise.resolve();
                    };
                },
            })
        );

        // 2. 拦截 openFile (通过文件树、快速切换或第三方插件直接打开)
        this.register(
            around(WorkspaceLeaf.prototype, {
                openFile: (next: AnyFunction) => {
                    const app = this.app;
                    return function (this: WorkspaceLeaf, file: TFile, openState?: OpenViewState): Promise<void> {
                        // 悬浮预览（原生 page preview / Hover Editor）里的 leaf 只是一个“预览副本”。
                        // 绝不能把它改向主工作区的真实标签：否则 Ctrl+hover 一个已打开的 PDF 时，
                        // 会把那个标签抢到前台并跳页 —— 而用户根本没有点击链接。
                        if (isInPopover(this)) return next.call(this, file, openState) as Promise<void>;

                        // 全新的空 leaf 说明调用方明确要求“新标签”（Ctrl/Cmd+点击、拖到分屏、
                        // 命令“在新标签页中打开”等）。此时若把打开改向已有标签，
                        // Ctrl+点击 就会被静默降级成“聚焦已有标签”，必须放行。
                        const leafView = this.view;
                        if (leafView && leafView.getViewType() === "empty") {
                            return next.call(this, file, openState) as Promise<void>;
                        }

                        const existingLeaf = findLeafByPath(app, file.path, this);

                        // 没有其他已打开的同文件标签：正常打开
                        if (!existingLeaf) return next.call(this, file, openState) as Promise<void>;

                        // 聚焦已有标签（延迟解决焦点抢占）
                        focusLeaf(app, existingLeaf, true);

                        // 说明：原先这里还有一段「隐身 + 立即 detach 新空 leaf」的逻辑。
                        // 现在空 leaf 在上面已作为“显式新标签”被放行，不会再走到这里，
                        // 因此该分支已删除；重复标签在源头就被阻止，不会产生需要隐藏的空白页。

                        // 关键修复：把 openState 里的定位信息（eState.subpath / page / line 等）
                        // 应用到已有标签，而不是丢弃它 —— 否则 PDF++ 的深链接只会聚焦、不会跳转。
                        if (hasEditorStatePayload(openState)) {
                            return next.call(existingLeaf, file, openState) as Promise<void>;
                        }

                        return Promise.resolve();
                    };
                },
            })
        );
    }

    onunload() {
        console.log("No Duplicate Leaves unloaded");
    }
}

// --- 辅助函数 ---

/** 在全工作区里找出打开着 `path` 的标签（跳过 `ignoreLeaf` 与悬浮预览里的 leaf）。 */
function findLeafByPath(app: App, path: string, ignoreLeaf: WorkspaceLeaf | null = null): WorkspaceLeaf | null {
    let foundLeaf: WorkspaceLeaf | null = null;

    app.workspace.iterateAllLeaves((leaf) => {
        if (foundLeaf) return;
        if (ignoreLeaf && leaf === ignoreLeaf) return;
        // 悬浮预览里的同名标签不算“已打开”，否则会把焦点抢到预览窗口里
        if (isInPopover(leaf)) return;

        const viewState = leaf.getViewState();

        // 额外校验 file 必须是非空字符串，防止 undefined/空值误匹配
        const leafFile = viewState?.state?.file;
        const isMatch =
            typeof leafFile === 'string' &&
            leafFile.length > 0 &&
            leafFile === path;

        if (isMatch) foundLeaf = leaf;
    });

    return foundLeaf;
}

/** 判断 leaf 是否位于悬浮预览（Hover Editor / page preview / popover）中。 */
function isInPopover(leaf: WorkspaceLeaf): boolean {
    // @ts-ignore: containerEl 属于未完全暴露的 DOM API
    const containerEl = leaf.containerEl as HTMLElement | undefined;
    if (!containerEl || typeof containerEl.closest !== 'function') return false;
    return containerEl.closest(POPOVER_SELECTOR) !== null;
}

/** 聚焦到指定标签。`delay` 用于避开 Obsidian 在打开文件过程中对焦点的抢占。 */
function focusLeaf(app: App, leaf: WorkspaceLeaf, delay: boolean = false): void {
    if (delay) {
        window.setTimeout(() => {
            app.workspace.setActiveLeaf(leaf, { focus: true });
        }, 10);
    } else {
        app.workspace.setActiveLeaf(leaf, { focus: true });
    }
}

/**
 * linktext 是否带“深链接”信息（`#标题`、`#^块`、PDF 的 `#page=&selection=` 等），
 * 或调用方已经通过 openViewState 带上了定位信息。
 */
function hasDeepLinkPayload(linktext: string, openViewState?: OpenViewState): boolean {
    return !!parseLinktext(linktext).subpath || hasEditorStatePayload(openViewState);
}

/** openState 里是否携带需要落到目标标签上的定位信息。 */
function hasEditorStatePayload(openState?: OpenViewState): boolean {
    if (!openState) return false;
    const { eState, state } = openState as {
        eState?: Record<string, unknown>;
        state?: Record<string, unknown>;
    };
    return hasKeys(eState) || hasKeys(state);
}

function hasKeys(obj?: Record<string, unknown>): boolean {
    return !!obj && Object.keys(obj).length > 0;
}

/*
 * 变更说明：原先这里有一个手写的 scrollToElement()，在命中已打开标签后用
 * `editor.setCursor` + `editor.scrollIntoView` 滚动到 `#标题` / `#^块` 位置。
 * 它只对 markdown 视图生效，而且因为外层包装提前 return，把内层插件（PDF++ 等）
 * 对深链接的处理整个屏蔽掉了（表现为“点击 PDF 高亮链接只聚焦、不跳转”）。
 *
 * 现在 markdown 锚点与 PDF 深链接统一走“先聚焦已有标签 + 把原始链接交回内层链”：
 * Obsidian 原生会用 MarkdownView.setEphemeralState({ line, ... }) 完成滚动。
 *
 * 若哪天 markdown 锚点出现回归，可以按下面的旧逻辑恢复：
 *   const hashMatch = linktext.match(/(#|\^)(.*)$/);          // 取 type(#/^) 与 name
 *   const cache = app.metadataCache.getFileCache(view.file);   // headings / blocks
 *   const line = type === '#' ? cache.headings?.find(h => h.heading === name)?.position.start.line
 *                             : cache.blocks?.[name]?.position.start.line;
 *   view.editor.setCursor({ line, ch: 0 });
 *   view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
 */

// 代理拦截函数 (Monkey Patching)
// 返回一个清理函数，供 this.register 注册，确保在插件禁用时能够正确卸载钩子
//
// 委托契约：包装函数必须把原始的 `linktext` 与 `openViewState` 原样传给 `next`。
// 否则排在内层的插件（例如 PDF++ 的 openLinkText 补丁）拿不到 subpath，
// 深链接的页面跳转与选区高亮都会失效。
function around(obj: object, factories: Record<string, (original: AnyFunction) => AnyFunction>): () => void {
    // 用 object 而不是 Record<string, unknown> 接收被代理的原型对象：
    // Workspace / WorkspaceLeaf 的原型类型没有字符串索引签名，用 Record 会导致 tsc 报错。
    const target = obj as Record<string, unknown>;

    const removers = Object.keys(factories).map((key) => {
        const prev = target[key] as AnyFunction;
        const next = factories[key](prev);
        const original = prev;
        target[key] = next;
        return () => {
            if (target[key] === next) target[key] = original;
        };
    });
    // Obsidian 的 this.register() 接收一个 function 作为参数
    return () => removers.forEach((r) => r());
}
