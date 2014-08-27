"use strict";

var csp = require("./csp.core");
var operations = require("./csp.operations");
var recorder = require("./impl/record");

csp.operations = operations;
csp.recorder = recorder;

module.exports = csp;
