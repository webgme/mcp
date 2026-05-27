/**
 * Example integration tests for patchMetaDescriptor via POST /cback/test/run-tool.
 *
 * See README_PATCH_META_TESTS.md for how to add more cases (input, context, assertions).
 */
'use strict';

var expect = require('../../globals').expect,
    h = require('./helpers/runTool'),
    FSM_EXPECTED = require('./fixtures/fsm-meta-descriptor.expected.json');

/** One-shot FSM metamodel patch (map-based MetaDescriptor). */
var FSM_PATCH = [
    { op: 'add', path: '/concepts/State', value: {} },
    { op: 'add', path: '/concepts/Transition', value: {} },
    {
        op: 'add',
        path: '/concepts/StateMachine',
        value: { contains: { State: '*', Transition: '*' } },
    },
    {
        op: 'add',
        path: '/relationships/Transition',
        value: { from: 'State', to: 'State' },
    },
];

describe('patchMetaDescriptor (run-tool)', function () {
    this.timeout(30000);

    var projectId;
    var branchName = 'master';
    var ctx;

    before(function (done) {
        h.startServer(done);
    });

    after(function (done) {
        h.stopServer(done);
    });

    before(function () {
        return h.ensureTestProject('PatchMetaFSMProject').then(function (p) {
            projectId = p.projectId;
            branchName = p.branchName;
            ctx = h.metamodelContext(projectId, branchName);
        });
    });

    it('applies FSM patch and matches expected MetaDescriptor', function () {
        if (!projectId) {
            return this.skip();
        }

        return h
            .runTool({
                toolName: 'patchMetaDescriptor',
                args: { patch: FSM_PATCH },
                context: ctx,
            })
            .then(function (patchRes) {
                expect(patchRes.data.ok).to.equal(true);
                expect(patchRes.data.error).to.not.exist;
                if (patchRes.data.warnings) {
                    expect(patchRes.data.warnings).to.deep.equal([]);
                }

                return h.getMetaDescriptor(ctx);
            })
            .then(function (descriptor) {
                h.expectMetaDescriptor(descriptor, FSM_EXPECTED);
            });
    });

    it('rejects empty patch', function () {
        if (!projectId) {
            return this.skip();
        }

        return h
            .runTool({
                toolName: 'patchMetaDescriptor',
                args: { patch: [] },
                context: ctx,
            })
            .then(function (res) {
                expect(res.data.error).to.match(/non-empty/i);
            });
    });
});
