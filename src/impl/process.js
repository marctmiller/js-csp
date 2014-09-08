"use strict";

var dispatch = require("./dispatch");
var select = require("./select");
var recorder = require("./record");

var NEXT_PROCESS_ID = 1;

var FnHandler = function(f, type, procId) {
  this.f = f;
  this.type = type;

  this.procId = procId;
  this.started = Date.now();
};

FnHandler.prototype.is_active = function() {
  return true;
};

FnHandler.prototype.commit = function() {
  return this.f;
};

var noop = function() {};

function put_then_callback(channel, value, callback, procId) {
  callback = callback || noop;
  var result = channel._put(value, new FnHandler(callback, 'put', procId));
  if (result) {
    callback(result.value);
  }
}

function take_then_callback(channel, callback, procId) {
  callback = callback || noop;
  var result = channel._take(new FnHandler(callback, 'take', procId));
  if (result && callback) {
    callback(result.value);
  }
}

var Process = function(gen, onFinish) {
  this.gen = gen;
  this.finished = false;
  this.onFinish = onFinish;
  this.startedTime = Date.now();
  this.id = NEXT_PROCESS_ID++;
};

var Instruction = function(op, data) {
  this.op = op;
  this.data = data;
};

var TAKE = "take";
var TAKEM = "takem";
var PUT = "put";
var ALTS = "alts";

// TODO FIX XXX: This is a (probably) temporary hack to avoid blowing
// up the stack, but it means double queueing when the value is not
// immediately available
Process.prototype._continue = function(response, throwError) {
  var self = this;
  dispatch.run(function() {
    self.run(response, throwError);
  });
};

Process.prototype._done = function(value) {
  if (!this.finished) {
    recorder.addAction({
      type: 'stopping',
      runningTime: Date.now() - this.startedTime,
      procId: this.id
    });

    this.finished = true;
    var onFinish = this.onFinish;
    if (typeof onFinish === "function") {
      dispatch.run(function() {
        onFinish(value);
      });
    }
  }
};

Process.prototype.run = function(response, throwError) {
  if (this.finished) {
    return;
  }

  // TODO: Shouldn't we (optionally) stop error propagation here (and
  // signal the error through a channel or something)? Otherwise the
  // uncaught exception will crash some runtimes (e.g. Node)
  var method = ((throwError && response instanceof Error) ?
                'throw' : 'next');
  var iter = this.gen[method](response);
  if (iter.done) {
    this._done(iter.value);
    return;
  }

  var ins = iter.value;
  var self = this;

  if (ins instanceof Instruction) {
    switch (ins.op) {
    case PUT:
      var data = ins.data;
      put_then_callback(data.channel, data.value, function(ok) {
        self._continue(ok);
      }, this.id);
      break;

    case TAKE:
      var channel = ins.data;
      take_then_callback(channel, function(value) {
        self._continue(value);
      }, this.id);
      break;

    case TAKEM:
      var channel = ins.data;
      take_then_callback(channel, function(value) {
        self._continue(value, true);
      }, this.id);
      break;

    case ALTS:
      select.do_alts(ins.data.operations, function(result) {
        self._continue(result);
      }, ins.data.options, this.id);
      break;
    }
  }
  else {
    this._continue(ins);
  }
};

function take(channel) {
  return new Instruction(TAKE, channel);
}

function takem(channel) {
  return new Instruction(TAKEM, channel);
}

function put(channel, value) {
  return new Instruction(PUT, {
    channel: channel,
    value: value
  });
}

function alts(operations, options) {
  return new Instruction(ALTS, {
    operations: operations,
    options: options
  });
}

exports.put_then_callback = put_then_callback;
exports.take_then_callback = take_then_callback;
exports.put = put;
exports.take = take;
exports.takem = takem;
exports.alts = alts;

exports.Process = Process;
