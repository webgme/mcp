'use strict';

/**
 * Loaded when NODE_ENV=jarvis. Only overrides MongoDB URI; all other options come from config.webgme.js.
 */

var config = require('./config.webgme'),
    validateConfig = require('webgme/config/validator');

config.mongo.uri = 'mongodb://mongodb:27017/webgme_mcp';

validateConfig(config);
module.exports = config;
