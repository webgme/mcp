/**
 * Shared WebGME metamodel mutations (no commit). Used by createMetaNode and patchMetaDescriptor sync.
 */
import {
    isFcoConceptName,
    isValidConceptName,
    type Cardinality,
    type MetaConcept,
} from "./metaDescriptor";

export const META_SHEETS_REGISTRY = "MetaSheets";
export const META_ASPECT_SET_NAME = "MetaAspectSet";

/** Normalize a concept name from the MetaDescriptor (names only — not paths or guids). */
export function normalizeMetaConceptName(raw: string): string {
    const s = String(raw ?? "").trim();
    if (!s) return "";
    if (s.startsWith("/")) return "";
    return s;
}

/** Resolve a META concept by name (FCO keyword supported). Paths are not accepted. */
export async function resolveMetaByName(
    core: any,
    root: any,
    conceptName: string
): Promise<string | null> {
    const name = normalizeMetaConceptName(conceptName);
    if (!name) return null;
    if (isFcoConceptName(name) && typeof core.getFCO === "function") {
        const fco = core.getFCO(root);
        if (fco) return core.getPath(fco);
    }
    const metaDict = core.getAllMetaNodes(root) || {};
    for (const path of Object.keys(metaDict)) {
        const node = metaDict[path];
        if (!node) continue;
        const attr = core.getAttribute(node, "name");
        if (attr != null && String(attr).trim() === name) return path;
    }
    return null;
}

export function normalizeConnectionPointerName(raw: string): string {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s === "source" || s === "from" || s === "origin") return "src";
    if (s === "destination" || s === "to" || s === "sink") return "dst";
    if (s === "src" || s === "dst") return s;
    return String(raw ?? "").trim();
}

/** Parse targetRef string (containment / sets) into concept name + optional cardinality. */
export function parseTargetRef(ref: string): { name: string; min?: number; max?: number } {
    let s = String(ref ?? "").trim();
    if (!s) return { name: "" };
    let min: number | undefined;
    let max: number | undefined;
    if (s.endsWith("*")) {
        s = s.slice(0, -1);
        min = 0;
        max = -1;
    } else if (s.endsWith("+")) {
        s = s.slice(0, -1);
        min = 1;
        max = -1;
    } else if (s.endsWith("?")) {
        s = s.slice(0, -1);
        min = 0;
        max = 1;
    } else {
        const colon = s.lastIndexOf(":");
        if (colon > 0) {
            const card = s.slice(colon + 1);
            const base = s.slice(0, colon);
            if (/^\d+$/.test(card)) {
                min = parseInt(card, 10);
                max = min;
                s = base;
            } else if (card.includes("..")) {
                const parts = card.split("..");
                min = parseInt(parts[0], 10);
                max = parseInt(parts[1], 10);
                s = base;
            }
        }
    }
    return { name: s.trim(), min, max };
}

export function formatContainmentRef(childName: string, cardinality: string): string {
    const card = String(cardinality ?? "*").trim();
    if (card === "*" || card === "+" || card === "?") return childName + card;
    if (card === "1") return childName + ":1";
    if (card === "0..1") return childName + ":0..1";
    if (/^\d+$/.test(card)) return childName + ":" + card;
    if (card.includes("..")) return childName + ":" + card;
    return childName + card;
}

async function applyContainsMapAsync(
    core: any,
    root: any,
    node: any,
    containerName: string,
    contains: Record<string, Cardinality> | undefined,
    warnings: MetaCoreOpWarning[]
): Promise<void> {
    if (!contains || typeof contains !== "object") return;
    for (const [childName, cardinality] of Object.entries(contains)) {
        if (!isValidConceptName(childName)) {
            warnings.push(
                "contains: invalid child name '" +
                    childName +
                    "' on " +
                    containerName +
                    " (use plain names; cardinality is the value, e.g. State: \"*\")"
            );
            continue;
        }
        const ref = formatContainmentRef(childName, String(cardinality));
        const { name: targetName, min, max } = parseTargetRef(ref);
        if (!targetName) continue;
        const targetNode = await loadMetaNodeByName(core, root, targetName);
        if (!targetNode) {
            warnings.push("contains: target not found '" + targetName + "'");
            continue;
        }
        const res = core.setChildMeta(node, targetNode, min, max);
        if (res) warnings.push("setChildMeta " + containerName + " -> " + targetName + ": " + (res as any).message);
    }
}

function getSortedMetaSheets(core: any, root: any): any[] {
    const rawSheets = core.getRegistry(root, META_SHEETS_REGISTRY) || [];
    const sheets: any[] = Array.isArray(rawSheets) ? rawSheets.slice() : [];
    sheets.sort((a, b) => {
        const ao = typeof a.order === "number" ? a.order : 0;
        const bo = typeof b.order === "number" ? b.order : 0;
        return ao - bo;
    });
    return sheets;
}

/** Register meta-node on MetaAspectSet and first meta sheet (same as createMetaNode). */
export function registerMetaNodeOnSheets(core: any, root: any, node: any): void {
    core.addMember(root, META_ASPECT_SET_NAME, node);
    const sheets = getSortedMetaSheets(core, root);
    if (sheets.length > 0 && sheets[0]?.SetID) {
        core.addMember(root, sheets[0].SetID, node);
    }
}

async function loadMetaNodeByName(core: any, root: any, conceptName: string): Promise<any | null> {
    const path = await resolveMetaByName(core, root, conceptName);
    if (path == null) return null;
    const rootPath = core.getPath(root);
    return path === rootPath ? root : await core.loadByPath(root, path);
}

async function resolveBaseMetaNode(
    core: any,
    root: any,
    extendsName: string
): Promise<any | null> {
    const baseName = extendsName || "FCO";
    if (baseName === "FCO" && typeof core.getFCO === "function") {
        return core.getFCO(root);
    }
    const path = await resolveMetaByName(core, root, baseName);
    if (path == null) return null;
    const rootPath = core.getPath(root);
    const node = path === rootPath ? root : await core.loadByPath(root, path);
    if (!node) return null;
    if (typeof core.isMetaNode === "function" && !core.isMetaNode(node)) return null;
    return node;
}

export type MetaCoreOpWarning = string;

/** Create META concept node (no commit). Mirrors createMetaNode handler. */
export async function createMetaConceptInCore(
    core: any,
    root: any,
    concept: MetaConcept
): Promise<{ node: any; path: string; warnings: MetaCoreOpWarning[] }> {
    const warnings: MetaCoreOpWarning[] = [];
    const name = String(concept.name ?? "").trim();
    if (!name) throw new Error("Concept name is required");
    if (!isValidConceptName(name)) {
        throw new Error(
            'Invalid concept name "' +
                name +
                '". Names must be plain identifiers; put cardinality in contains (e.g. contains.State = "*").'
        );
    }

    const baseNode = await resolveBaseMetaNode(core, root, concept.extends || "FCO");
    if (!baseNode) {
        throw new Error("Base concept not found: " + (concept.extends || "FCO"));
    }

    const created = core.createNode({ parent: root, base: baseNode });
    if (created && typeof (created as any).message === "string") {
        throw new Error((created as any).message);
    }
    const node = created;
    core.setAttribute(node, "name", name);
    registerMetaNodeOnSheets(core, root, node);

    const path = core.getPath(node);

    // Containment, pointers, sets, and relationships are applied in syncMetaDescriptorPatch
    // after every concept in the patch exists (avoids "target not found" on ordered creates).

    return { node, path, warnings };
}

/** Apply src/dst pointer meta for a connection concept (0..1 each). */
export async function applyRelationshipPointersInCore(
    core: any,
    root: any,
    conceptName: string,
    from: string | string[],
    to: string | string[]
): Promise<MetaCoreOpWarning[]> {
    const warnings: MetaCoreOpWarning[] = [];
    const conceptNode = await loadMetaNodeByName(core, root, conceptName);
    if (!conceptNode) {
        warnings.push("relationship: concept not found '" + conceptName + "'");
        return warnings;
    }

    const applyEnd = async (pointerName: string, end: string | string[]) => {
        const list = Array.isArray(end) ? end : [end];
        for (const ref of list) {
            const targetName = typeof ref === "string" ? ref.trim() : "";
            if (!targetName) continue;
            const targetNode = await loadMetaNodeByName(core, root, targetName);
            if (!targetNode) {
                warnings.push(
                    "relationship " + conceptName + " " + pointerName + ": target not found '" + targetName + "'"
                );
                continue;
            }
            try {
                const pn = normalizeConnectionPointerName(pointerName);
                core.setPointerMetaLimits(conceptNode, pn, 1, 1);
                core.setPointerMetaTarget(conceptNode, pn, targetNode, 1, 1);
            } catch (e: any) {
                warnings.push("relationship " + conceptName + " " + pointerName + ": " + (e?.message || String(e)));
            }
        }
    };

    await applyEnd("src", from);
    await applyEnd("dst", to);
    return warnings;
}

export async function applyContainmentInCore(
    core: any,
    root: any,
    containerName: string,
    targetRef: string
): Promise<MetaCoreOpWarning[]> {
    const warnings: MetaCoreOpWarning[] = [];
    const { name: targetName, min, max } = parseTargetRef(targetRef);
    const sourceNode = await loadMetaNodeByName(core, root, containerName);
                const targetNode = await loadMetaNodeByName(core, root, targetName);
    if (!sourceNode) {
        warnings.push("containment: container not found '" + containerName + "'");
        return warnings;
    }
    if (!targetNode) {
        warnings.push("containment: target not found '" + targetName + "'");
        return warnings;
    }
    const res = core.setChildMeta(sourceNode, targetNode, min, max);
    if (res) warnings.push("setChildMeta: " + (res as any).message);
    return warnings;
}

export async function findMetaConceptByName(
    core: any,
    root: any,
    name: string
): Promise<{ node: any; path: string } | null> {
    const path = await resolveMetaByName(core, root, name);
    if (path == null) return null;
    const rootPath = core.getPath(root);
    const node = path === rootPath ? root : await core.loadByPath(root, path);
    if (!node) return null;
    return { node, path };
}
