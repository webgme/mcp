'use strict';

/**
 * Shared helper for POST /cback/test/run-tool (NODE_ENV=test only).
 */

if (process.env.NODE_ENV !== 'test') {
    process.env.NODE_ENV = 'test';
}

var testFixture = require('../../../globals'),
    superagent = testFixture.superagent,
    gmeConfig = testFixture.getGmeConfig(),
    server = testFixture.WebGME.standaloneServer(gmeConfig),
    mntPt = require('../../../../webgme-setup.json').components.routers['cback'].mount;

function cbackUrl(path) {
    return [server.getUrl(), mntPt, path].join('/');
}

function runTool(opts) {
    return superagent
        .post(cbackUrl('test/run-tool'))
        .send(opts)
        .then(function (res) {
            if (res.statusCode !== 200) {
                var msg = (res.body && res.body.error) || res.text || ('status ' + res.statusCode);
                var err = new Error('run-tool failed: ' + msg);
                err.status = res.statusCode;
                err.body = res.body;
                throw err;
            }
            return res.body;
        });
}

function startServer(done) {
    server.start(done);
}

function stopServer(done) {
    server.stop(done);
}

/** Prefer this seeded project (see config/config.test.js createAtStartup). */
var STARTUP_SEED_PROJECT = 'PatchMetaTestSeed';

function probeProject(projectId) {
    return runTool({
        toolName: 'getMetaInfo',
        args: {},
        context: { projectId: projectId, branchName: 'master' },
    }).then(function (res) {
        if (res.data && res.data.error) {
            throw new Error('getMetaInfo failed for ' + projectId);
        }
        return { projectId: projectId, branchName: 'master' };
    });
}

function tryProjectsSequentially(projects, index) {
    if (!projects || index >= projects.length) {
        return Promise.reject(
            new Error(
                'ensureTestProject: no project with a valid master commit (configure seedProjects.createAtStartup in config.test.js)'
            )
        );
    }
    var projectId = projects[index].projectId;
    return probeProject(projectId).catch(function () {
        return tryProjectsSequentially(projects, index + 1);
    });
}

/**
 * Return a WebGME project whose master branch can be opened as coreSession.
 * Prefers the EmptyProject seed from config.test.js, then any openable project.
 */
function ensureTestProject(projectName) {
    projectName = projectName || STARTUP_SEED_PROJECT;
    return runTool({ toolName: 'listProjects', args: {} }).then(function (body) {
        var projects = (body.data && body.data.projects) || [];
        var preferred = projects.filter(function (p) {
            return (
                p.projectId &&
                (p.projectId.indexOf(STARTUP_SEED_PROJECT) !== -1 ||
                    p.projectId.indexOf(projectName) !== -1 ||
                    p.name === projectName ||
                    p.name === STARTUP_SEED_PROJECT)
            );
        });
        return tryProjectsSequentially(preferred.length ? preferred : projects, 0);
    });
}

function metamodelContext(projectId, branchName) {
    return {
        projectId: projectId,
        branchName: branchName || 'master',
        modelingMode: 'metamodel',
    };
}

function getMetaDescriptor(ctx) {
    return runTool({ toolName: 'getMetaDescriptor', args: {}, context: ctx }).then(function (res) {
        return res.data;
    });
}

/** Deep-compare canonical MetaDescriptor (ignores key order). */
function expectMetaDescriptor(actual, expected) {
    var expect = require('../../globals').expect;
    expect(actual).to.be.an('object');
    expect(actual.version).to.equal(1);
    expect(actual).to.deep.equal(expected);
}

/** Read helpers for getMetaInfo-shaped responses (WebGME core, not MetaDescriptor JSON). */
function findConcept(metaRes, name) {
    var concepts = (metaRes.data && metaRes.data.concepts) || [];
    for (var i = 0; i < concepts.length; i++) {
        if (concepts[i].name === name) {
            return concepts[i];
        }
    }
    return null;
}

function conceptNames(metaRes) {
    return ((metaRes.data && metaRes.data.concepts) || [])
        .map(function (c) {
            return c.name;
        })
        .filter(function (n) {
            return n && n !== 'FCO';
        });
}

function pathToNameMap(metaRes) {
    var map = {};
    ((metaRes.data && metaRes.data.concepts) || []).forEach(function (c) {
        if (c.path && c.name) {
            map[c.path] = c.name;
        }
    });
    return map;
}

function pathsToNames(paths, metaRes) {
    if (!Array.isArray(paths)) {
        return [];
    }
    var map = pathToNameMap(metaRes);
    return paths.map(function (p) {
        return map[p] || (typeof p === 'string' ? p.split('/').pop() : p);
    });
}

function containmentChildNames(concept, metaRes) {
    var items =
        concept &&
        concept.meta &&
        concept.meta.children &&
        concept.meta.children.items;
    return pathsToNames(items, metaRes);
}

function pointerTargetNames(concept, pointerName, metaRes) {
    var ptr =
        concept &&
        concept.meta &&
        concept.meta.pointers &&
        concept.meta.pointers[pointerName];
    return pathsToNames(ptr && ptr.items, metaRes);
}

module.exports = {
    runTool: runTool,
    startServer: startServer,
    stopServer: stopServer,
    ensureTestProject: ensureTestProject,
    metamodelContext: metamodelContext,
    getMetaDescriptor: getMetaDescriptor,
    expectMetaDescriptor: expectMetaDescriptor,
    findConcept: findConcept,
    conceptNames: conceptNames,
    containmentChildNames: containmentChildNames,
    pointerTargetNames: pointerTargetNames,
};
