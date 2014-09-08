var dispatch = require("./dispatch");

// Recording

var recorder = {
  actions: [],
  processes: {},
  recording: false,
  runningProcesses: [],
  _onFinished: null,

  startRecording: function() {
    this.actions = [];
    this.processes = {};
    this.runningProcesses = [];
    this.recording = true;
  },

  stopRecording: function() {
    this.recording = false;
    return {
      actions: this.actions,
      processes: this.processes
    };
  },

  getData: function() {
    return {
      actions: this.actions,
      processes: this.processes
    }
  },

  onFinished: function(cb) {
    this._onFinished = cb;
  },

  addAction: function(data) {
    data.time = Date.now();
    this.actions.push(data);

    if(data.type === 'stopping') {
      var idx = this.runningProcesses.indexOf(data.id);
      this.runningProcesses.splice(idx, 1);

      if(!this.runningProcesses.length && this._onFinished) {
        dispatch.run(function() {
          this._onFinished(this.stopRecording());
          this._onFinished = null;
        }.bind(this));
      }
    }
  },

  addProcessInfo: function(id, name, source) {
    this.processes[id] = {
      id: id,
      name: name,
      source: source
    };

    this.runningProcesses.push(id);
  },

  getProcessName: function(offset) {
    var err = new Error();
    if(!err.stack) { return null; }

    var stack = err.stack.split('\n');
    if(stack[0] === 'Error') {
      stack.shift();
    }

    var frame = stack[offset || 2];
    frame = frame.replace(/^\s+at /, '');
    var match = frame.match(/^([\w$]+)/);
    if(!match) { return null; }
    var name = match[1];

    // Hack to avoid showing regenerater-ified call names
    if(name.indexOf('callee') === 0 ||
       name === 'anonymous') {
      return null;
    }

    name = name.split('.');
    return name[name.length - 1];
  }
};

module.exports = recorder;
