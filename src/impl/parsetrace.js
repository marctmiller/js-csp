'use strict';

var f = require('pff');

function parseMessage(line) {
  return line.substring(line.indexOf(':') + 2);
}

function parseFrame(line, options) {
  function atFrame(line) {
    var re = /(.+)@(.+):(\d+):(\d+)/i;
    var match = re.exec(line);

    if(!match && options.strict) {
      throw new Error('Failed to parse frame line: ' + line);
    }

    return {
      function: match[1],
      file: match[2],
      line: parseInt(match[3]),
      column: parseInt(match[4])
    };
  }

  function namedFrame(line) {
    var re = /    at (.+) \((.+):(\d+):(\d+)\)/i;
    var match = re.exec(line);

    if (!match) {
      re = (/    at (.+) \((.+)\)/i);
      match = re.exec(line);

      if(!match && options.strict) {
        throw new Error('Failed to parse frame line: ' + line);
      }
    }

    return {
      function: match[1],
      file: match[2],
      line: parseInt(match[3], 10),
      column: parseInt(match[4], 10)
    };
  }

  function unnamedFrame(line) {
    var re = (/    at (.+):(\d+):(\d+)/i);
    var match = re.exec(line);

    if (!match && options.strict) {
      throw new Error('Failed to parse frame line: ' + line);
    }

    return {
      function: undefined,
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10)
    };
  }

  var frame;
  if(line.indexOf('@') !== -1) {
    frame = atFrame(line);
  }
  else if(line.indexOf('(') !== -1) {
    frame = namedFrame(line);
  }
  else {
    frame = unnamedFrame(line);
  }

  if (!options.sources) { return frame; }
  return frame;
}

function parseSource(frame, line, options) {
  var match = line.match(/^[ ]*(\d+): (.+)$/i);
  frame.source[match[1]] = { code: match[2] };
}

function parseStack(stack, options) {
  var lines = stack.split('\n');
  var message = parseMessage(lines.shift());

  var frames = [];

  lines.forEach(function (line) {
    if (line.indexOf('    at') === 0 ||
        /^.+@/.test(line)) {
      frames.push(parseFrame(line, options));
    } else if (/^[ ]+\d+:/.test(line)) {
      var frame = frames[frames.length - 1];
      frame.source = frame.source || {};
      parseSource(frame, line, options);
    }
  });

  return {
    error: message,
    frames: frames
  };
}

function composeString(trace, options) {
  var result = [ 'Error: ' + trace.error ];
  trace.frames.forEach(function (frame) {
    if (frame.function) {
      result.push(f('    at %s (%s:%s:%s)', frame.function, frame.file, frame.line, frame.column));
    } else {
      result.push(f('    at %s:%s:%s', frame.file, frame.line, frame.column));
    }

    if (options.excludeSources || !frame.source) { return; }

    Object.keys(frame.source).forEach(function (line) {
      var code = frame.source[line].code;
      result.push(f(('            ' + line).slice(-12) + ': %s', code));
    });

  });
  return result.join('\n');
}

module.exports = function (error, options, callback) {

  if (typeof(options) === 'function') {
    callback = options;
    options = undefined;
  }

  options = options || {};
  options.contextSize = options.contextSize || 3;

  var trace = parseStack(error.stack, options);

  return {
    object: function () {
      return trace;
    },

    toString: function (options) {
      options = options || {};
      return composeString(trace, options);
    },

    json: function () {
      return JSON.stringify(trace);
    }
  };
};
