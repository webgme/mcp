// jshint node: true
'use strict';
var path = require('path');
process.chdir(__dirname);

// Load .env from project root so LLM_PROVIDER, GROQ_API_KEY, etc. are set without exporting manually
require('dotenv').config({ path: path.join(__dirname, '.env') });

var gmeConfig = require('./config'),
    webgme = require('webgme'),
    myServer;

webgme.addToRequireJsPaths(gmeConfig);

myServer = new webgme.standaloneServer(gmeConfig);
myServer.start(function () {
    //console.log('server up');
});
