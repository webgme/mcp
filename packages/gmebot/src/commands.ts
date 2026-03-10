declare const $: any;

export interface ClientCommand {
    type: string;
    args: Record<string, any>;
}

type Logger = (sender: string, text: string) => void;

export function executeCommands(
    commands: ClientCommand[],
    client: any,
    log: Logger
): void {
    for (const cmd of commands) {
        const handler = HANDLERS[cmd.type];
        if (handler) {
            handler(cmd.args, client, log);
        } else {
            log("GMEBot", "[Unknown command: " + cmd.type + "]");
        }
    }
}

type CommandHandler = (
    args: Record<string, any>,
    client: any,
    log: Logger
) => void;

/** Load a node by path from root; callback(err, node). Use loadByPath for all cases — it handles root and already-loaded nodes. */
function loadNode(
    core: any,
    root: any,
    nodeId: string,
    callback: (err: any, node: any) => void
): void {
    core.loadByPath(root, nodeId, callback);
}

const HANDLERS: Record<string, CommandHandler> = {
    switchProject: cmdSwitchProject,
    createBranch: cmdCreateBranch,
    switchBranch: cmdSwitchProject,
    deleteBranch: cmdDeleteBranch,
    squashBranch: cmdSquashBranch,
    createNode: cmdCreateNode,
    moveNode: cmdMoveNode,
    deleteNode: cmdDeleteNode,
    setAttribute: cmdSetAttribute,
    setProperty: cmdSetProperty,
    getAttribute: cmdGetAttribute,
    clearAttribute: cmdClearAttribute,
    setRegistry: cmdSetRegistry,
    getRegistry: cmdGetRegistry,
    clearRegistry: cmdClearRegistry,
    setClientState: cmdSetClientState,
};

function cmdSwitchProject(
    args: Record<string, any>,
    client: any,
    log: Logger
): void {
    const projectId: string = args.projectId;
    if (!client || !projectId) {
        log("GMEBot", "[switchProject: missing client or projectId]");
        return;
    }

    const branchName: string | null = args.branchName || null;
    const label = projectId + (branchName ? " @ " + branchName : "");

    log("GMEBot", "Switching to " + label + "...");

    client.selectProject(projectId, branchName, function (err: any) {
        if (err) {
            log("GMEBot", "[switchProject failed: " + err.message + "]");
            return;
        }
        log("GMEBot", "Switched to " + label);
    });
}

function cmdCreateBranch(
    args: Record<string, any>,
    client: any,
    log: Logger
): void {
    const projectId: string = args.projectId;
    const branchName: string = args.branchName;
    const fromCommitHash: string = args.fromCommitHash;
    if (!client || !projectId || !branchName || !fromCommitHash) {
        log("GMEBot", "[createBranch: missing client, projectId, branchName, or fromCommitHash]");
        return;
    }
    log("GMEBot", "Creating branch '" + branchName + "' from commit " + fromCommitHash + "...");
    client.createBranch(projectId, branchName, fromCommitHash, function (err: any) {
        if (err) {
            log("GMEBot", "[createBranch failed: " + err.message + "]");
            return;
        }
        log("GMEBot", "Branch '" + branchName + "' created.");
    });
}

function cmdDeleteBranch(
    args: Record<string, any>,
    client: any,
    log: Logger
): void {
    const projectId: string = args.projectId;
    const branchName: string = args.branchName;
    const branchHash: string = args.branchHash;
    if (!client || !projectId || !branchName || !branchHash) {
        log("GMEBot", "[deleteBranch: missing client, projectId, branchName, or branchHash]");
        return;
    }
    log("GMEBot", "Deleting branch '" + branchName + "'...");
    client.deleteBranch(projectId, branchName, branchHash, function (err: any) {
        if (err) {
            log("GMEBot", "[deleteBranch failed: " + err.message + "]");
            return;
        }
        log("GMEBot", "Branch '" + branchName + "' deleted.");
    });
}

function cmdSquashBranch(
    args: Record<string, any>,
    client: any,
    log: Logger
): void {
    const projectId: string = args.projectId;
    const branchName: string = args.branchName;
    const fromCommitId: string = args.fromCommitId;
    const message: string | undefined = args.message;
    if (!client || !projectId || !branchName || !fromCommitId) {
        log("GMEBot", "[squashBranch: missing client, projectId, branchName, or fromCommitId]");
        return;
    }
    log("GMEBot", "Squashing branch '" + branchName + "' from commit " + fromCommitId + "...");
    client.squashCommits(projectId, fromCommitId, branchName, message || null, function (err: any, result: any) {
        if (err) {
            log("GMEBot", "[squashBranch failed: " + err.message + "]");
            return;
        }
        log("GMEBot", "Branch squashed." + (result && result.hash ? " New hash: " + result.hash : ""));
    });
}

function cmdSetClientState(
    args: Record<string, any>,
    _client: any,
    log: Logger
): void {
    const activeNodeId: string | undefined = args.activeNodeId;
    const visualizerId: string | undefined = args.visualizerId;

    if (!activeNodeId && !visualizerId) {
        log("GMEBot", "[setClientState: provide at least activeNodeId or visualizerId]");
        return;
    }

    const g = typeof window !== "undefined" ? (window as any).WebGMEGlobal : undefined;
    if (!g?.State) {
        log("GMEBot", "[setClientState: WebGMEGlobal.State not available]");
        return;
    }

    if (activeNodeId) {
        const nodeId = String(activeNodeId).trim();
        const suppressViz = !!visualizerId;
        g.State.registerActiveObject(nodeId, { suppressVisualizerFromNode: suppressViz });
        log("GMEBot", "Selected node " + nodeId);
    }
    if (visualizerId) {
        const vizId = String(visualizerId).trim();
        g.State.registerActiveVisualizer(vizId);
        log("GMEBot", "Switched visualizer to " + vizId);
    }
}

function cmdCreateNode(args: Record<string, any>, client: any, log: Logger): void {
    const container: string = args.container;
    const baseType: string = args.baseType || "FCO";
    if (!client || !container) {
        log("GMEBot", "[createNode: missing client or container]");
        return;
    }
    client.getCoreInstance({}, function (err: any, result: any) {
        if (err) {
            log("GMEBot", "[createNode: getCoreInstance failed: " + err.message + "]");
            return;
        }
        const core = result.core;
        const root = result.rootNode;
        if (!core || !root) {
            log("GMEBot", "[createNode: no core or root]");
            return;
        }
        loadNode(core, root, container, function (errLoad: any, parentNode: any) {
            if (errLoad) {
                log("GMEBot", "[createNode: load container failed: " + (errLoad && errLoad.message) + "]");
                return;
            }
            if (!parentNode) {
                log("GMEBot", "[createNode: container node not found: " + container + "]");
                return;
            }
            function doCreate(baseNode: any) {
                const created = core.createNode({ parent: parentNode, base: baseNode });
                if (created && !(created as any).message) {
                    core.persist(created);
                    log("GMEBot", "Created node under " + container + " (base: " + baseType + ").");
                } else {
                    log("GMEBot", "[createNode failed: " + (created && (created as any).message ? (created as any).message : "invalid base or parent") + "]");
                }
            }
            if (baseType === "FCO" || !baseType || baseType.indexOf("/") === -1) {
                const rootBase = core.getBase(root);
                const fco = core.getFCO ? core.getFCO(root) : null;
                const baseNode = rootBase || fco || root;
                doCreate(baseNode);
            } else {
                loadNode(core, root, baseType, function (errBase: any, baseNode: any) {
                    if (errBase || !baseNode) {
                        const baseNodeFallback = core.getBase(parentNode) || root;
                        doCreate(baseNodeFallback);
                    } else {
                        doCreate(baseNode);
                    }
                });
            }
        });
    });
}

function cmdMoveNode(args: Record<string, any>, client: any, log: Logger): void {
    const nodeId: string = args.nodeId;
    const newContainer: string = args.newContainer;
    if (!client || !nodeId || !newContainer) {
        log("GMEBot", "[moveNode: missing client, nodeId, or newContainer]");
        return;
    }
    client.getCoreInstance({}, function (err: any, result: any) {
        if (err) {
            log("GMEBot", "[moveNode: getCoreInstance failed: " + err.message + "]");
            return;
        }
        const core = result.core;
        const root = result.rootNode;
        if (!core || !root) {
            log("GMEBot", "[moveNode: no core or root]");
            return;
        }
        loadNode(core, root, nodeId, function (errN: any, node: any) {
            if (errN) {
                log("GMEBot", "[moveNode: load node failed: " + (errN && errN.message) + "]");
                return;
            }
            if (!node) {
                log("GMEBot", "[moveNode: node not found: " + nodeId + "]");
                return;
            }
            loadNode(core, root, newContainer, function (errP: any, parent: any) {
                if (errP) {
                    log("GMEBot", "[moveNode: load newContainer failed: " + (errP && errP.message) + "]");
                    return;
                }
                if (!parent) {
                    log("GMEBot", "[moveNode: new container not found: " + newContainer + "]");
                    return;
                }
                const moved = core.moveNode(node, parent);
                if (moved && !(moved as any).message) {
                    core.persist(moved);
                    log("GMEBot", "Moved node to " + newContainer + ".");
                } else {
                    log("GMEBot", "[moveNode failed: " + (moved && (moved as any).message ? (moved as any).message : "move not allowed") + "]");
                }
            });
        });
    });
}

function cmdDeleteNode(args: Record<string, any>, client: any, log: Logger): void {
    const nodeId: string = args.nodeId;
    if (!client || !nodeId) {
        log("GMEBot", "[deleteNode: missing client or nodeId]");
        return;
    }
    client.startTransaction("deleteNode");
    client.delMoreNodes([nodeId], "deleteNode");
    client.completeTransaction("deleteNode", function (err: any) {
        if (err) {
            log("GMEBot", "[deleteNode failed: " + err.message + "]");
            return;
        }
        log("GMEBot", "Deleted node " + nodeId + ".");
    });
}

function cmdSetAttribute(args: Record<string, any>, client: any, log: Logger): void {
    const nodeId: string = args.nodeId;
    const name: string = args.name;
    const value: string = args.value;
    if (!client || !nodeId || name === undefined || value === undefined) {
        log("GMEBot", "[setAttribute: missing client, nodeId, name, or value]");
        return;
    }
    client.getCoreInstance({}, function (err: any, result: any) {
        if (err) {
            log("GMEBot", "[setAttribute: getCoreInstance failed: " + err.message + "]");
            return;
        }
        const core = result.core;
        const root = result.rootNode;
        if (!core || !root) {
            log("GMEBot", "[setAttribute: no core or root]");
            return;
        }
        loadNode(core, root, nodeId, function (errLoad: any, node: any) {
            if (errLoad) {
                log("GMEBot", "[setAttribute: load node failed: " + (errLoad && errLoad.message) + "]");
                return;
            }
            if (!node) {
                log("GMEBot", "[setAttribute: node not found: " + nodeId + "]");
                return;
            }
            const res = core.setAttribute(node, name, value);
            if (res) {
                log("GMEBot", "[setAttribute failed: " + (res as any).message + "]");
                return;
            }
            core.persist(node);
            log("GMEBot", "Set attribute '" + name + "' on " + nodeId + ".");
        });
    });
}

function cmdGetAttribute(args: Record<string, any>, client: any, log: Logger): void {
    const nodeId: string = args.nodeId;
    const name: string = args.name;
    if (!client || !nodeId || name === undefined) {
        log("GMEBot", "[getAttribute: missing client, nodeId, or name]");
        return;
    }
    client.getCoreInstance({}, function (err: any, result: any) {
        if (err) {
            log("GMEBot", "[getAttribute: getCoreInstance failed: " + err.message + "]");
            return;
        }
        const core = result.core;
        const root = result.rootNode;
        if (!core || !root) {
            log("GMEBot", "[getAttribute: no core or root]");
            return;
        }
        loadNode(core, root, nodeId, function (errLoad: any, node: any) {
            if (errLoad) {
                log("GMEBot", "[getAttribute: load node failed: " + (errLoad && errLoad.message) + "]");
                return;
            }
            if (!node) {
                log("GMEBot", "[getAttribute: node not found: " + nodeId + "]");
                return;
            }
            try {
                const value = core.getAttribute(node, name);
                const str = value !== undefined && value !== null ? String(value) : "(empty)";
                log("GMEBot", "Attribute '" + name + "' = " + str);
            } catch (e: any) {
                log("GMEBot", "[getAttribute failed: " + (e && e.message) + "]");
            }
        });
    });
}

function cmdClearAttribute(args: Record<string, any>, client: any, log: Logger): void {
    const nodeId: string = args.nodeId;
    const name: string = args.name;
    if (!client || !nodeId || name === undefined) {
        log("GMEBot", "[clearAttribute: missing client, nodeId, or name]");
        return;
    }
    client.getCoreInstance({}, function (err: any, result: any) {
        if (err) {
            log("GMEBot", "[clearAttribute: getCoreInstance failed: " + err.message + "]");
            return;
        }
        const core = result.core;
        const root = result.rootNode;
        if (!core || !root) {
            log("GMEBot", "[clearAttribute: no core or root]");
            return;
        }
        loadNode(core, root, nodeId, function (errLoad: any, node: any) {
            if (errLoad) {
                log("GMEBot", "[clearAttribute: load node failed: " + (errLoad && errLoad.message) + "]");
                return;
            }
            if (!node) {
                log("GMEBot", "[clearAttribute: node not found: " + nodeId + "]");
                return;
            }
            const res = core.delAttribute(node, name);
            if (res) {
                log("GMEBot", "[clearAttribute failed: " + (res as any).message + "]");
                return;
            }
            core.persist(node);
            log("GMEBot", "Cleared attribute '" + name + "' on " + nodeId + ".");
        });
    });
}

function cmdSetProperty(args: Record<string, any>, client: any, log: Logger): void {
    const nodeId: string = args.nodeId;
    const name: string = args.name;
    const value: string = args.value;
    if (!client || !nodeId || name === undefined || value === undefined) {
        log("GMEBot", "[setProperty: missing client, nodeId, name, or value]");
        return;
    }
    client.getCoreInstance({}, function (err: any, result: any) {
        if (err) {
            log("GMEBot", "[setProperty: getCoreInstance failed: " + err.message + "]");
            return;
        }
        const core = result.core;
        const root = result.rootNode;
        if (!core || !root) {
            log("GMEBot", "[setProperty: no core or root]");
            return;
        }
        loadNode(core, root, nodeId, function (errLoad: any, node: any) {
            if (errLoad) {
                log("GMEBot", "[setProperty: load node failed: " + (errLoad && errLoad.message) + "]");
                return;
            }
            if (!node) {
                log("GMEBot", "[setProperty: node not found: " + nodeId + "]");
                return;
            }
            const attrNames = core.getAttributeNames(node) || [];
            const regNames = core.getRegistryNames(node) || [];
            if (attrNames.includes(name)) {
                const res = core.setAttribute(node, name, value);
                if (res) {
                    log("GMEBot", "[setProperty setAttribute failed: " + (res as any).message + "]");
                    return;
                }
                core.persist(node);
                log("GMEBot", "Set property '" + name + "' (attribute) on " + nodeId + ".");
            } else if (regNames.includes(name)) {
                let valueToSet: any = value;
                try {
                    const parsed = JSON.parse(value);
                    if (parsed !== null && typeof parsed === "object") valueToSet = parsed;
                } catch {
                    // keep string
                }
                client.startTransaction("setProperty");
                client.setRegistry(nodeId, name, valueToSet, "setProperty");
                client.completeTransaction("setProperty", function (errC: any) {
                    if (errC) {
                        log("GMEBot", "[setProperty setRegistry failed: " + errC.message + "]");
                        return;
                    }
                    log("GMEBot", "Set property '" + name + "' (registry) on " + nodeId + ".");
                });
            } else {
                log("GMEBot", "[setProperty: property '" + name + "' not found on " + nodeId + "]");
            }
        });
    });
}

function cmdSetRegistry(args: Record<string, any>, client: any, log: Logger): void {
    const nodeId: string = args.nodeId;
    const name: string = args.name;
    const value: string = args.value;
    if (!client || !nodeId || name === undefined || value === undefined) {
        log("GMEBot", "[setRegistry: missing client, nodeId, name, or value]");
        return;
    }
    client.startTransaction("setRegistry");
    client.setRegistry(nodeId, name, value, "setRegistry");
    client.completeTransaction("setRegistry", function (err: any) {
        if (err) {
            log("GMEBot", "[setRegistry failed: " + err.message + "]");
            return;
        }
        log("GMEBot", "Set registry '" + name + "' on " + nodeId + ".");
    });
}

function cmdGetRegistry(args: Record<string, any>, client: any, log: Logger): void {
    const nodeId: string = args.nodeId;
    const name: string = args.name;
    if (!client || !nodeId || name === undefined) {
        log("GMEBot", "[getRegistry: missing client, nodeId, or name]");
        return;
    }
    client.getCoreInstance({}, function (err: any, result: any) {
        if (err) {
            log("GMEBot", "[getRegistry: getCoreInstance failed: " + err.message + "]");
            return;
        }
        const core = result.core;
        const root = result.rootNode;
        if (!core || !root) {
            log("GMEBot", "[getRegistry: no core or root]");
            return;
        }
        loadNode(core, root, nodeId, function (errLoad: any, node: any) {
            if (errLoad) {
                log("GMEBot", "[getRegistry: load node failed: " + (errLoad && errLoad.message) + "]");
                return;
            }
            if (!node) {
                log("GMEBot", "[getRegistry: node not found: " + nodeId + "]");
                return;
            }
            try {
                const value = core.getRegistry(node, name);
                const str = value !== undefined && value !== null ? JSON.stringify(value) : "(empty)";
                log("GMEBot", "Registry '" + name + "' = " + str);
            } catch (e: any) {
                log("GMEBot", "[getRegistry failed: " + (e && e.message) + "]");
            }
        });
    });
}

function cmdClearRegistry(args: Record<string, any>, client: any, log: Logger): void {
    const nodeId: string = args.nodeId;
    const name: string = args.name;
    if (!client || !nodeId || name === undefined) {
        log("GMEBot", "[clearRegistry: missing client, nodeId, or name]");
        return;
    }
    client.getCoreInstance({}, function (err: any, result: any) {
        if (err) {
            log("GMEBot", "[clearRegistry: getCoreInstance failed: " + err.message + "]");
            return;
        }
        const core = result.core;
        const root = result.rootNode;
        if (!core || !root) {
            log("GMEBot", "[clearRegistry: no core or root]");
            return;
        }
        loadNode(core, root, nodeId, function (errLoad: any, node: any) {
            if (errLoad) {
                log("GMEBot", "[clearRegistry: load node failed: " + (errLoad && errLoad.message) + "]");
                return;
            }
            if (!node) {
                log("GMEBot", "[clearRegistry: node not found: " + nodeId + "]");
                return;
            }
            const res = core.delRegistry(node, name);
            if (res) {
                log("GMEBot", "[clearRegistry failed: " + (res as any).message + "]");
                return;
            }
            core.persist(node);
            log("GMEBot", "Cleared registry '" + name + "' on " + nodeId + ".");
        });
    });
}
