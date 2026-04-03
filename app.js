// jshint node: true
'use strict';
process.chdir(__dirname);

// Environment: optional `.env` with NODE_ENV is loaded via npm `start` (--env-file-if-exists).

var gmeConfig = require('./config'),
    webgme = require('webgme'),
    myServer;

webgme.addToRequireJsPaths(gmeConfig);

myServer = new webgme.standaloneServer(gmeConfig);
myServer.start(function () {
    //console.log('server up');
});
