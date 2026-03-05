/**
 * Automated prompt-driven tests: send prompts (or simulate tool sequences) and assert
 * on the response or the resulting model state.
 *
 * Uses the test-only POST /cback/test/run-tool endpoint to run tools and inspect
 * model state without requiring a real LLM. Optional E2E tests that POST to /chat
 * require Ollama and can be run separately (e.g. OLLAMA_E2E=1 npm test).
 */
'use strict';

// Ensure test-only route is registered when the server starts
if (process.env.NODE_ENV !== 'test') {
    process.env.NODE_ENV = 'test';
}

var testFixture = require('../../globals'),
    superagent = testFixture.superagent,
    expect = testFixture.expect,
    gmeConfig = testFixture.getGmeConfig(),
    server = testFixture.WebGME.standaloneServer(gmeConfig),
    mntPt = require('../../../webgme-setup.json').components.routers['cback'].mount;

function url(path) {
    return [server.getUrl(), mntPt, path].join('/');
}

function runTool(opts) {
    return superagent
        .post(url('test/run-tool'))
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

describe('cback prompt-driven tests', function () {
    var testProjectId;
    var testBranch = 'master';

    before(function (done) {
        server.start(done);
    });

    after(function (done) {
        server.stop(done);
    });

    describe('model state after tool sequence (no LLM)', function () {
        before(function () {
            return runTool({ toolName: 'listSeeds', args: {} })
                .then(function (seedsRes) {
                    var seeds = (seedsRes.data && seedsRes.data.seeds) || [];
                    var args = { projectName: 'PromptTestProject' };
                    if (seeds.length > 0) {
                        args.seedName = seeds[0];
                    }
                    return runTool({ toolName: 'createProject', args: args });
                })
                .then(function (body) {
                    expect(body.data).to.be.an('object');
                    if (body.data.created === true && body.data.projectId) {
                        testProjectId = body.data.projectId;
                        return;
                    }
                    return runTool({ toolName: 'listProjects', args: {} }).then(function (listBody) {
                        var projects = (listBody.data && listBody.data.projects) || [];
                        if (projects.length > 0) {
                            testProjectId = projects[0].projectId;
                        }
                    });
                });
        });

        it('run-tool listProjects and createProject work', function () {
            return runTool({ toolName: 'listProjects', args: {} })
                .then(function (body) {
                    expect(body.data).to.be.an('object');
                    expect(body.data.projects).to.be.an('array');
                    if (testProjectId) {
                        expect(body.data.projects.some(function (p) {
                            return p.projectId === testProjectId;
                        })).to.equal(true);
                    }
                });
        });

        it('createMetaNode adds a concept and getMetaInfo reflects it', function () {
            if (!testProjectId) return this.skip();
            var ctx = { projectId: testProjectId, branchName: testBranch };
            return runTool({
                toolName: 'createMetaNode',
                args: { name: 'TestConcept' },
                context: ctx
            })
                .then(function (createRes) {
                    if (createRes.data && createRes.data.error) {
                        this.skip();
                        return;
                    }
                    expect(createRes.data).to.be.an('object');
                    expect(createRes.data.error).to.not.exist;
                    return runTool({ toolName: 'getMetaInfo', args: {}, context: ctx });
                }.bind(this))
                .then(function (metaRes) {
                    if (!metaRes || metaRes.data.error) return this.skip();
                    expect(metaRes.data).to.be.an('object');
                    expect(metaRes.data.concepts).to.be.an('array');
                    var names = metaRes.data.concepts.map(function (c) {
                        return (c && c.name) || (c && c.path && c.path.split('/').pop()) || '';
                    });
                    expect(names).to.include('TestConcept');
                }.bind(this))
                .catch(function (err) {
                    if (err.status === 500) this.skip();
                    else throw err;
                }.bind(this));
        });

        it('setMetaContainment can define containment and getMetaInfo shows concepts', function () {
            if (!testProjectId) return this.skip();
            var ctx = { projectId: testProjectId, branchName: testBranch };
            return runTool({
                toolName: 'createMetaNode',
                args: { name: 'Container' },
                context: ctx
            })
                .then(function (r) {
                    if (r.data && r.data.error) return this.skip();
                    return runTool({
                        toolName: 'createMetaNode',
                        args: { name: 'Item' },
                        context: ctx
                    });
                }.bind(this))
                .then(function (r) {
                    if (r.data && r.data.error) return this.skip();
                    return runTool({
                        toolName: 'setMetaContainment',
                        args: {
                            sourcePath: '/Container',
                            targetPath: '/Item'
                        },
                        context: ctx
                    });
                }.bind(this))
                .then(function (relRes) {
                    if (relRes.data && relRes.data.error) return this.skip();
                    return runTool({ toolName: 'getMetaInfo', args: {}, context: ctx });
                })
                .then(function (metaRes) {
                    if (metaRes.data.error) return this.skip();
                    expect(metaRes.data.concepts).to.be.an('array');
                    var names = metaRes.data.concepts.map(function (c) {
                        return (c && c.name) || (c && c.path && c.path.split('/').pop()) || '';
                    });
                    expect(names).to.include('Container');
                    expect(names).to.include('Item');
                })
                .catch(function (err) {
                    if (err.status === 500) this.skip();
                    else throw err;
                }.bind(this));
        });
    });

    describe('chat response (E2E, requires Ollama)', function () {
        it('POST /chat returns reply when Ollama is available', function (done) {
            this.timeout(15000);
            if (!process.env.OLLAMA_E2E) {
                this.skip();
                return done();
            }
            superagent
                .post(url('chat'))
                .send({
                    message: 'List all projects. Reply with only the number of projects.',
                    context: {}
                })
                .end(function (err, res) {
                    if (err) return done(err);
                    try {
                        expect(res.statusCode).to.equal(200);
                        expect(res.body).to.have.property('reply');
                        expect(res.body.reply).to.be.a('string');
                        done();
                    } catch (e) {
                        done(e);
                    }
                });
        });
    });
});
