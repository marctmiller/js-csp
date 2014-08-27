"use strict";

var dispatch = require("./dispatch");
var select = require("./select");
var parsetrace = require("./parsetrace");
var recorder = require("./record");
var Channel = require("./channels").Channel;

var NEXT_PROCESS_ID = 1;

var FnHandler = function(f, type, loc, procId) {
  this.f = f;
  this.type = type;

  this.procId = procId;
  this.loc = loc;
  this.started = Date.now();
};

FnHandler.prototype.is_active = function() {
  return true;
};

FnHandler.prototype.commit = function() {
  return this.f;
};

function put_then_callback(channel, value, callback, loc, procId) {
  var result = channel._put(value, new FnHandler(callback, 'put', loc, procId));
  if (result) {
    callback(result.value);
  }
}

function take_then_callback(channel, callback, loc, procId) {
  var result = channel._take(new FnHandler(callback, 'take', loc, procId));
  if (result) {
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

var Instruction = function(op, data, loc) {
  this.op = op;
  this.data = data;
  this.loc = loc;
};

var TAKE = "take";
var PUT = "put";
var SLEEP = "sleep";
var ALTS = "alts";

// TODO FIX XXX: This is a (probably) temporary hack to avoid blowing
// up the stack, but it means double queueing when the value is not
// immediately available
Process.prototype._continue = function(response) {
  var self = this;
  dispatch.run(function() {
    self.run(response);
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

Process.prototype.run = function(response) {
  if (this.finished) {
    return;
  }

  // TODO: Shouldn't we (optionally) stop error propagation here (and
  // signal the error through a channel or something)? Otherwise the
  // uncaught exception will crash some runtimes (e.g. Node)
  var iter = this.gen.next(response);
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
      }, ins.loc, this.id);
      break;

    case TAKE:
      var channel = ins.data;
      take_then_callback(channel, function(value) {
        self._continue(value);
      }, ins.loc, this.id);
      break;

    case SLEEP:
      var msecs = ins.data;
      var procId = this.id;
      var started = Date.now();

      var n = Date.now();
      var id = Math.random() * 1000 | 0;
      dispatch.queue_delay(function() {
        recorder.addAction({
          type: 'slept',
          procId: procId,
          loc: ins.loc,
          sleepTime: Date.now() - started
        });
        console.log('slept for ' + (Date.now() - n) +
                    ', supposed to sleep for ' + msecs);
        self.run(null);
      }, msecs);
      break;

    case ALTS:
      select.do_alts(ins.data.operations, function(result) {
        self._continue(result);
      }, ins.data.options);
      break;
    }
  }
  else if(ins instanceof Channel) {
    var channel = ins;
    take_then_callback(channel, function(value) {
      self._continue(value);
    }, {
      file: null,
      line: null,
      column: null
    }, this.id);
  }
  else {
    this._continue(ins);
  }
};

function take(channel) {
  return new Instruction(TAKE, channel, recorder.getUserFrame());
}

function put(channel, value) {
  return new Instruction(PUT, {
    channel: channel,
    value: value
  }, recorder.getUserFrame());
}

function sleep(msecs) {
  return new Instruction(SLEEP, msecs, recorder.getUserFrame());
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
exports.sleep = sleep;
exports.alts = alts;

exports.Process = Process;
