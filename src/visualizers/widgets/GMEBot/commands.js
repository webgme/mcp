define(["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.executeCommands = executeCommands;
    function executeCommands(commands, client, log) {
        for (const cmd of commands) {
            const handler = HANDLERS[cmd.type];
            if (handler) {
                handler(cmd.args, client, log);
            }
            else {
                log("GMEBot", "[Unknown command: " + cmd.type + "]");
            }
        }
    }
    /** Load a node by path from root; callback(err, node). Use loadByPath for all cases — it handles root and already-loaded nodes. */
    function loadNode(core, root, nodeId, callback) {
        core.loadByPath(root, nodeId, callback);
    }
    const HANDLERS = {
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
    function cmdSwitchProject(args, client, log) {
        const projectId = args.projectId;
        if (!client || !projectId) {
            log("GMEBot", "[switchProject: missing client or projectId]");
            return;
        }
        const branchName = args.branchName || null;
        const label = projectId + (branchName ? " @ " + branchName : "");
        log("GMEBot", "Switching to " + label + "...");
        client.selectProject(projectId, branchName, function (err) {
            if (err) {
                log("GMEBot", "[switchProject failed: " + err.message + "]");
                return;
            }
            log("GMEBot", "Switched to " + label);
        });
    }
    function cmdCreateBranch(args, client, log) {
        const projectId = args.projectId;
        const branchName = args.branchName;
        const fromCommitHash = args.fromCommitHash;
        if (!client || !projectId || !branchName || !fromCommitHash) {
            log("GMEBot", "[createBranch: missing client, projectId, branchName, or fromCommitHash]");
            return;
        }
        log("GMEBot", "Creating branch '" + branchName + "' from commit " + fromCommitHash + "...");
        client.createBranch(projectId, branchName, fromCommitHash, function (err) {
            if (err) {
                log("GMEBot", "[createBranch failed: " + err.message + "]");
                return;
            }
            log("GMEBot", "Branch '" + branchName + "' created.");
        });
    }
    function cmdDeleteBranch(args, client, log) {
        const projectId = args.projectId;
        const branchName = args.branchName;
        const branchHash = args.branchHash;
        if (!client || !projectId || !branchName || !branchHash) {
            log("GMEBot", "[deleteBranch: missing client, projectId, branchName, or branchHash]");
            return;
        }
        log("GMEBot", "Deleting branch '" + branchName + "'...");
        client.deleteBranch(projectId, branchName, branchHash, function (err) {
            if (err) {
                log("GMEBot", "[deleteBranch failed: " + err.message + "]");
                return;
            }
            log("GMEBot", "Branch '" + branchName + "' deleted.");
        });
    }
    function cmdSquashBranch(args, client, log) {
        const projectId = args.projectId;
        const branchName = args.branchName;
        const fromCommitId = args.fromCommitId;
        const message = args.message;
        if (!client || !projectId || !branchName || !fromCommitId) {
            log("GMEBot", "[squashBranch: missing client, projectId, branchName, or fromCommitId]");
            return;
        }
        log("GMEBot", "Squashing branch '" + branchName + "' from commit " + fromCommitId + "...");
        client.squashCommits(projectId, fromCommitId, branchName, message || null, function (err, result) {
            if (err) {
                log("GMEBot", "[squashBranch failed: " + err.message + "]");
                return;
            }
            log("GMEBot", "Branch squashed." + (result && result.hash ? " New hash: " + result.hash : ""));
        });
    }
    function cmdSetClientState(args, _client, log) {
        const activeNodeId = args.activeNodeId;
        const visualizerId = args.visualizerId;
        if (!activeNodeId && !visualizerId) {
            log("GMEBot", "[setClientState: provide at least activeNodeId or visualizerId]");
            return;
        }
        const g = typeof window !== "undefined" ? window.WebGMEGlobal : undefined;
        if (!(g === null || g === void 0 ? void 0 : g.State)) {
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
    function cmdCreateNode(args, client, log) {
        const container = args.container;
        const baseType = args.baseType || "FCO";
        if (!client || !container) {
            log("GMEBot", "[createNode: missing client or container]");
            return;
        }
        client.getCoreInstance({}, function (err, result) {
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
            loadNode(core, root, container, function (errLoad, parentNode) {
                if (errLoad) {
                    log("GMEBot", "[createNode: load container failed: " + (errLoad && errLoad.message) + "]");
                    return;
                }
                if (!parentNode) {
                    log("GMEBot", "[createNode: container node not found: " + container + "]");
                    return;
                }
                function doCreate(baseNode) {
                    const created = core.createNode({ parent: parentNode, base: baseNode });
                    if (created && !created.message) {
                        core.persist(created);
                        log("GMEBot", "Created node under " + container + " (base: " + baseType + ").");
                    }
                    else {
                        log("GMEBot", "[createNode failed: " + (created && created.message ? created.message : "invalid base or parent") + "]");
                    }
                }
                if (baseType === "FCO" || !baseType || baseType.indexOf("/") === -1) {
                    const rootBase = core.getBase(root);
                    const fco = core.getFCO ? core.getFCO(root) : null;
                    const baseNode = rootBase || fco || root;
                    doCreate(baseNode);
                }
                else {
                    loadNode(core, root, baseType, function (errBase, baseNode) {
                        if (errBase || !baseNode) {
                            const baseNodeFallback = core.getBase(parentNode) || root;
                            doCreate(baseNodeFallback);
                        }
                        else {
                            doCreate(baseNode);
                        }
                    });
                }
            });
        });
    }
    function cmdMoveNode(args, client, log) {
        const nodeId = args.nodeId;
        const newContainer = args.newContainer;
        if (!client || !nodeId || !newContainer) {
            log("GMEBot", "[moveNode: missing client, nodeId, or newContainer]");
            return;
        }
        client.getCoreInstance({}, function (err, result) {
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
            loadNode(core, root, nodeId, function (errN, node) {
                if (errN) {
                    log("GMEBot", "[moveNode: load node failed: " + (errN && errN.message) + "]");
                    return;
                }
                if (!node) {
                    log("GMEBot", "[moveNode: node not found: " + nodeId + "]");
                    return;
                }
                loadNode(core, root, newContainer, function (errP, parent) {
                    if (errP) {
                        log("GMEBot", "[moveNode: load newContainer failed: " + (errP && errP.message) + "]");
                        return;
                    }
                    if (!parent) {
                        log("GMEBot", "[moveNode: new container not found: " + newContainer + "]");
                        return;
                    }
                    const moved = core.moveNode(node, parent);
                    if (moved && !moved.message) {
                        core.persist(moved);
                        log("GMEBot", "Moved node to " + newContainer + ".");
                    }
                    else {
                        log("GMEBot", "[moveNode failed: " + (moved && moved.message ? moved.message : "move not allowed") + "]");
                    }
                });
            });
        });
    }
    function cmdDeleteNode(args, client, log) {
        const nodeId = args.nodeId;
        if (!client || !nodeId) {
            log("GMEBot", "[deleteNode: missing client or nodeId]");
            return;
        }
        client.startTransaction("deleteNode");
        client.delMoreNodes([nodeId], "deleteNode");
        client.completeTransaction("deleteNode", function (err) {
            if (err) {
                log("GMEBot", "[deleteNode failed: " + err.message + "]");
                return;
            }
            log("GMEBot", "Deleted node " + nodeId + ".");
        });
    }
    function cmdSetAttribute(args, client, log) {
        const nodeId = args.nodeId;
        const name = args.name;
        const value = args.value;
        if (!client || !nodeId || name === undefined || value === undefined) {
            log("GMEBot", "[setAttribute: missing client, nodeId, name, or value]");
            return;
        }
        client.getCoreInstance({}, function (err, result) {
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
            loadNode(core, root, nodeId, function (errLoad, node) {
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
                    log("GMEBot", "[setAttribute failed: " + res.message + "]");
                    return;
                }
                core.persist(node);
                log("GMEBot", "Set attribute '" + name + "' on " + nodeId + ".");
            });
        });
    }
    function cmdGetAttribute(args, client, log) {
        const nodeId = args.nodeId;
        const name = args.name;
        if (!client || !nodeId || name === undefined) {
            log("GMEBot", "[getAttribute: missing client, nodeId, or name]");
            return;
        }
        client.getCoreInstance({}, function (err, result) {
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
            loadNode(core, root, nodeId, function (errLoad, node) {
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
                }
                catch (e) {
                    log("GMEBot", "[getAttribute failed: " + (e && e.message) + "]");
                }
            });
        });
    }
    function cmdClearAttribute(args, client, log) {
        const nodeId = args.nodeId;
        const name = args.name;
        if (!client || !nodeId || name === undefined) {
            log("GMEBot", "[clearAttribute: missing client, nodeId, or name]");
            return;
        }
        client.getCoreInstance({}, function (err, result) {
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
            loadNode(core, root, nodeId, function (errLoad, node) {
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
                    log("GMEBot", "[clearAttribute failed: " + res.message + "]");
                    return;
                }
                core.persist(node);
                log("GMEBot", "Cleared attribute '" + name + "' on " + nodeId + ".");
            });
        });
    }
    function cmdSetProperty(args, client, log) {
        const nodeId = args.nodeId;
        const name = args.name;
        const value = args.value;
        if (!client || !nodeId || name === undefined || value === undefined) {
            log("GMEBot", "[setProperty: missing client, nodeId, name, or value]");
            return;
        }
        client.getCoreInstance({}, function (err, result) {
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
            loadNode(core, root, nodeId, function (errLoad, node) {
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
                        log("GMEBot", "[setProperty setAttribute failed: " + res.message + "]");
                        return;
                    }
                    core.persist(node);
                    log("GMEBot", "Set property '" + name + "' (attribute) on " + nodeId + ".");
                }
                else if (regNames.includes(name)) {
                    let valueToSet = value;
                    try {
                        const parsed = JSON.parse(value);
                        if (parsed !== null && typeof parsed === "object")
                            valueToSet = parsed;
                    }
                    catch {
                        // keep string
                    }
                    client.startTransaction("setProperty");
                    client.setRegistry(nodeId, name, valueToSet, "setProperty");
                    client.completeTransaction("setProperty", function (errC) {
                        if (errC) {
                            log("GMEBot", "[setProperty setRegistry failed: " + errC.message + "]");
                            return;
                        }
                        log("GMEBot", "Set property '" + name + "' (registry) on " + nodeId + ".");
                    });
                }
                else {
                    log("GMEBot", "[setProperty: property '" + name + "' not found on " + nodeId + "]");
                }
            });
        });
    }
    function cmdSetRegistry(args, client, log) {
        const nodeId = args.nodeId;
        const name = args.name;
        const value = args.value;
        if (!client || !nodeId || name === undefined || value === undefined) {
            log("GMEBot", "[setRegistry: missing client, nodeId, name, or value]");
            return;
        }
        client.startTransaction("setRegistry");
        client.setRegistry(nodeId, name, value, "setRegistry");
        client.completeTransaction("setRegistry", function (err) {
            if (err) {
                log("GMEBot", "[setRegistry failed: " + err.message + "]");
                return;
            }
            log("GMEBot", "Set registry '" + name + "' on " + nodeId + ".");
        });
    }
    function cmdGetRegistry(args, client, log) {
        const nodeId = args.nodeId;
        const name = args.name;
        if (!client || !nodeId || name === undefined) {
            log("GMEBot", "[getRegistry: missing client, nodeId, or name]");
            return;
        }
        client.getCoreInstance({}, function (err, result) {
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
            loadNode(core, root, nodeId, function (errLoad, node) {
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
                }
                catch (e) {
                    log("GMEBot", "[getRegistry failed: " + (e && e.message) + "]");
                }
            });
        });
    }
    function cmdClearRegistry(args, client, log) {
        const nodeId = args.nodeId;
        const name = args.name;
        if (!client || !nodeId || name === undefined) {
            log("GMEBot", "[clearRegistry: missing client, nodeId, or name]");
            return;
        }
        client.getCoreInstance({}, function (err, result) {
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
            loadNode(core, root, nodeId, function (errLoad, node) {
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
                    log("GMEBot", "[clearRegistry failed: " + res.message + "]");
                    return;
                }
                core.persist(node);
                log("GMEBot", "Cleared registry '" + name + "' on " + nodeId + ".");
            });
        });
    }
});
