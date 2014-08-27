var parsetrace = require("./parsetrace");
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

  addProcessInfo: function(id, loc, source) {
    this.processes[id] = {
      loc: loc,
      source: source
    };

    this.runningProcesses.push(id);
  },

  getUserFrame: function(offset) {
    return parsetrace(new Error()).object().frames[offset || 2];
  }
};

module.exports = recorder;
