/*jshint node: true*/
/**
 * @author lattmann / https://github.com/lattmann
 */

var config = require('./config.default');

config.server.port = 9001;
config.mongo.uri = 'mongodb://127.0.0.1:27017/webgme_tests';

// Seeded EmptyProject for integration tests (createProject alone has no initial commit).
config.seedProjects.createAtStartup.push({
    seedId: 'EmptyProject',
    projectName: 'PatchMetaTestSeed',
    creatorId: 'guest',
    rights: {
        guest: { read: true, write: true, delete: true },
    },
});

module.exports = config;
