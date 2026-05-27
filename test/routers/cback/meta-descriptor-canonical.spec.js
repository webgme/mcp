'use strict';

/**
 * Pure unit tests for MetaDescriptor canonicalization (no WebGME / Mongo).
 * Requires: npm run build --workspace=packages/cback
 */

var expect = require('../../globals').expect,
    md = require('../../../dist/routers/cback/metaDescriptor');

describe('normalizeMetaDescriptor string-array canonicalization', function () {
    it('sorts and dedupes relationship from/to arrays', function () {
        var out = md.normalizeMetaDescriptor({
            version: 1,
            concepts: { Link: {}, Alpha: {}, Beta: {}, X: {}, Y: {} },
            relationships: {
                Link: { from: ['Beta', 'Alpha', 'Beta'], to: ['Y', 'X'] },
            },
        });
        expect(out.relationships.Link.from).to.deep.equal(['Alpha', 'Beta']);
        expect(out.relationships.Link.to).to.deep.equal(['X', 'Y']);
    });

    it('collapses singleton arrays to a string', function () {
        var out = md.normalizeMetaDescriptor({
            version: 1,
            concepts: { T: {}, S: {} },
            relationships: { T: { from: ['S'], to: 'S' } },
        });
        expect(out.relationships.T.from).to.equal('S');
        expect(out.relationships.T.to).to.equal('S');
    });

    it('sorts concept pointer target arrays', function () {
        var out = md.normalizeMetaDescriptor({
            version: 1,
            concepts: {
                Box: {
                    pointers: {
                        ref: ['Zeta', 'Alpha', 'Alpha'],
                    },
                },
                Alpha: {},
                Zeta: {},
            },
        });
        expect(out.concepts.Box.pointers.ref).to.deep.equal(['Alpha', 'Zeta']);
    });

    it('sorts enum attribute values arrays', function () {
        var out = md.normalizeMetaDescriptor({
            version: 1,
            concepts: {
                Item: {
                    attributes: {
                        kind: {
                            type: 'enum',
                            values: ['c', 'a', 'b', 'a'],
                        },
                    },
                },
            },
        });
        expect(out.concepts.Item.attributes.kind.values).to.deep.equal(['a', 'b', 'c']);
    });

    it('treats reorder-only relationship patches as unchanged keys', function () {
        var a = md.normalizeMetaDescriptor({
            version: 1,
            concepts: { L: {}, A: {}, B: {} },
            relationships: { L: { from: ['A', 'B'], to: 'A' } },
        });
        var b = md.normalizeMetaDescriptor({
            version: 1,
            concepts: { L: {}, A: {}, B: {} },
            relationships: { L: { from: ['B', 'A'], to: 'A' } },
        });
        expect(a).to.deep.equal(b);
    });
});
