"use strict";

var buffers = require("./buffers");
var dispatch = require("./dispatch");
var recorder = require("./record");

var MAX_DIRTY = 64;
var MAX_QUEUE_SIZE = 1024;

var CLOSED = null;

function makeBufferedValue(value, procId) {
  return { value: value,
           time: Date.now(),
           procId: procId,
           blockedTime: 0 };
}

var Box = function(value) {
  this.value = value;
};

var PutBox = function(handler, value) {
  this.handler = handler;
  this.value = value;
};

var Channel = function(takes, puts, buf) {
  this.buf = buf;
  this.takes = takes;
  this.puts = puts;

  this.dirty_takes = 0;
  this.dirty_puts = 0;
  this.closed = false;
};

Channel.prototype._put = function(value, handler) {
  if (value === CLOSED) {
    throw new Error("Cannot put CLOSED on a channel.");
  }

  if (this.closed || !handler.is_active()) {
    return new Box(!this.closed);
  }

  while (true) {
    var taker = this.takes.pop();
    if (taker !== buffers.EMPTY) {
      if (taker.is_active()) {
        var callback = taker.commit();
        handler.commit();
        dispatch.run(function() {
          callback(value);
        });

        var now = Date.now();
        recorder.addAction({
          type: 'putting',
          putId: handler.procId,
          putLoc: handler.loc,
          putTime: now,
          takeId: taker.procId,
          takeLoc: taker.loc,
          takeTime: now,
          isAlt: taker.isAlt,
          value: '' + value,
          blockedTime: Date.now() - taker.started,
        });
        return new Box(true);
      } else {
        continue;
      }
    } else {
      if (this.buf) {
        value = makeBufferedValue(value, handler.procId);
        if(!this.buf.is_full()) {
          handler.commit();
          this.buf.add(value);
          return new Box(true);
        }
      }

      if (this.dirty_puts > MAX_DIRTY) {
        this.puts.cleanup(function(putter) {
          return putter.handler.is_active();
        });
        this.dirty_puts = 0;
      } else {
        this.dirty_puts ++;
      }
      if (this.puts.length >= MAX_QUEUE_SIZE) {
        throw new Error("No more than " + MAX_QUEUE_SIZE + " pending puts are allowed on a single channel.");
      }
      recorder.addAction({
        type: 'putting (blocking)',
        loc: handler.loc,
        procId: handler.procId
      });
      this.puts.unbounded_unshift(new PutBox(handler, value));
    }
    break;
  }

  return null;
};

Channel.prototype._take = function(handler) {
  if (!handler.is_active()) {
    return null;
  }

  var putter, put_handler, callback;

  if (this.buf && this.buf.count() > 0) {
    handler.commit();
    var value = this.buf.remove();
    // We need to check pending puts here, other wise they won't
    // be able to proceed until their number reaches MAX_DIRTY
    while (true) {
      putter = this.puts.pop();
      if (putter !== buffers.EMPTY) {
        put_handler = putter.handler;
        if (put_handler.is_active()) {
          callback = put_handler.commit();
          dispatch.run(function() {
            callback(true);
          });

          var blockStarted = putter.value.time;
          putter.value.time = Date.now();
          putter.value.blockedTime = putter.value.time - blockStarted;
          this.buf.add(putter.value);
          break;
        } else {
          continue;
        }
      }
      break;
    }

    recorder.addAction({
      type: 'taking',
      loc: handler.loc,
      takeId: handler.procId,
      takeTime: Date.now(),
      putId: value.procId,
      putTime: value.time,
      value: value.value,
      blockedTime: value.blockedTime || 0
    });
    return new Box(value.value);
  }

  while (true) {
    putter = this.puts.pop();
    if (putter !== buffers.EMPTY) {
      put_handler = putter.handler;
      if (put_handler.is_active()) {
        handler.commit();
        callback = put_handler.commit();
        dispatch.run(function() {
          callback(true);
        });

        var value = putter.value;
        var now = Date.now();
        recorder.addAction({
          type: 'taking',
          takeId: handler.procId,
          takeLoc: handler.loc,
          takeTime: now,
          putId: put_handler.procId,
          putLoc: put_handler.loc,
          putTime: now,
          isAlt: put_handler.isAlt,
          blockedTime: Date.now() - put_handler.started,
          value: '' + value
        });
        return new Box(value);
      } else {
        continue;
      }
    } else {
      if (this.closed) {
        handler.commit();
        return new Box(CLOSED);
      } else {
        if (this.dirty_takes > MAX_DIRTY) {
          this.takes.cleanup(function(handler) {
            return handler.is_active();
          });
          this.dirty_takes = 0;
        } else {
          this.dirty_takes ++;
        }
        if (this.takes.length >= MAX_QUEUE_SIZE) {
          throw new Error("No more than " + MAX_QUEUE_SIZE + " pending takes are allowed on a single channel.");
        }
        recorder.addAction({
          type: 'taking (blocking)',
          loc: handler.loc,
          procId: handler.procId
        });
        this.takes.unbounded_unshift(handler);
      }
    }
    break;
  }

  return null;
};

Channel.prototype.close = function() {
  if (this.closed) {
    return;
  }
  this.closed = true;
  while (true) {
    var taker = this.takes.pop();
    if (taker === buffers.EMPTY) {
      break;
    }
    if (taker.is_active()) {
      recorder.addAction({
        type: this.sleeper ? 'slept' : 'closing',
        procId: taker.procId,
        loc: taker.loc,
        blockedTime: Date.now() - taker.started,
        isAlt: taker.isAlt
      });
      var callback = taker.commit();
      dispatch.run(function() {
        callback(CLOSED);
      });
    }
  }
  // TODO: Tests
  while (true) {
    var putter = this.puts.pop();
    if (putter === buffers.EMPTY) {
      break;
    }
    if (putter.handler.is_active()) {
      recorder.addAction({
        type: this.sleeper ? 'slept' : 'closing',
        procId: putter.handler.procId,
        loc: putter.handler.loc,
        blockedTime: Date.now() - putter.started,
        isAlt: putter.isAlt
      });

      var put_callback = putter.handler.commit();
      dispatch.run(function() {
        put_callback(false);
      });
    }
  }
};


Channel.prototype.is_closed = function() {
  return this.closed;
};


exports.chan = function(buf) {
  return new Channel(buffers.ring(32), buffers.ring(32), buf);
};

exports.Box = Box;
exports.Channel = Channel;
exports.CLOSED = CLOSED;
