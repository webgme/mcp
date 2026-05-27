'use strict';

var config = require('./config.webgme'),
    validateConfig = require('webgme/config/validator');

// Add/overwrite any additional settings here
// config.server.port = 8080;
// config.mongo.uri = 'mongodb://127.0.0.1:27017/webgme_my_app';

// Console: info (concise). File: debug (full payloads).
config.server.log = {
    transports: [{
        transportType: 'Console',
        options: {
            level: 'info',
            colorize: true,
            timestamp: true,
            prettyPrint: true,
            handleExceptions: true,
            depth: 2
        }
    }, {
        transportType: 'File',
        options: {
            name: 'debug-file',
            filename: './server.log',
            level: 'debug',
            json: false
        }
    }]
};

validateConfig(config);

// TypeScript build output (packages/*/ → dist/). Hand-authored WebGME assets stay under src/.
config.requirejsPaths = config.requirejsPaths || {};
config.requirejsPaths['widgets/GMEBot/Widget'] = './dist/visualizers/widgets/GMEBot/Widget';

module.exports = config;
