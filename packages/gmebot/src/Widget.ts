declare const define: any;
declare const $: any;

define(["jquery", "./commands"], function ($: any, Commands: any) {
    "use strict";

    type ModelingMode = "metamodel" | "domain";

    type ObjectListItem = { name: string; path: string; guid: string };

    type ObjectList = {
        existing: ObjectListItem[];
        new: ObjectListItem[];
        deleted: ObjectListItem[];
    };

    /** Context sent with each chat request; built from WebGME client, State, and modeling mode. */
    interface ChatContext {
        projectId?: string;
        branchName?: string;
        activeNodeId?: string;
        activeVisualizerId?: string;
        activeTabId?: number;
        modelingMode?: ModelingMode;
        objectList?: ObjectList;
        /** Set by client when sending a continuation after backend requested diagramLayout. */
        diagramLayout?: {
            nodes: Array<{ path: string; x: number; y: number; width?: number; height?: number }>;
            connections?: Array<{ sourcePath: string; targetPath: string }>;
        };
        /** @deprecated */
        scope?: string;
        /** @deprecated */
        domain?: string[];
    }

    /** Continuation message sent when the client provides layout data in a follow-up request. */
    const CONTINUATION_MESSAGE = "[Continuation: layout data provided.]";

    /**
     * Collect diagram layout (paths and bounding boxes) from the active diagram widget.
     * Works for both model diagram (ModelEditor) and meta diagram (MetaEditor): uses
     * WebGMEGlobal.PanelManager.getActivePanel() then designerCanvas or diagramDesigner.
     * Resolves designer component IDs to actual node paths via control._ComponentID2GMEID
     * (and _ComponentID2DocItemID for meta doc items). Also collects connections (edges)
     * with sourcePath/targetPath for connectivity context.
     */
    function getDiagramLayoutFromClient(): {
        nodes: Array<{ path: string; x: number; y: number; width?: number; height?: number }>;
        connections?: Array<{ sourcePath: string; targetPath: string }>;
    } {
        const g = (typeof window !== "undefined" && (window as any).WebGMEGlobal) || undefined;
        const panel = g?.PanelManager && typeof g.PanelManager.getActivePanel === "function"
            ? g.PanelManager.getActivePanel()
            : undefined;
        if (!panel || !panel.control) return { nodes: [] };
        const control = panel.control;
        const designer = control.designerCanvas || control.diagramDesigner;
        if (!designer || !designer.items || !designer.itemIds) return { nodes: [] };

        /** Map designer component ID to actual path: GME path (model/meta concepts) or doc-item id (meta doc items). */
        function resolvePath(componentId: string): string {
            const c2g = control._ComponentID2GMEID;
            const c2d = control._ComponentID2DocItemID;
            if (c2g && typeof c2g[componentId] === "string") return c2g[componentId];
            if (c2d && typeof c2d[componentId] === "string") return c2d[componentId];
            return componentId;
        }

        const nodes: Array<{ path: string; x: number; y: number; width?: number; height?: number }> = [];
        for (let i = 0; i < designer.itemIds.length; i++) {
            const id = designer.itemIds[i];
            const item = designer.items[id];
            if (!item || typeof item.getBoundingBox !== "function") continue;
            const bbox = item.getBoundingBox();
            if (bbox == null || typeof bbox.x !== "number" || typeof bbox.y !== "number") continue;
            const path = resolvePath(id);
            const width = typeof bbox.x2 === "number" ? bbox.x2 - bbox.x : undefined;
            const height = typeof bbox.y2 === "number" ? bbox.y2 - bbox.y : undefined;
            nodes.push({ path, x: bbox.x, y: bbox.y, width, height });
        }

        const connections: Array<{ sourcePath: string; targetPath: string }> = [];
        if (designer.connectionIds && designer.connectionEndIDs) {
            for (let c = 0; c < designer.connectionIds.length; c++) {
                const connId = designer.connectionIds[c];
                const endIds = designer.connectionEndIDs[connId];
                if (!endIds || endIds.srcObjId == null || endIds.dstObjId == null) continue;
                const srcPath = resolvePath(endIds.srcObjId);
                const dstPath = resolvePath(endIds.dstObjId);
                connections.push({ sourcePath: srcPath, targetPath: dstPath });
            }
        }

        return { nodes, connections };
    }

    const GMEBOT_ICON_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-linejoin="round" class="gme-bot-btn-icon">' +
        '<defs><linearGradient id="metallicGrey" x1="0%" y1="0%" x2="100%" y2="100%">' +
        '<stop offset="0%" stop-color="#d8dce0"/><stop offset="50%" stop-color="#b8bcc0"/><stop offset="100%" stop-color="#989ca0"/>' +
        '</linearGradient>' +
        '<filter id="faceShadow" x="-15%" y="-15%" width="130%" height="130%">' +
        '<feDropShadow dx="0.25" dy="0.4" stdDeviation="0.35" flood-color="#000" flood-opacity="0.4"/>' +
        '</filter></defs>' +
        '<path d="M12 2 L20 5 L20 17.5 L12 22 L4 17.5 L4 5 Z" fill="url(#metallicGrey)" stroke="url(#metallicGrey)" stroke-width="1.4" filter="url(#faceShadow)"/>' +
        '<!-- Upper left: blue hexagon, black eyeball centered in hexagon -->' +
        '<path d="M8 5.2 L11 7 L11 10.8 L8 12.6 L5 10.8 L5 7 Z" stroke="#337ab7" stroke-width="1.2"/>' +
        '<circle cx="8" cy="8.9" r="1.5" fill="#000"/>' +
        '<rect x="6.5" y="8.6" width="3" height="0.6" fill="url(#metallicGrey)"/>' +
        '<circle cx="8" cy="8.9" r="1.5" fill="none" stroke="#000" stroke-width="0.2"/>' +
        '<!-- Upper right: green hexagon, black eyeball -->' +
        '<path d="M16 5.2 L19 7 L19 10.8 L16 12.6 L13 10.8 L13 7 Z" stroke="#5cb85c" stroke-width="1.2"/>' +
        '<circle cx="16" cy="8.9" r="1.5" fill="#000"/>' +
        '<rect x="14.5" y="8.6" width="3" height="0.6" fill="url(#metallicGrey)"/>' +
        '<circle cx="16" cy="8.9" r="1.5" fill="none" stroke="#000" stroke-width="0.2"/>' +
        '<!-- Lower: red hexagon, mouth centered in hexagon -->' +
        '<path d="M12 12.8 L15 14.6 L15 18.4 L12 20.2 L9 18.4 L9 14.6 Z" stroke="#d9534f" stroke-width="1.2"/>' +
        '<rect x="10.2" y="15.5" width="3.6" height="2" stroke="#000" stroke-width="0.7" fill="none"/>' +
        '<line x1="10.4" y1="15.5" x2="10.4" y2="17.5" stroke="#000" stroke-width="0.25"/>' +
        '<line x1="11.2" y1="15.5" x2="11.2" y2="17.5" stroke="#000" stroke-width="0.25"/>' +
        '<line x1="12" y1="15.5" x2="12" y2="17.5" stroke="#000" stroke-width="0.25"/>' +
        '<line x1="12.8" y1="15.5" x2="12.8" y2="17.5" stroke="#000" stroke-width="0.25"/>' +
        '<line x1="13.6" y1="15.5" x2="13.6" y2="17.5" stroke="#000" stroke-width="0.25"/>' +
        '</svg>';

    const GMEBOT_ICON_TITLE_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-linejoin="round" class="gme-bot-title-icon">' +
        '<defs><linearGradient id="metallicGreyTitle" x1="0%" y1="0%" x2="100%" y2="100%">' +
        '<stop offset="0%" stop-color="#d8dce0"/><stop offset="50%" stop-color="#b8bcc0"/><stop offset="100%" stop-color="#989ca0"/>' +
        '</linearGradient>' +
        '<filter id="faceShadowTitle" x="-15%" y="-15%" width="130%" height="130%">' +
        '<feDropShadow dx="0.25" dy="0.4" stdDeviation="0.35" flood-color="#000" flood-opacity="0.4"/>' +
        '</filter></defs>' +
        '<path d="M12 2 L20 5 L20 17.5 L12 22 L4 17.5 L4 5 Z" fill="url(#metallicGreyTitle)" stroke="url(#metallicGreyTitle)" stroke-width="1.4" filter="url(#faceShadowTitle)"/>' +
        '<path d="M8 5.2 L11 7 L11 10.8 L8 12.6 L5 10.8 L5 7 Z" stroke="#337ab7" stroke-width="1.2"/>' +
        '<circle cx="8" cy="8.9" r="1.5" fill="#000"/>' +
        '<rect x="6.5" y="8.6" width="3" height="0.6" fill="url(#metallicGreyTitle)"/>' +
        '<circle cx="8" cy="8.9" r="1.5" fill="none" stroke="#000" stroke-width="0.2"/>' +
        '<path d="M16 5.2 L19 7 L19 10.8 L16 12.6 L13 10.8 L13 7 Z" stroke="#5cb85c" stroke-width="1.2"/>' +
        '<circle cx="16" cy="8.9" r="1.5" fill="#000"/>' +
        '<rect x="14.5" y="8.6" width="3" height="0.6" fill="url(#metallicGreyTitle)"/>' +
        '<circle cx="16" cy="8.9" r="1.5" fill="none" stroke="#000" stroke-width="0.2"/>' +
        '<path d="M12 12.8 L15 14.6 L15 18.4 L12 20.2 L9 18.4 L9 14.6 Z" stroke="#d9534f" stroke-width="1.2"/>' +
        '<rect x="10.2" y="15.5" width="3.6" height="2" stroke="#000" stroke-width="0.7" fill="none"/>' +
        '<line x1="10.4" y1="15.5" x2="10.4" y2="17.5" stroke="#000" stroke-width="0.25"/>' +
        '<line x1="11.2" y1="15.5" x2="11.2" y2="17.5" stroke="#000" stroke-width="0.25"/>' +
        '<line x1="12" y1="15.5" x2="12" y2="17.5" stroke="#000" stroke-width="0.25"/>' +
        '<line x1="12.8" y1="15.5" x2="12.8" y2="17.5" stroke="#000" stroke-width="0.25"/>' +
        '<line x1="13.6" y1="15.5" x2="13.6" y2="17.5" stroke="#000" stroke-width="0.25"/>' +
        '</svg>';

    const STYLES = `
        .gme-bot-btn-icon {
            width: 16px;
            height: 16px;
            display: inline-block;
            vertical-align: middle;
        }
        .gme-bot-title-icon {
            width: 30px;
            height: 30px;
            display: inline-block;
            vertical-align: middle;
            margin-right: 8px;
        }
        .gme-bot-widget {
            display: inline-block;
            position: relative;
        }
        .gme-bot-dialog {
            position: fixed;
            width: 50vw;
            min-height: 260px;
            height: 34vh;
            background: #fff;
            border: 1px solid #ccc;
            border-radius: 6px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.18);
            z-index: 100000;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .gme-bot-title {
            padding: 8px 12px;
            font-weight: 600;
            font-size: 13px;
            background: #337ab7;
            color: #fff;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .gme-bot-title-buttons {
            display: flex;
            gap: 6px;
        }
        .gme-bot-title-btn {
            background: none;
            border: none;
            color: #fff;
            font-size: 16px;
            line-height: 1;
            cursor: pointer;
            opacity: 0.7;
            padding: 0 2px;
        }
        .gme-bot-title-btn:hover {
            opacity: 1;
        }
        .gme-bot-messages {
            flex: 1;
            overflow-y: auto;
            padding: 8px 12px;
            font-size: 12px;
            user-select: text !important;
            -webkit-user-select: text !important;
            -moz-user-select: text !important;
            cursor: text;
        }
        .gme-bot-messages * {
            user-select: text !important;
            -webkit-user-select: text !important;
            -moz-user-select: text !important;
        }
        .gme-bot-message {
            margin-bottom: 6px;
            line-height: 1.5;
            word-break: break-word;
        }
        .gme-bot-message.gme-bot-user {
            color: #999;
        }
        .gme-bot-message.gme-bot-bot {
            color: #333;
        }
        .gme-bot-message code {
            background: #f0f0f0;
            padding: 1px 4px;
            border-radius: 3px;
            font-size: 11px;
        }
        .gme-bot-message pre {
            background: #f5f5f5;
            padding: 6px 8px;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 11px;
            margin: 4px 0;
        }
        .gme-bot-message pre code {
            background: none;
            padding: 0;
        }
        .gme-bot-message ul, .gme-bot-message ol {
            margin: 2px 0;
            padding-left: 20px;
        }
        .gme-bot-context-bar {
            flex-shrink: 0;
            border-top: 1px solid #eee;
            background: #f9f9f9;
            padding: 6px 8px;
            font-size: 11px;
            color: #444;
        }
        .gme-bot-context-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px 12px;
            margin-bottom: 4px;
        }
        .gme-bot-context-row:last-child {
            margin-bottom: 0;
        }
        .gme-bot-context-label {
            font-weight: 600;
            color: #555;
            margin-right: 4px;
        }
        .gme-bot-scope-group {
            display: inline-flex;
            border-radius: 3px;
            overflow: hidden;
            border: 1px solid #ccc;
        }
        .gme-bot-scope-group .btn {
            border-radius: 0;
            border: none;
            border-right: 1px solid #ccc;
            padding: 2px 8px;
            font-size: 11px;
        }
        .gme-bot-scope-group .btn:last-child {
            border-right: none;
        }
        .gme-bot-scope-group .btn.active {
            background: #337ab7;
            color: #fff;
        }
        .gme-bot-domain-chips {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
        }
        .gme-bot-domain-chip {
            font-weight: normal;
            margin: 0;
            cursor: pointer;
            white-space: nowrap;
        }
        .gme-bot-domain-chip input {
            margin: 0 4px 0 0;
            vertical-align: middle;
        }
        .gme-bot-input-row {
            display: flex;
            padding: 6px 8px;
            border-top: 1px solid #eee;
            background: #fafafa;
            flex-shrink: 0;
        }
        .gme-bot-input-row input {
            flex: 1;
            margin-right: 4px;
        }
    `;

    function escapeHtml(str: string): string {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    type ToolActivityItem = { name: string; argsSummary?: string };

    /** Turn /cback/chat JSON into user-visible text (tool calls in italics via markdown *…*). */
    function formatChatResponse(data: any): string {
        if (!data || typeof data !== "object") {
            return "(no response)";
        }
        const parts: string[] = [];
        const activity: ToolActivityItem[] = Array.isArray(data.toolActivity) ? data.toolActivity : [];
        for (const t of activity) {
            if (!t || typeof t.name !== "string") continue;
            const args = t.argsSummary ? " (" + t.argsSummary + ")" : "";
            parts.push("*" + t.name + args + "*");
        }
        const reply = typeof data.reply === "string" ? data.reply.trim() : "";
        const status = typeof data.status === "string" ? data.status : "";

        if (reply) {
            if (parts.length > 0) {
                parts.push("");
            }
            parts.push(data.reply.trim());
            return parts.join("\n");
        }
        if (status === "complete" || data.complete === true) {
            if (parts.length > 0) {
                parts.push("");
            }
            parts.push("*Response complete.*");
            return parts.join("\n");
        }
        if (status === "continuation") {
            return parts.length > 0 ? parts.join("\n") : "";
        }
        if (status === "empty" || status === "error") {
            if (typeof data.reply === "string" && data.reply.trim() !== "") {
                const errParts = parts.length > 0 ? parts.concat([""], [data.reply.trim()]) : [data.reply.trim()];
                return errParts.join("\n");
            }
            return parts.length > 0
                ? parts.join("\n") + "\n\nThe model returned no text. Try rephrasing your request."
                : "The model returned no text. Try rephrasing your request.";
        }
        if (parts.length > 0) {
            parts.push("");
            parts.push("*Response complete.*");
            return parts.join("\n");
        }
        return "(no response)";
    }

    function renderMarkdown(text: string): string {
        let html = escapeHtml(text);

        // Code blocks: ```...```
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g,
            (_m: string, _lang: string, code: string) =>
                "<pre><code>" + code.trim() + "</code></pre>");

        // Inline code: `...`
        html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

        // Bold: **...**
        html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

        // Italic: *...*
        html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

        // Unordered list items: lines starting with - or *
        html = html.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
        html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

        // Ordered list items: lines starting with 1. 2. etc.
        html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
        html = html.replace(/((?:<li>.*<\/li>\n?)+)/g,
            (match: string) => match.includes("<ul>") ? match : "<ol>" + match + "</ol>");

        // Line breaks (outside of pre blocks)
        html = html.replace(/\n/g, "<br>");

        // Clean up <br> inside <ul>/<ol>
        html = html.replace(/<br><li>/g, "<li>");
        html = html.replace(/<\/li><br>/g, "</li>");
        html = html.replace(/<br><\/ul>/g, "</ul>");
        html = html.replace(/<br><\/ol>/g, "</ol>");
        html = html.replace(/<ul><br>/g, "<ul>");
        html = html.replace(/<ol><br>/g, "<ol>");

        return html;
    }

    class Widget {
        private _client: any;
        private _el: any;
        private _isOpen: boolean;

        private _root: any;
        private _toggle: any;
        private _dialog: any;
        private _messagesEl: any;
        private _input: any;
        private _send: any;
        private _styleTag: any;
        private _onDocClick: ((e: any) => void) | null;
        private _modelingMode: ModelingMode;
        private _objectList: ObjectList;
        private _modeBtnMeta: any;
        private _modeBtnDomain: any;

        constructor(containerEl: any, client: any) {
            this._client = client;
            this._el = containerEl;
            this._isOpen = false;
            this._onDocClick = null;
            this._modelingMode = "metamodel";
            this._objectList = { existing: [], new: [], deleted: [] };
            this._injectStyles();
            this._render();
        }

        private _injectStyles(): void {
            if ($("#gme-bot-styles").length === 0) {
                this._styleTag = $('<style id="gme-bot-styles"></style>').text(STYLES);
                $("head").append(this._styleTag);
            }
        }

        private _render(): void {
            this._root = $('<div class="btn-group"></div>');
            this._toggle = $('<button class="btn btn-micro btn-warning gme-bot-toggle-btn" title="GMEBot">' +
                GMEBOT_ICON_SVG + '</button>');

            this._dialog = $('<div class="gme-bot-dialog"></div>').hide();
            this._messagesEl = $('<div class="gme-bot-messages"></div>');
            this._input = $(
                '<input type="text" class="form-control input-sm" placeholder="Type a message...">'
            );
            this._send = $('<button class="btn btn-xs btn-success">Send</button>');

            const titleBar = $('<div class="gme-bot-title"></div>');
            titleBar.append(GMEBOT_ICON_TITLE_SVG).append('<span>GMEBot</span>');
            const titleButtons = $('<div class="gme-bot-title-buttons"></div>');
            const hideBtn = $('<button class="gme-bot-title-btn" title="Hide">&minus;</button>');
            hideBtn.on("click", () => { this._close(); });
            const endBtn = $('<button class="gme-bot-title-btn" title="End session">&times;</button>');
            endBtn.on("click", () => { this._endSession(); });
            titleButtons.append(hideBtn).append(endBtn);
            titleBar.append(titleButtons);

            this._dialog.append(titleBar);
            this._dialog.append(this._messagesEl);

            const contextBar = $('<div class="gme-bot-context-bar"></div>');
            const scopeRow = $('<div class="gme-bot-context-row"></div>');
            scopeRow.append('<span class="gme-bot-context-label">Mode</span>');
            const scopeGroup = $('<div class="gme-bot-scope-group" role="group"></div>');
            this._modeBtnMeta = $(
                '<button type="button" class="btn btn-default btn-xs gme-bot-scope-btn" data-mode="metamodel">Metamodel</button>'
            );
            this._modeBtnDomain = $(
                '<button type="button" class="btn btn-default btn-xs gme-bot-scope-btn" data-mode="domain">Domain model</button>'
            );
            scopeGroup.append(this._modeBtnMeta).append(this._modeBtnDomain);
            scopeRow.append(scopeGroup);
            contextBar.append(scopeRow);

            const syncModeUi = () => {
                this._modeBtnMeta.toggleClass("active", this._modelingMode === "metamodel");
                this._modeBtnDomain.toggleClass("active", this._modelingMode === "domain");
            };
            syncModeUi();
            scopeGroup.on("click", ".gme-bot-scope-btn", (ev: any) => {
                const t = $(ev.target).closest(".gme-bot-scope-btn");
                const m = t.attr("data-mode") as ModelingMode | undefined;
                if (m === "metamodel" || m === "domain") {
                    this._modelingMode = m;
                    syncModeUi();
                }
            });

            this._dialog.append(contextBar);
            this._dialog.append(
                $('<div class="gme-bot-input-row"></div>')
                    .append(this._input)
                    .append(this._send)
            );

            this._root.append(this._toggle);
            this._el.append(this._root);

            $("body").append(this._dialog);

            this._toggle.on("click", (e: any) => {
                e.stopPropagation();
                this._isOpen ? this._close() : this._open();
            });

            this._send.on("click", () => {
                this._handleSend();
            });

            this._input.on("keydown", (e: any) => {
                if (e.key === "Enter") {
                    this._handleSend();
                }
                if (e.key === "Escape") {
                    this._close();
                }
            });
        }

        private _open(): void {
            this._isOpen = true;
            this._positionDialog();
            this._dialog.show();
            this._input.trigger("focus");

            this._onDocClick = (e: any) => {
                if (!$(e.target).closest(".gme-bot-dialog").length &&
                    !this._root[0].contains(e.target)) {
                    this._close();
                }
            };
            $(document).on("mousedown", this._onDocClick);
        }

        private _close(): void {
            this._isOpen = false;
            this._dialog.hide();
            if (this._onDocClick) {
                $(document).off("mousedown", this._onDocClick);
                this._onDocClick = null;
            }
        }

        private _positionDialog(): void {
            const btnOffset = this._toggle.offset();
            const btnWidth = this._toggle.outerWidth();
            if (!btnOffset) {
                return;
            }

            const winW = $(window).width();
            const dialogW = winW * 0.5;
            const dialogH = $(window).height() * 0.34;

            let left = btnOffset.left + btnWidth / 2 - dialogW / 2;
            const top = btnOffset.top - dialogH - 8;

            const maxLeft = winW - dialogW - 8;
            if (left < 8) { left = 8; }
            if (left > maxLeft) { left = maxLeft; }

            this._dialog.css({ top: Math.max(top, 8), left: left });
        }

        /** Build context from the WebGME client for this request. */
        private _getContext(): ChatContext | undefined {
            const client = this._client;
            if (!client) return undefined;

            const projectId =
                typeof client.getActiveProjectId === "function" ? client.getActiveProjectId() : undefined;
            const branchName =
                typeof client.getActiveBranchName === "function" ? client.getActiveBranchName() : undefined;
            const g = (typeof window !== "undefined" && (window as any).WebGMEGlobal) || undefined;
            const activeNodeId =
                g?.State && typeof g.State.getActiveObject === "function"
                    ? g.State.getActiveObject()
                    : undefined;
            const activeVisualizerId =
                g?.State && typeof g.State.getActiveVisualizer === "function"
                    ? g.State.getActiveVisualizer()
                    : undefined;
            const activeTabId =
                g?.State && typeof g.State.getActiveTab === "function"
                    ? g.State.getActiveTab()
                    : undefined;

            const viz = activeVisualizerId != null ? String(activeVisualizerId) : undefined;
            let modelingMode = this._modelingMode;
            if (viz === "METAAspect") {
                modelingMode = "metamodel";
            }

            return {
                projectId: projectId != null ? String(projectId) : undefined,
                branchName: branchName != null ? String(branchName) : undefined,
                activeNodeId: activeNodeId != null ? String(activeNodeId) : undefined,
                activeVisualizerId: viz,
                activeTabId: typeof activeTabId === "number" ? activeTabId : undefined,
                modelingMode,
                objectList: this._objectList,
            };
        }

        private _handleSend(): void {
            const text = (this._input.val() || "").trim();
            if (!text) {
                return;
            }
            this._appendMessage("You", text);
            this._input.val("");
            this._setInputEnabled(false);

            const context = this._getContext();
            const payload: { message: string; context?: ChatContext; continuation?: boolean } = { message: text };
            if (context) {
                payload.context = context;
            }

            if (typeof console !== "undefined" && console.log) {
                console.log("[GMEBot] sending payload:", JSON.stringify(payload, null, 2));
            }

            this._postChat(payload, (data: any) => {
                this._appendMessage("GMEBot", formatChatResponse(data));
                if (data.commands) {
                    this._executeCommands(data.commands);
                }
                this._input.trigger("focus");
            });
        }

        /**
         * Send a chat request; if the backend returns continuation + requestClientData, gather layout and send a follow-up, then call onComplete with the final response.
         */
        private _postChat(
            payload: { message: string; context?: ChatContext; continuation?: boolean },
            onComplete: (data: any) => void
        ): void {
            $.ajax({
                type: "POST",
                url: "/cback/chat",
                contentType: "application/json",
                data: JSON.stringify(payload),
                success: (data: any) => {
                    if (data.continuation === true && data.requestClientData && typeof data.requestClientData.key === "string") {
                        const key = data.requestClientData.key as string;
                        const baseContext = this._getContext() || {};
                        const nextContext: ChatContext = { ...baseContext };
                        if (key === "diagramLayout") {
                            nextContext.diagramLayout = getDiagramLayoutFromClient();
                        }
                        this._postChat(
                            { message: CONTINUATION_MESSAGE, context: nextContext, continuation: true },
                            onComplete
                        );
                        return;
                    }
                    onComplete(data);
                    this._setInputEnabled(true);
                },
                error: (xhr: any) => {
                    let msg = "Connection error";
                    try {
                        const body = JSON.parse(xhr.responseText);
                        if (body.error) { msg = body.error; }
                    } catch (_e) { /* use default */ }
                    this._appendMessage("GMEBot", "[Error] " + msg);
                    this._setInputEnabled(true);
                },
                complete: () => { /* input re-enabled in success or error */ },
            });
        }

        private _setInputEnabled(enabled: boolean): void {
            this._input.prop("disabled", !enabled);
            this._send.prop("disabled", !enabled);
        }

        private _executeCommands(commands: Array<{ type: string; args: any }>): void {
            const log = (sender: string, text: string) =>
                this._appendMessage(sender, text);
            Commands.executeCommands(commands, this._client, log);
        }

        private _endSession(): void {
            $.ajax({
                type: "DELETE",
                url: "/cback/session",
                complete: () => {
                    this._messagesEl.empty();
                    this._close();
                },
            });
        }

        private _appendMessage(sender: string, text: string): void {
            const cls = sender === "You" ? "gme-bot-user" : "gme-bot-bot";
            const row = $('<div class="gme-bot-message ' + cls + '"></div>');

            if (sender === "You") {
                row.text(sender + ": " + text);
            } else {
                row.html("<strong>" + escapeHtml(sender) + ":</strong> " + renderMarkdown(text));
            }

            this._messagesEl.append(row);
            this._messagesEl.scrollTop(this._messagesEl[0].scrollHeight);
        }

        destroy(): void {
            this._close();
            this._dialog.remove();
            this._root.remove();
            if (this._styleTag) {
                this._styleTag.remove();
            }
        }
    }

    return Widget;
});
