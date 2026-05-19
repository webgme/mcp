/**
 * MetaDescriptor (compact metamodel document) ↔ WebGME core.
 * See docs/schemas/meta-descriptor.schema.json
 */

export type MetaDescriptor = {
    version: 1;
    concepts: MetaConcept[];
    relationships?: Array<MetaRelationshipLine | MetaRelationshipObject>;
};

export type MetaConcept = {
    name: string;
    extends: string;
    contains?: string[];
    pointers?: Record<string, string | string[]>;
    sets?: Record<string, string | string[]>;
    attributes?: Record<string, unknown>;
};

export type MetaRelationshipObject = {
    name: string;
    from: string | string[];
    to: string | string[];
};

export type MetaRelationshipLine = string;

export type ObjectListItem = {
    name: string;
    path: string;
    guid: string;
};

export type ObjectList = {
    existing: ObjectListItem[];
    new: ObjectListItem[];
    deleted: ObjectListItem[];
};

type JsonPatchOp = {
    op: "add" | "remove" | "replace" | "move" | "copy" | "test";
    path: string;
    value?: unknown;
    from?: string;
};

function decodePointerSegment(seg: string): string {
    return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parsePointer(path: string): string[] {
    if (!path || path === "/") return [];
    const raw = path.startsWith("/") ? path.slice(1) : path;
    if (!raw) return [];
    return raw.split("/").map(decodePointerSegment);
}

function getAtPointer(root: unknown, path: string): unknown {
    const parts = parsePointer(path);
    let cur: any = root;
    for (const p of parts) {
        if (cur == null) return undefined;
        if (Array.isArray(cur)) {
            const idx = p === "-" ? cur.length : Number(p);
            cur = cur[idx];
        } else {
            cur = cur[p];
        }
    }
    return cur;
}

function setAtPointer(root: any, path: string, value: unknown): void {
    const parts = parsePointer(path);
    if (parts.length === 0) {
        throw new Error("Cannot replace document root");
    }
    let cur: any = root;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur[p] === undefined) {
            const next = parts[i + 1];
            cur[p] = next !== undefined && String(Number(next)) === next ? [] : {};
        }
        cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (Array.isArray(cur) && last === "-") {
        cur.push(value);
        return;
    }
    if (Array.isArray(cur)) {
        cur[Number(last)] = value;
        return;
    }
    cur[last] = value;
}

function removeAtPointer(root: any, path: string): void {
    const parts = parsePointer(path);
    if (parts.length === 0) throw new Error("Cannot remove document root");
    let cur: any = root;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = cur[parts[i]];
        if (cur == null) return;
    }
    const last = parts[parts.length - 1];
    if (Array.isArray(cur)) {
        cur.splice(Number(last), 1);
        return;
    }
    delete cur[last];
}

/** RFC 6902 subset used by GMEBot meta patch (add, remove, replace). */
export function applyJsonPatch<T>(document: T, patch: JsonPatchOp[]): T {
    const doc = JSON.parse(JSON.stringify(document)) as T;
    for (const op of patch) {
        if (!op || typeof op.path !== "string") {
            throw new Error("Invalid patch operation: missing path");
        }
        switch (op.op) {
            case "add":
            case "replace":
                if (op.op === "replace" && getAtPointer(doc, op.path) === undefined) {
                    throw new Error("replace target missing at " + op.path);
                }
                setAtPointer(doc as any, op.path, op.value);
                break;
            case "remove":
                removeAtPointer(doc as any, op.path);
                break;
            case "test": {
                const cur = getAtPointer(doc, op.path);
                if (JSON.stringify(cur) !== JSON.stringify(op.value)) {
                    throw new Error("test failed at " + op.path);
                }
                break;
            }
            default:
                throw new Error("Unsupported patch op: " + op.op);
        }
    }
    return doc;
}

function metaChildrenToContains(children: any): string[] | undefined {
    if (!children || !Array.isArray(children.items)) return undefined;
    const out: string[] = [];
    for (const item of children.items) {
        const name = item?.name ?? item?.id;
        if (!name) continue;
        let suffix = "";
        const min = typeof item.min === "number" ? item.min : undefined;
        const max = typeof item.max === "number" ? item.max : undefined;
        if (min === 0 && max === 1) suffix = ":0..1";
        else if (min === 1 && max === 1) suffix = ":1";
        else if (max === -1 || max === undefined) suffix = max === -1 ? "*" : suffix;
        else if (max > 1) suffix = "*";
        out.push(String(name) + suffix);
    }
    return out.length ? out : undefined;
}

function metaPointersToRecord(pointers: any): Record<string, string | string[]> | undefined {
    if (!pointers || typeof pointers !== "object") return undefined;
    const out: Record<string, string | string[]> = {};
    for (const key of Object.keys(pointers)) {
        if (key === "src" || key === "dst") continue;
        const p = pointers[key];
        const items = p?.items;
        if (!Array.isArray(items)) continue;
        const names = items.map((it: any) => it?.name ?? it?.id).filter(Boolean);
        if (names.length === 1) out[key] = names[0];
        else if (names.length > 1) out[key] = names;
    }
    return Object.keys(out).length ? out : undefined;
}

function baseConceptName(core: any, node: any, root: any): string {
    if (typeof core.getBase === "function") {
        const base = core.getBase(node);
        if (base && core.getPath(base) !== core.getPath(root)) {
            const n = core.getAttribute(base, "name");
            if (n != null && String(n).trim()) return String(n).trim();
        }
    }
    return "FCO";
}

/** Build compact MetaDescriptor v1 from WebGME core (open project). */
export function buildMetaDescriptorFromCore(core: any, root: any): MetaDescriptor {
    const metaDict = core.getAllMetaNodes(root) || {};
    const concepts: MetaConcept[] = [];
    const relationships: MetaRelationshipLine[] = [];

    for (const path of Object.keys(metaDict).sort()) {
        const node = metaDict[path];
        if (!node) continue;
        const name = String(core.getAttribute(node, "name") ?? "").trim();
        if (!name) continue;
        let meta: any = {};
        try {
            meta = core.getJsonMeta(node) || {};
        } catch {
            meta = {};
        }
        const concept: MetaConcept = {
            name,
            extends: baseConceptName(core, node, root),
        };
        const contains = metaChildrenToContains(meta.children);
        if (contains) concept.contains = contains;
        const pointers = metaPointersToRecord(meta.pointers);
        if (pointers) concept.pointers = pointers;
        if (meta.attributes && typeof meta.attributes === "object") {
            const attrs: Record<string, unknown> = {};
            for (const k of Object.keys(meta.attributes)) {
                const a = meta.attributes[k];
                if (a && typeof a === "object" && a.type) {
                    attrs[k] = a.type === "string" && !a.multiline ? "string" : a;
                }
            }
            if (Object.keys(attrs).length) concept.attributes = attrs;
        }
        const ptr = meta.pointers;
        if (ptr && (ptr.src || ptr.dst)) {
            const fromItems = ptr.src?.items ?? [];
            const toItems = ptr.dst?.items ?? [];
            const fromNames = fromItems.map((it: any) => it?.name ?? it?.id).filter(Boolean);
            const toNames = toItems.map((it: any) => it?.name ?? it?.id).filter(Boolean);
            if (fromNames.length && toNames.length) {
                relationships.push(
                    name +
                        ": " +
                        (fromNames.length === 1 ? fromNames[0] : fromNames.join("|")) +
                        " -> " +
                        (toNames.length === 1 ? toNames[0] : toNames.join("|"))
                );
            }
        }
        concepts.push(concept);
    }

    const descriptor: MetaDescriptor = { version: 1, concepts };
    if (relationships.length) descriptor.relationships = relationships;
    return descriptor;
}

export function buildObjectListFromCore(
    core: any,
    root: any,
    clientList?: Partial<ObjectList>
): ObjectList {
    const metaDict = core.getAllMetaNodes(root) || {};
    const existing: ObjectListItem[] = [];
    for (const path of Object.keys(metaDict).sort()) {
        const node = metaDict[path];
        if (!node) continue;
        const name = String(core.getAttribute(node, "name") ?? "").trim();
        if (!name) continue;
        const guid =
            typeof core.getGuid === "function"
                ? String(core.getGuid(node))
                : path;
        existing.push({ name, path, guid });
    }
    return {
        existing,
        new: Array.isArray(clientList?.new) ? clientList!.new : [],
        deleted: Array.isArray(clientList?.deleted) ? clientList!.deleted : [],
    };
}

export type SyncPatchResult = {
    metaDescriptor: MetaDescriptor;
    applied: string[];
    warnings: string[];
};

/**
 * Apply patch to descriptor and sync supported changes to WebGME (new concepts for now).
 */
export async function syncMetaDescriptorPatch(
    core: any,
    root: any,
    before: MetaDescriptor,
    patch: JsonPatchOp[],
    commit: (message: string) => Promise<void>
): Promise<SyncPatchResult> {
    const after = applyJsonPatch(before, patch);
    const applied: string[] = [];
    const warnings: string[] = [];

    const beforeNames = new Set(before.concepts.map((c) => c.name));
    const afterNames = new Set(after.concepts.map((c) => c.name));

    for (const concept of after.concepts) {
        if (beforeNames.has(concept.name)) continue;
        const baseName = concept.extends || "FCO";
        let baseNode: any =
            typeof core.getFCO === "function" ? core.getFCO(root) : null;
        if (baseName !== "FCO") {
            const metaDict = core.getAllMetaNodes(root) || {};
            for (const p of Object.keys(metaDict)) {
                const n = metaDict[p];
                if (n && String(core.getAttribute(n, "name")).trim() === baseName) {
                    baseNode = n;
                    break;
                }
            }
        }
        if (!baseNode) {
            warnings.push("Could not resolve base for new concept " + concept.name);
            continue;
        }
        const created = core.createNode({ parent: root, base: baseNode });
        if (created && typeof created.message === "string") {
            warnings.push("createNode failed for " + concept.name + ": " + created.message);
            continue;
        }
        core.setAttribute(created, "name", concept.name);
        core.addMember(root, "MetaAspectSet", created);
        applied.push("created concept " + concept.name);
    }

    const removed = [...beforeNames].filter((n) => !afterNames.has(n));
    if (removed.length) {
        warnings.push(
            "Removing concepts via patch is not applied yet: " + removed.join(", ")
        );
    }

    if (applied.length) {
        await commit("GMEBot: patchMetaDescriptor");
    }

    return { metaDescriptor: after, applied, warnings };
}
