/**
 * MetaDescriptor (compact metamodel document) ↔ WebGME core.
 * See docs/schemas/meta-descriptor.schema.json
 */

import {
    createMetaConceptInCore,
    applyRelationshipPointersInCore,
    applyContainmentInCore,
    findMetaConceptByName,
    parseTargetRef,
    formatContainmentRef,
    META_ASPECT_SET_NAME,
} from "./metaCoreOps";

export type Cardinality = "*" | "+" | "?" | "1" | "0..1" | string;

export type MetaConceptBody = {
    extends?: string;
    contains?: Record<string, Cardinality>;
    pointers?: Record<string, string | string[]>;
    sets?: Record<string, Cardinality | Record<string, Cardinality>>;
    attributes?: Record<string, unknown>;
};

export type MetaRelationshipBody = {
    from: string | string[];
    to: string | string[];
};

export type MetaDescriptor = {
    version: 1;
    concepts: Record<string, MetaConceptBody>;
    relationships?: Record<string, MetaRelationshipBody>;
};

/** Runtime concept with resolved name (map key or legacy name field). */
export type MetaConcept = MetaConceptBody & { name: string };

export const FCO_CONCEPT_NAME = "FCO";

/** Attribute meta inherited from FCO — do not redefine on domain concepts. */
export const FCO_INHERITED_ATTRIBUTES = ["name"] as const;

const CONCEPT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export function stripInheritedAttributes(
    attrs: Record<string, unknown> | undefined
): { attributes?: Record<string, unknown>; stripped: string[] } {
    if (!attrs || typeof attrs !== "object") return { stripped: [] };
    const stripped: string[] = [];
    const out: Record<string, unknown> = { ...attrs };
    for (const key of FCO_INHERITED_ATTRIBUTES) {
        if (Object.prototype.hasOwnProperty.call(out, key)) {
            stripped.push(key);
            delete out[key];
        }
    }
    return {
        attributes: Object.keys(out).length ? out : undefined,
        stripped,
    };
}

function sanitizeConceptBodyAttributes(body: MetaConceptBody): string[] {
    if (!body.attributes) return [];
    const { attributes, stripped } = stripInheritedAttributes(body.attributes);
    if (attributes) body.attributes = attributes;
    else delete body.attributes;
    return stripped;
}

export function isFcoConceptName(name: string): boolean {
    return String(name ?? "").trim().toUpperCase() === FCO_CONCEPT_NAME;
}

export function isValidConceptName(name: string): boolean {
    const s = String(name ?? "").trim();
    if (!s || isFcoConceptName(s)) return false;
    if (s.includes("/")) return false;
    return CONCEPT_NAME_PATTERN.test(s);
}

/** Resolve map key to a valid concept name; reject cardinality-in-name mistakes. */
export function resolveConceptName(key: string): { name: string; warning?: string } {
    const trimmed = String(key ?? "").trim();
    if (isValidConceptName(trimmed)) return { name: trimmed };
    const parsed = parseTargetRef(trimmed);
    if (parsed.name && isValidConceptName(parsed.name) && trimmed !== parsed.name) {
        return {
            name: parsed.name,
            warning:
                'Concept name "' +
                trimmed +
                '" is invalid — cardinality belongs in contains (e.g. contains.State = "*"), not in the concept name.',
        };
    }
    return {
        name: trimmed,
        warning:
            'Invalid concept name "' +
            trimmed +
            '". Use a plain identifier (letters, digits, underscore). No *, :, +, or ? in names.',
    };
}

function cardinalityFromParsed(parsed: { min?: number; max?: number }): Cardinality {
    const { min, max } = parsed;
    if (min === 0 && max === 1) return "0..1";
    if (min === 1 && max === 1) return "1";
    if (max === -1 && min === 0) return "*";
    if (max === -1 && min === 1) return "+";
    if (max === -1) return "*";
    if (typeof min === "number" && typeof max === "number" && min === max) return String(min);
    if (typeof min === "number" && typeof max === "number") return min + ".." + max;
    return "*";
}

function migrateContainsToMap(contains: unknown): Record<string, Cardinality> | undefined {
    if (!contains) return undefined;
    if (contains && typeof contains === "object" && !Array.isArray(contains)) {
        return contains as Record<string, Cardinality>;
    }
    if (!Array.isArray(contains)) return undefined;
    const out: Record<string, Cardinality> = {};
    for (const ref of contains) {
        const parsed = parseTargetRef(String(ref));
        if (parsed.name) out[parsed.name] = cardinalityFromParsed(parsed);
    }
    return Object.keys(out).length ? out : undefined;
}

function migrateConceptBody(body: unknown): MetaConceptBody {
    if (!body || typeof body !== "object") return {};
    const b = { ...(body as MetaConceptBody) };
    delete (b as { name?: string }).name;
    if (b.contains) b.contains = migrateContainsToMap(b.contains);
    sanitizeConceptBodyAttributes(b);
    return b;
}

/** Accept v1 map form or legacy array form; always return map-based descriptor. */
export function normalizeMetaDescriptor(raw: unknown): MetaDescriptor {
    const d = raw as {
        version?: number;
        concepts?: unknown;
        relationships?: unknown;
    };
    if (!d || d.version !== 1) {
        throw new Error("MetaDescriptor version must be 1");
    }

    const concepts: Record<string, MetaConceptBody> = {};
    const warnings: string[] = [];

    if (Array.isArray(d.concepts)) {
        for (const entry of d.concepts as Array<MetaConceptBody & { name?: string }>) {
            const key = entry?.name != null ? String(entry.name) : "";
            const resolved = resolveConceptName(key);
            if (resolved.warning) warnings.push(resolved.warning);
            if (!isValidConceptName(resolved.name)) continue;
            concepts[resolved.name] = migrateConceptBody(entry);
        }
    } else if (d.concepts && typeof d.concepts === "object") {
        for (const [key, body] of Object.entries(d.concepts as Record<string, unknown>)) {
            const resolved = resolveConceptName(key);
            if (resolved.warning) warnings.push(resolved.warning);
            if (!isValidConceptName(resolved.name)) continue;
            concepts[resolved.name] = migrateConceptBody(body);
        }
    }

    const relationships: Record<string, MetaRelationshipBody> = {};
    const rels = d.relationships;
    if (Array.isArray(rels)) {
        for (const rel of rels) {
            if (typeof rel === "string") {
                const m = rel.match(/^([^:]+):\s*(.+?)\s*->\s*(.+)$/);
                if (!m) continue;
                const rname = resolveConceptName(m[1].trim());
                if (!isValidConceptName(rname.name)) continue;
                relationships[rname.name] = { from: m[2].trim(), to: m[3].trim() };
            } else if (rel && typeof rel === "object" && (rel as MetaRelationshipBody & { name?: string }).name) {
                const ro = rel as MetaRelationshipBody & { name: string };
                const rname = resolveConceptName(ro.name);
                if (!isValidConceptName(rname.name)) continue;
                relationships[rname.name] = { from: ro.from, to: ro.to };
            }
        }
    } else if (rels && typeof rels === "object") {
        for (const [key, body] of Object.entries(rels as Record<string, MetaRelationshipBody>)) {
            const rname = resolveConceptName(key);
            if (rname.warning) warnings.push(rname.warning);
            if (!isValidConceptName(rname.name)) continue;
            if (body && typeof body === "object") {
                relationships[rname.name] = { from: body.from, to: body.to };
            }
        }
    }

    for (const conceptName of Object.keys(concepts)) {
        const stripped = sanitizeConceptBodyAttributes(concepts[conceptName]);
        for (const attr of stripped) {
            warnings.push(
                'Removed attributes.' +
                    attr +
                    ' from concept "' +
                    conceptName +
                    '" — inherited from FCO; do not add it in patches.'
            );
        }
    }

    const descriptor: MetaDescriptor = { version: 1, concepts };
    if (Object.keys(relationships).length) descriptor.relationships = relationships;
    if (warnings.length) (descriptor as MetaDescriptor & { _normalizeWarnings?: string[] })._normalizeWarnings = warnings;
    return descriptor;
}

export function listConceptNames(descriptor: MetaDescriptor): string[] {
    return Object.keys(descriptor.concepts || {}).sort();
}

export function getConcept(descriptor: MetaDescriptor, name: string): MetaConcept | undefined {
    const body = descriptor.concepts[name];
    if (!body) return undefined;
    return { name, ...body };
}

export function iterConcepts(descriptor: MetaDescriptor): MetaConcept[] {
    return listConceptNames(descriptor).map((name) => ({ name, ...descriptor.concepts[name] }));
}

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

export type ConceptRegistry = {
    existing: string[];
    new: string[];
    deleted: string[];
};

function namesFromItems(items: ObjectListItem[] | undefined): string[] {
    if (!Array.isArray(items)) return [];
    const out: string[] = [];
    for (const item of items) {
        const name = String(item?.name ?? "").trim();
        if (name && !isFcoConceptName(name)) out.push(name);
    }
    return out;
}

export function buildConceptRegistryFromObjectList(list: ObjectList): ConceptRegistry {
    return {
        existing: namesFromItems(list.existing),
        new: namesFromItems(list.new),
        deleted: namesFromItems(list.deleted),
    };
}

export function buildConceptRegistryFromCore(
    core: any,
    root: any,
    clientList?: Partial<ObjectList>
): ConceptRegistry {
    return buildConceptRegistryFromObjectList(buildObjectListFromCore(core, root, clientList));
}

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

const PATCH_ROOT_KEYS = new Set(["concepts", "relationships", "version"]);

/**
 * Fix common LLM path mistakes before apply (e.g. /StateMachine/contains/State → /concepts/StateMachine/contains/State).
 */
export function normalizeMetaPatchOps(patch: JsonPatchOp[]): { patch: JsonPatchOp[]; rewrites: string[] } {
    const rewrites: string[] = [];
    const out: JsonPatchOp[] = [];

    for (const op of patch) {
        if (!op || typeof op.path !== "string") {
            out.push(op);
            continue;
        }
        let path = op.path;

        const containShorthand = /^\/([^/]+)\/contains\/([^/]+)$/.exec(path);
        if (containShorthand) {
            const head = containShorthand[1];
            if (!PATCH_ROOT_KEYS.has(head)) {
                const fixed = "/concepts/" + head + "/contains/" + containShorthand[2];
                rewrites.push(path + " → " + fixed);
                path = fixed;
            }
        }

        if (
            (op.op === "add" || op.op === "replace") &&
            /^\/[A-Za-z][A-Za-z0-9_]*$/.test(path)
        ) {
            const name = path.slice(1);
            if (!PATCH_ROOT_KEYS.has(name)) {
                const fixed = "/concepts/" + name;
                rewrites.push(path + " → " + fixed);
                path = fixed;
            }
        }

        out.push({ ...op, path });
    }

    return { patch: out, rewrites };
}

/** Turn replace into add when the target path is missing (common after partial applies). */
function coerceReplaceToAdd(document: MetaDescriptor, patch: JsonPatchOp[]): { patch: JsonPatchOp[]; coerced: string[] } {
    const coerced: string[] = [];
    const out = patch.map((op) => {
        if (op.op === "replace" && getAtPointer(document, op.path) === undefined) {
            coerced.push("replace → add at " + op.path);
            return { ...op, op: "add" as const };
        }
        return op;
    });
    return { patch: out, coerced };
}

/** RFC 6902 subset; normalizes to map-based descriptor after apply. */
export function applyJsonPatch(document: MetaDescriptor, patch: JsonPatchOp[]): MetaDescriptor {
    const doc = JSON.parse(JSON.stringify(document)) as MetaDescriptor;
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
    return normalizeMetaDescriptor(doc);
}

function metaChildrenToContains(children: any): Record<string, Cardinality> | undefined {
    if (!children || !Array.isArray(children.items)) return undefined;
    const out: Record<string, Cardinality> = {};
    for (const item of children.items) {
        const name = item?.name ?? item?.id;
        if (!name) continue;
        const min = typeof item.min === "number" ? item.min : undefined;
        const max = typeof item.max === "number" ? item.max : undefined;
        out[String(name)] = cardinalityFromParsed({ min, max });
    }
    return Object.keys(out).length ? out : undefined;
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

export function buildMetaDescriptorFromCore(core: any, root: any): MetaDescriptor {
    const metaDict = core.getAllMetaNodes(root) || {};
    const concepts: Record<string, MetaConceptBody> = {};
    const relationships: Record<string, MetaRelationshipBody> = {};

    for (const path of Object.keys(metaDict).sort()) {
        const node = metaDict[path];
        if (!node) continue;
        const name = String(core.getAttribute(node, "name") ?? "").trim();
        if (!name || isFcoConceptName(name) || !isValidConceptName(name)) continue;
        let meta: any = {};
        try {
            meta = core.getJsonMeta(node) || {};
        } catch {
            meta = {};
        }
        const body: MetaConceptBody = {};
        const baseName = baseConceptName(core, node, root);
        if (!isFcoConceptName(baseName)) body.extends = baseName;
        const contains = metaChildrenToContains(meta.children);
        if (contains) body.contains = contains;
        const pointers = metaPointersToRecord(meta.pointers);
        if (pointers) body.pointers = pointers;
        if (meta.attributes && typeof meta.attributes === "object") {
            const attrs: Record<string, unknown> = {};
            for (const k of Object.keys(meta.attributes)) {
                if ((FCO_INHERITED_ATTRIBUTES as readonly string[]).includes(k)) continue;
                const a = meta.attributes[k];
                if (a && typeof a === "object" && a.type) {
                    attrs[k] = a.type === "string" && !a.multiline ? "string" : a;
                }
            }
            if (Object.keys(attrs).length) body.attributes = attrs;
        }
        const ptr = meta.pointers;
        if (ptr && (ptr.src || ptr.dst)) {
            const fromItems = ptr.src?.items ?? [];
            const toItems = ptr.dst?.items ?? [];
            const fromNames = fromItems.map((it: any) => it?.name ?? it?.id).filter(Boolean);
            const toNames = toItems.map((it: any) => it?.name ?? it?.id).filter(Boolean);
            if (fromNames.length && toNames.length) {
                relationships[name] = {
                    from: fromNames.length === 1 ? fromNames[0] : fromNames,
                    to: toNames.length === 1 ? toNames[0] : toNames,
                };
            }
        }
        concepts[name] = body;
    }

    const descriptor: MetaDescriptor = { version: 1, concepts };
    if (Object.keys(relationships).length) descriptor.relationships = relationships;
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
        if (!name || isFcoConceptName(name)) continue;
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

export type RelationshipSpec = {
    name: string;
    from: string | string[];
    to: string | string[];
};

function relationshipSpecKey(spec: RelationshipSpec): string {
    return spec.name + "|" + JSON.stringify(spec.from) + "|" + JSON.stringify(spec.to);
}

export function collectRelationshipSpecs(descriptor: MetaDescriptor): RelationshipSpec[] {
    const specs: RelationshipSpec[] = [];
    const seen = new Set<string>();
    const push = (spec: RelationshipSpec) => {
        const key = relationshipSpecKey(spec);
        if (seen.has(key)) return;
        seen.add(key);
        specs.push(spec);
    };
    for (const [name, rel] of Object.entries(descriptor.relationships || {})) {
        const rname = resolveConceptName(name);
        if (!isValidConceptName(rname.name)) continue;
        if (rel && typeof rel === "object") push({ name: rname.name, from: rel.from, to: rel.to });
    }
    for (const concept of iterConcepts(descriptor)) {
        const src = concept.pointers?.src;
        const dst = concept.pointers?.dst;
        if (src === undefined && dst === undefined) continue;
        push({
            name: concept.name,
            from: src === undefined ? [] : src,
            to: dst === undefined ? [] : dst,
        });
    }
    return specs;
}

function containsMapDelta(
    before: Record<string, Cardinality> | undefined,
    after: Record<string, Cardinality> | undefined
): { added: Array<{ child: string; cardinality: string }>; removed: string[] } {
    const b = before || {};
    const a = after || {};
    const added: Array<{ child: string; cardinality: string }> = [];
    const removed: string[] = [];
    for (const key of Object.keys(a)) {
        if (!(key in b) || b[key] !== a[key]) {
            added.push({ child: key, cardinality: String(a[key]) });
        }
    }
    for (const key of Object.keys(b)) {
        if (!(key in a)) removed.push(key);
    }
    return { added, removed };
}

/** Concepts that should not be used as the main model container (use a domain name instead). */
export const DISCOURAGED_MAIN_CONTAINER_NAMES = [
    "Diagram",
    "Canvas",
    "Model",
    "Root",
    "ConnectionName",
    "Connector",
    "Link",
    "Edge",
] as const;

/** Placeholder names — use the real link type (e.g. Transition) instead. */
const PLACEHOLDER_CONCEPT_NAMES = new Set(
    ["ConnectionName", "Connector", "Link", "Edge", "Relationship"].map((s) => s.toLowerCase())
);

function listContainerConcepts(descriptor: MetaDescriptor): string[] {
    return listConceptNames(descriptor).filter((n) => {
        const c = descriptor.concepts[n]?.contains;
        return c && Object.keys(c).length > 0;
    });
}

function childToContainers(descriptor: MetaDescriptor): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const container of listContainerConcepts(descriptor)) {
        for (const child of Object.keys(descriptor.concepts[container].contains!)) {
            const list = map.get(child) ?? [];
            list.push(container);
            map.set(child, list);
        }
    }
    return map;
}

/** Structural checks returned as warnings (also guides the LLM via tool response). */
export function auditMetamodelStructure(descriptor: MetaDescriptor): string[] {
    const warnings: string[] = [];
    const conceptNames = listConceptNames(descriptor);
    const relSpecs = collectRelationshipSpecs(descriptor);
    const relNames = new Set(relSpecs.map((s) => s.name));
    const containedIn = childToContainers(descriptor);
    const containers = listContainerConcepts(descriptor);

    for (const spec of relSpecs) {
        if (!descriptor.concepts[spec.name]) {
            warnings.push(
                'relationships.' +
                    spec.name +
                    " requires concepts." +
                    spec.name +
                    ' — add an empty concept: { "' +
                    spec.name +
                    '": {} } (extends FCO by default).'
            );
        }
    }

    for (const relName of relNames) {
        if (!containedIn.has(relName)) {
            const containerHint =
                containers.length === 1
                    ? containers[0]
                    : containers[0] || "StateMachine";
            warnings.push(
                'Connection concept "' +
                    relName +
                    '" must be in the main container contains map (e.g. ' +
                    containerHint +
                    '.contains.' +
                    relName +
                    ' = "*") or it cannot be instantiated.'
            );
        }
    }

    for (const spec of relSpecs) {
        const ends: string[] = [];
        const from = spec.from;
        const to = spec.to;
        if (Array.isArray(from)) ends.push(...from);
        else if (from) ends.push(from);
        if (Array.isArray(to)) ends.push(...to);
        else if (to) ends.push(to);
        for (const end of ends) {
            if (!isValidConceptName(end) || isFcoConceptName(end)) continue;
            if (!descriptor.concepts[end]) {
                warnings.push(
                    'relationships.' +
                        spec.name +
                        ' references "' +
                        end +
                        '" but concepts.' +
                        end +
                        " is missing."
                );
            } else if (!containedIn.has(end)) {
                const containerHint = containers[0] || "StateMachine";
                warnings.push(
                    'Node type "' +
                        end +
                        '" should be in ' +
                        containerHint +
                        ".contains (needed to place instances on the model)."
                );
            }
        }
    }

    if (conceptNames.length >= 2 && containers.length === 0) {
        warnings.push(
            "Add a **main container** concept named for the domain (e.g. StateMachine, Workflow) with a contains map — not a generic name like Diagram."
        );
    }

    for (const name of conceptNames) {
        if ((DISCOURAGED_MAIN_CONTAINER_NAMES as readonly string[]).includes(name)) {
            warnings.push(
                'Avoid concept "' +
                    name +
                    '" — use a domain-specific **main container** name (e.g. StateMachine). It acts as the diagram but should match the model.'
            );
        }
        if (PLACEHOLDER_CONCEPT_NAMES.has(name.toLowerCase()) && !relNames.has(name)) {
            warnings.push(
                'Replace placeholder concept "' +
                    name +
                    '" with the real link type (e.g. Transition) and add relationships.Transition plus contains.Transition on the main container.'
            );
        }
    }

    if (containers.length > 1) {
        warnings.push(
            "Multiple concepts define contains (" +
                containers.join(", ") +
                ") — prefer one main container listing all instantiable types (nodes and connections)."
        );
    }

    return warnings;
}

function hasMainContainer(descriptor: MetaDescriptor): boolean {
    return listContainerConcepts(descriptor).length > 0;
}

export async function syncMetaDescriptorPatch(
    core: any,
    root: any,
    before: MetaDescriptor,
    patch: JsonPatchOp[],
    commit: (message: string) => Promise<void>
): Promise<SyncPatchResult> {
    const beforeNorm = normalizeMetaDescriptor(before);
    const { patch: pathFixed, rewrites } = normalizeMetaPatchOps(patch);
    const { patch: coercedPatch, coerced } = coerceReplaceToAdd(beforeNorm, pathFixed);
    const after = applyJsonPatch(beforeNorm, coercedPatch);
    const applied: string[] = [];
    const warnings: string[] = [];

    if (rewrites.length) {
        warnings.push(
            "Patch paths were corrected server-side (always use /concepts/Name and /concepts/Container/contains/Child): " +
                rewrites.join("; ")
        );
    }
    if (coerced.length) {
        warnings.push("Replace operations coerced to add where missing: " + coerced.join("; "));
    }

    const normExtra = (after as MetaDescriptor & { _normalizeWarnings?: string[] })._normalizeWarnings;
    if (normExtra) warnings.push(...normExtra);

    const beforeNames = new Set(listConceptNames(beforeNorm));
    const afterNames = listConceptNames(after);

    for (const name of afterNames) {
        if (beforeNames.has(name)) continue;
        const concept = getConcept(after, name)!;
        if (!isValidConceptName(name)) {
            warnings.push("skipped invalid concept name: " + name);
            continue;
        }
        const attrStripped = sanitizeConceptBodyAttributes(concept);
        for (const attr of attrStripped) {
            warnings.push(
                'Ignored attributes.' + attr + " on " + name + " (inherited from FCO)"
            );
        }
        try {
            const { path, warnings: w } = await createMetaConceptInCore(core, root, concept);
            warnings.push(...w);
            applied.push("created concept " + name);
        } catch (e: any) {
            warnings.push("create " + name + ": " + ((e && e.message) || String(e)));
        }
    }

    const beforeRelKeys = new Set(
        collectRelationshipSpecs(beforeNorm).map(relationshipSpecKey)
    );
    for (const spec of collectRelationshipSpecs(after)) {
        const key = relationshipSpecKey(spec);
        if (beforeRelKeys.has(key)) continue;
        const w = await applyRelationshipPointersInCore(
            core,
            root,
            spec.name,
            spec.from,
            spec.to
        );
        warnings.push(...w);
        if (w.length === 0) {
            applied.push(
                "relationship " +
                    spec.name +
                    " (" +
                    (Array.isArray(spec.from) ? spec.from.join("|") : spec.from) +
                    " -> " +
                    (Array.isArray(spec.to) ? spec.to.join("|") : spec.to) +
                    ")"
            );
        }
    }

    for (const name of afterNames) {
        const concept = getConcept(after, name)!;
        const prev = beforeNames.has(name)
            ? getConcept(beforeNorm, name)!
            : ({ name, contains: undefined } as MetaConcept);

        const cd = containsMapDelta(prev.contains, concept.contains);
        for (const { child, cardinality } of cd.added) {
            if (!isValidConceptName(child)) {
                warnings.push(
                    "contains: invalid child name '" + child + "' on " + name + " (use contains map keys, not State:*)"
                );
                continue;
            }
            const ref = formatContainmentRef(child, cardinality);
            const w = await applyContainmentInCore(core, root, name, ref);
            warnings.push(...w);
            if (w.length === 0) applied.push("containment " + name + "." + child + " = " + cardinality);
        }
        for (const child of cd.removed) {
            warnings.push("removing containment via patch not implemented: " + name + " -/ " + child);
        }

        const prevPtr = prev.pointers || {};
        const nextPtr = concept.pointers || {};
        const ptrNames = new Set([...Object.keys(prevPtr), ...Object.keys(nextPtr)]);
        for (const pn of ptrNames) {
            if (pn === "src" || pn === "dst") continue;
            const b = prevPtr[pn];
            const a = nextPtr[pn];
            if (JSON.stringify(b) === JSON.stringify(a)) continue;
            if (a === undefined) {
                warnings.push("removing pointer via patch not implemented: " + name + "." + pn);
                continue;
            }
            const targets = Array.isArray(a) ? a : [a];
            for (const t of targets) {
                const found = await findMetaConceptByName(core, root, name);
                if (!found) break;
                const targetNode = await findMetaConceptByName(core, root, String(t));
                if (!targetNode) {
                    warnings.push("pointer " + pn + ": target not found '" + t + "'");
                    continue;
                }
                try {
                    core.setPointerMetaLimits(found.node, pn, 1, 1);
                    core.setPointerMetaTarget(found.node, pn, targetNode.node, 1, 1);
                    applied.push("pointer " + name + "." + pn + " -> " + t);
                } catch (e: any) {
                    warnings.push("pointer " + name + "." + pn + ": " + (e?.message || String(e)));
                }
            }
        }
    }

    for (const name of listConceptNames(beforeNorm)) {
        if (after.concepts[name]) continue;
        const found = await findMetaConceptByName(core, root, name);
        if (!found) {
            warnings.push("remove " + name + ": not found in core");
            continue;
        }
        core.delMember(root, META_ASPECT_SET_NAME, found.path);
        if (typeof core.setMeta === "function") {
            core.setMeta(found.node, {});
        }
        applied.push("removed concept " + name + " from MetaAspectSet");
        warnings.push("removed concept node " + name + " may still exist as instance; full delete not implemented");
    }

    warnings.push(...auditMetamodelStructure(after));

    if (afterNames.length >= 2 && collectRelationshipSpecs(after).length === 0) {
        warnings.push(
            "No relationships — each link type needs concepts.Transition = {} and relationships.Transition = { from, to }."
        );
    }
    if (!hasMainContainer(after) && afterNames.length >= 2) {
        warnings.push(
            "No main container — add concepts.StateMachine with contains listing every node and connection type (e.g. State, Transition)."
        );
    }

    if (applied.length > 0) {
        await commit("GMEBot: patchMetaDescriptor");
    }

    return {
        metaDescriptor: buildMetaDescriptorFromCore(core, root),
        applied,
        warnings,
    };
}
