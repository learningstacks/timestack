/* */ 
(function(Buffer, process) {
  'use strict';
  function _interopDefault(ex) {
    return 'default' in ex ? ex['default'] : ex;
  }
  var jsExtend = require('js-extend');
  var jsExtend__default = _interopDefault(jsExtend);
  var inherits = _interopDefault(require('inherits'));
  var collections = _interopDefault(require('pouchdb-collections'));
  var events = require('events');
  var getArguments = _interopDefault(require('argsarray'));
  var debug = _interopDefault(require('debug'));
  var pouchCollate = require('pouchdb-collate');
  var pouchCollate__default = _interopDefault(pouchCollate);
  var lie = _interopDefault(require('lie'));
  var scopedEval = _interopDefault(require('scope-eval'));
  var levelup = _interopDefault(require('levelup'));
  var sublevel = _interopDefault(require('level-sublevel/legacy'));
  var through2 = require('through2');
  var Deque = _interopDefault(require('double-ended-queue'));
  var crypto = _interopDefault(require('@empty'));
  var vuvuzela = _interopDefault(require('vuvuzela'));
  var fs = _interopDefault(require('@empty'));
  var path = _interopDefault(require('path'));
  var LevelWriteStream = _interopDefault(require('level-write-stream'));
  var PouchPromise = typeof Promise === 'function' ? Promise : lie;
  function pick(obj, arr) {
    var res = {};
    for (var i = 0,
        len = arr.length; i < len; i++) {
      var prop = arr[i];
      if (prop in obj) {
        res[prop] = obj[prop];
      }
    }
    return res;
  }
  function isBinaryObject(object) {
    return object instanceof Buffer;
  }
  function cloneBinaryObject(object) {
    var copy = new Buffer(object.length);
    object.copy(copy);
    return copy;
  }
  function clone(object) {
    var newObject;
    var i;
    var len;
    if (!object || typeof object !== 'object') {
      return object;
    }
    if (Array.isArray(object)) {
      newObject = [];
      for (i = 0, len = object.length; i < len; i++) {
        newObject[i] = clone(object[i]);
      }
      return newObject;
    }
    if (object instanceof Date) {
      return object.toISOString();
    }
    if (isBinaryObject(object)) {
      return cloneBinaryObject(object);
    }
    newObject = {};
    for (i in object) {
      if (Object.prototype.hasOwnProperty.call(object, i)) {
        var value = clone(object[i]);
        if (typeof value !== 'undefined') {
          newObject[i] = value;
        }
      }
    }
    return newObject;
  }
  function once(fun) {
    var called = false;
    return getArguments(function(args) {
      if (called) {
        throw new Error('once called more than once');
      } else {
        called = true;
        fun.apply(this, args);
      }
    });
  }
  function toPromise(func) {
    return getArguments(function(args) {
      args = clone(args);
      var self = this;
      var tempCB = (typeof args[args.length - 1] === 'function') ? args.pop() : false;
      var usedCB;
      if (tempCB) {
        usedCB = function(err, resp) {
          process.nextTick(function() {
            tempCB(err, resp);
          });
        };
      }
      var promise = new PouchPromise(function(fulfill, reject) {
        var resp;
        try {
          var callback = once(function(err, mesg) {
            if (err) {
              reject(err);
            } else {
              fulfill(mesg);
            }
          });
          args.push(callback);
          resp = func.apply(self, args);
          if (resp && typeof resp.then === 'function') {
            fulfill(resp);
          }
        } catch (e) {
          reject(e);
        }
      });
      if (usedCB) {
        promise.then(function(result) {
          usedCB(null, result);
        }, usedCB);
      }
      return promise;
    });
  }
  var log$2 = debug('pouchdb:api');
  function adapterFun(name, callback) {
    function logApiCall(self, name, args) {
      if (log$2.enabled) {
        var logArgs = [self._db_name, name];
        for (var i = 0; i < args.length - 1; i++) {
          logArgs.push(args[i]);
        }
        log$2.apply(null, logArgs);
        var origCallback = args[args.length - 1];
        args[args.length - 1] = function(err, res) {
          var responseArgs = [self._db_name, name];
          responseArgs = responseArgs.concat(err ? ['error', err] : ['success', res]);
          log$2.apply(null, responseArgs);
          origCallback(err, res);
        };
      }
    }
    return toPromise(getArguments(function(args) {
      if (this._closed) {
        return PouchPromise.reject(new Error('database is closed'));
      }
      var self = this;
      logApiCall(self, name, args);
      if (!this.taskqueue.isReady) {
        return new PouchPromise(function(fulfill, reject) {
          self.taskqueue.addTask(function(failed) {
            if (failed) {
              reject(failed);
            } else {
              fulfill(self[name].apply(self, args));
            }
          });
        });
      }
      return callback.apply(this, args);
    }));
  }
  function upsert(db, docId, diffFun) {
    return new PouchPromise(function(fulfill, reject) {
      db.get(docId, function(err, doc) {
        if (err) {
          if (err.status !== 404) {
            return reject(err);
          }
          doc = {};
        }
        var docRev = doc._rev;
        var newDoc = diffFun(doc);
        if (!newDoc) {
          return fulfill({
            updated: false,
            rev: docRev
          });
        }
        newDoc._id = docId;
        newDoc._rev = docRev;
        fulfill(tryAndPut(db, newDoc, diffFun));
      });
    });
  }
  function tryAndPut(db, doc, diffFun) {
    return db.put(doc).then(function(res) {
      return {
        updated: true,
        rev: res.rev
      };
    }, function(err) {
      if (err.status !== 409) {
        throw err;
      }
      return upsert(db, doc._id, diffFun);
    });
  }
  function winningRev(metadata) {
    var winningId;
    var winningPos;
    var winningDeleted;
    var toVisit = metadata.rev_tree.slice();
    var node;
    while ((node = toVisit.pop())) {
      var tree = node.ids;
      var branches = tree[2];
      var pos = node.pos;
      if (branches.length) {
        for (var i = 0,
            len = branches.length; i < len; i++) {
          toVisit.push({
            pos: pos + 1,
            ids: branches[i]
          });
        }
        continue;
      }
      var deleted = !!tree[1].deleted;
      var id = tree[0];
      if (!winningId || (winningDeleted !== deleted ? winningDeleted : winningPos !== pos ? winningPos < pos : winningId < id)) {
        winningId = id;
        winningPos = pos;
        winningDeleted = deleted;
      }
    }
    return winningPos + '-' + winningId;
  }
  function getTrees(node) {
    return node.ids;
  }
  function isDeleted(metadata, rev) {
    if (!rev) {
      rev = winningRev(metadata);
    }
    var id = rev.substring(rev.indexOf('-') + 1);
    var toVisit = metadata.rev_tree.map(getTrees);
    var tree;
    while ((tree = toVisit.pop())) {
      if (tree[0] === id) {
        return !!tree[1].deleted;
      }
      toVisit = toVisit.concat(tree[2]);
    }
  }
  function evalFilter(input) {
    return scopedEval('return ' + input + ';', {});
  }
  function evalView(input) {
    return new Function('doc', ['var emitted = false;', 'var emit = function (a, b) {', '  emitted = true;', '};', 'var view = ' + input + ';', 'view(doc);', 'if (emitted) {', '  return true;', '}'].join('\n'));
  }
  function parseDesignDocFunctionName(s) {
    if (!s) {
      return null;
    }
    var parts = s.split('/');
    if (parts.length === 2) {
      return parts;
    }
    if (parts.length === 1) {
      return [s, s];
    }
    return null;
  }
  function normalizeDesignDocFunctionName(s) {
    var normalized = parseDesignDocFunctionName(s);
    return normalized ? normalized.join('/') : null;
  }
  function traverseRevTree(revs, callback) {
    var toVisit = revs.slice();
    var node;
    while ((node = toVisit.pop())) {
      var pos = node.pos;
      var tree = node.ids;
      var branches = tree[2];
      var newCtx = callback(branches.length === 0, pos, tree[0], node.ctx, tree[1]);
      for (var i = 0,
          len = branches.length; i < len; i++) {
        toVisit.push({
          pos: pos + 1,
          ids: branches[i],
          ctx: newCtx
        });
      }
    }
  }
  function sortByPos(a, b) {
    return a.pos - b.pos;
  }
  function collectLeaves(revs) {
    var leaves = [];
    traverseRevTree(revs, function(isLeaf, pos, id, acc, opts) {
      if (isLeaf) {
        leaves.push({
          rev: pos + "-" + id,
          pos: pos,
          opts: opts
        });
      }
    });
    leaves.sort(sortByPos).reverse();
    for (var i = 0,
        len = leaves.length; i < len; i++) {
      delete leaves[i].pos;
    }
    return leaves;
  }
  function collectConflicts(metadata) {
    var win = winningRev(metadata);
    var leaves = collectLeaves(metadata.rev_tree);
    var conflicts = [];
    for (var i = 0,
        len = leaves.length; i < len; i++) {
      var leaf = leaves[i];
      if (leaf.rev !== win && !leaf.opts.deleted) {
        conflicts.push(leaf.rev);
      }
    }
    return conflicts;
  }
  inherits(PouchError, Error);
  function PouchError(opts) {
    Error.call(this, opts.reason);
    this.status = opts.status;
    this.name = opts.error;
    this.message = opts.reason;
    this.error = true;
  }
  PouchError.prototype.toString = function() {
    return JSON.stringify({
      status: this.status,
      name: this.name,
      message: this.message,
      reason: this.reason
    });
  };
  var UNAUTHORIZED = new PouchError({
    status: 401,
    error: 'unauthorized',
    reason: "Name or password is incorrect."
  });
  var MISSING_BULK_DOCS = new PouchError({
    status: 400,
    error: 'bad_request',
    reason: "Missing JSON list of 'docs'"
  });
  var MISSING_DOC = new PouchError({
    status: 404,
    error: 'not_found',
    reason: 'missing'
  });
  var REV_CONFLICT = new PouchError({
    status: 409,
    error: 'conflict',
    reason: 'Document update conflict'
  });
  var INVALID_ID = new PouchError({
    status: 400,
    error: 'invalid_id',
    reason: '_id field must contain a string'
  });
  var MISSING_ID = new PouchError({
    status: 412,
    error: 'missing_id',
    reason: '_id is required for puts'
  });
  var RESERVED_ID = new PouchError({
    status: 400,
    error: 'bad_request',
    reason: 'Only reserved document ids may start with underscore.'
  });
  var NOT_OPEN = new PouchError({
    status: 412,
    error: 'precondition_failed',
    reason: 'Database not open'
  });
  var UNKNOWN_ERROR = new PouchError({
    status: 500,
    error: 'unknown_error',
    reason: 'Database encountered an unknown error'
  });
  var BAD_ARG = new PouchError({
    status: 500,
    error: 'badarg',
    reason: 'Some query argument is invalid'
  });
  var INVALID_REQUEST = new PouchError({
    status: 400,
    error: 'invalid_request',
    reason: 'Request was invalid'
  });
  var QUERY_PARSE_ERROR = new PouchError({
    status: 400,
    error: 'query_parse_error',
    reason: 'Some query parameter is invalid'
  });
  var DOC_VALIDATION = new PouchError({
    status: 500,
    error: 'doc_validation',
    reason: 'Bad special document member'
  });
  var BAD_REQUEST = new PouchError({
    status: 400,
    error: 'bad_request',
    reason: 'Something wrong with the request'
  });
  var NOT_AN_OBJECT = new PouchError({
    status: 400,
    error: 'bad_request',
    reason: 'Document must be a JSON object'
  });
  var DB_MISSING = new PouchError({
    status: 404,
    error: 'not_found',
    reason: 'Database not found'
  });
  var IDB_ERROR = new PouchError({
    status: 500,
    error: 'indexed_db_went_bad',
    reason: 'unknown'
  });
  var WSQ_ERROR = new PouchError({
    status: 500,
    error: 'web_sql_went_bad',
    reason: 'unknown'
  });
  var LDB_ERROR = new PouchError({
    status: 500,
    error: 'levelDB_went_went_bad',
    reason: 'unknown'
  });
  var FORBIDDEN = new PouchError({
    status: 403,
    error: 'forbidden',
    reason: 'Forbidden by design doc validate_doc_update function'
  });
  var INVALID_REV = new PouchError({
    status: 400,
    error: 'bad_request',
    reason: 'Invalid rev format'
  });
  var FILE_EXISTS = new PouchError({
    status: 412,
    error: 'file_exists',
    reason: 'The database could not be created, the file already exists.'
  });
  var MISSING_STUB = new PouchError({
    status: 412,
    error: 'missing_stub'
  });
  var INVALID_URL = new PouchError({
    status: 413,
    error: 'invalid_url',
    reason: 'Provided URL is invalid'
  });
  var allErrors = {
    UNAUTHORIZED: UNAUTHORIZED,
    MISSING_BULK_DOCS: MISSING_BULK_DOCS,
    MISSING_DOC: MISSING_DOC,
    REV_CONFLICT: REV_CONFLICT,
    INVALID_ID: INVALID_ID,
    MISSING_ID: MISSING_ID,
    RESERVED_ID: RESERVED_ID,
    NOT_OPEN: NOT_OPEN,
    UNKNOWN_ERROR: UNKNOWN_ERROR,
    BAD_ARG: BAD_ARG,
    INVALID_REQUEST: INVALID_REQUEST,
    QUERY_PARSE_ERROR: QUERY_PARSE_ERROR,
    DOC_VALIDATION: DOC_VALIDATION,
    BAD_REQUEST: BAD_REQUEST,
    NOT_AN_OBJECT: NOT_AN_OBJECT,
    DB_MISSING: DB_MISSING,
    WSQ_ERROR: WSQ_ERROR,
    LDB_ERROR: LDB_ERROR,
    FORBIDDEN: FORBIDDEN,
    INVALID_REV: INVALID_REV,
    FILE_EXISTS: FILE_EXISTS,
    MISSING_STUB: MISSING_STUB,
    IDB_ERROR: IDB_ERROR,
    INVALID_URL: INVALID_URL
  };
  function createError(error, reason, name) {
    function CustomPouchError(reason) {
      for (var p in error) {
        if (typeof error[p] !== 'function') {
          this[p] = error[p];
        }
      }
      if (name !== undefined) {
        this.name = name;
      }
      if (reason !== undefined) {
        this.reason = reason;
      }
    }
    CustomPouchError.prototype = PouchError.prototype;
    return new CustomPouchError(reason);
  }
  var getErrorTypeByProp = function(prop, value, reason) {
    var keys = Object.keys(allErrors).filter(function(key) {
      var error = allErrors[key];
      return typeof error !== 'function' && error[prop] === value;
    });
    var key = reason && keys.filter(function(key) {
      var error = allErrors[key];
      return error.message === reason;
    })[0] || keys[0];
    return (key) ? allErrors[key] : null;
  };
  function generateErrorFromResponse(res) {
    var error,
        errName,
        errType,
        errMsg,
        errReason;
    errName = (res.error === true && typeof res.name === 'string') ? res.name : res.error;
    errReason = res.reason;
    errType = getErrorTypeByProp('name', errName, errReason);
    if (res.missing || errReason === 'missing' || errReason === 'deleted' || errName === 'not_found') {
      errType = MISSING_DOC;
    } else if (errName === 'doc_validation') {
      errType = DOC_VALIDATION;
      errMsg = errReason;
    } else if (errName === 'bad_request' && errType.message !== errReason) {
      errType = BAD_REQUEST;
    }
    if (!errType) {
      errType = getErrorTypeByProp('status', res.status, errReason) || UNKNOWN_ERROR;
    }
    error = createError(errType, errReason, errName);
    if (errMsg) {
      error.message = errMsg;
    }
    if (res.id) {
      error.id = res.id;
    }
    if (res.status) {
      error.status = res.status;
    }
    if (res.missing) {
      error.missing = res.missing;
    }
    return error;
  }
  inherits(Changes$1, events.EventEmitter);
  function Changes$1(db, opts, callback) {
    events.EventEmitter.call(this);
    var self = this;
    this.db = db;
    opts = opts ? clone(opts) : {};
    var complete = opts.complete = once(function(err, resp) {
      if (err) {
        self.emit('error', err);
      } else {
        self.emit('complete', resp);
      }
      self.removeAllListeners();
      db.removeListener('destroyed', onDestroy);
    });
    if (callback) {
      self.on('complete', function(resp) {
        callback(null, resp);
      });
      self.on('error', callback);
    }
    function onDestroy() {
      self.cancel();
    }
    db.once('destroyed', onDestroy);
    opts.onChange = function(change) {
      if (opts.isCancelled) {
        return;
      }
      self.emit('change', change);
      if (self.startSeq && self.startSeq <= change.seq) {
        self.startSeq = false;
      }
    };
    var promise = new PouchPromise(function(fulfill, reject) {
      opts.complete = function(err, res) {
        if (err) {
          reject(err);
        } else {
          fulfill(res);
        }
      };
    });
    self.once('cancel', function() {
      db.removeListener('destroyed', onDestroy);
      opts.complete(null, {status: 'cancelled'});
    });
    this.then = promise.then.bind(promise);
    this['catch'] = promise['catch'].bind(promise);
    this.then(function(result) {
      complete(null, result);
    }, complete);
    if (!db.taskqueue.isReady) {
      db.taskqueue.addTask(function() {
        if (self.isCancelled) {
          self.emit('cancel');
        } else {
          self.doChanges(opts);
        }
      });
    } else {
      self.doChanges(opts);
    }
  }
  Changes$1.prototype.cancel = function() {
    this.isCancelled = true;
    if (this.db.taskqueue.isReady) {
      this.emit('cancel');
    }
  };
  function processChange(doc, metadata, opts) {
    var changeList = [{rev: doc._rev}];
    if (opts.style === 'all_docs') {
      changeList = collectLeaves(metadata.rev_tree).map(function(x) {
        return {rev: x.rev};
      });
    }
    var change = {
      id: metadata.id,
      changes: changeList,
      doc: doc
    };
    if (isDeleted(metadata, doc._rev)) {
      change.deleted = true;
    }
    if (opts.conflicts) {
      change.doc._conflicts = collectConflicts(metadata);
      if (!change.doc._conflicts.length) {
        delete change.doc._conflicts;
      }
    }
    return change;
  }
  Changes$1.prototype.doChanges = function(opts) {
    var self = this;
    var callback = opts.complete;
    opts = clone(opts);
    if ('live' in opts && !('continuous' in opts)) {
      opts.continuous = opts.live;
    }
    opts.processChange = processChange;
    if (opts.since === 'latest') {
      opts.since = 'now';
    }
    if (!opts.since) {
      opts.since = 0;
    }
    if (opts.since === 'now') {
      this.db.info().then(function(info) {
        if (self.isCancelled) {
          callback(null, {status: 'cancelled'});
          return;
        }
        opts.since = info.update_seq;
        self.doChanges(opts);
      }, callback);
      return;
    }
    if (opts.continuous && opts.since !== 'now') {
      this.db.info().then(function(info) {
        self.startSeq = info.update_seq;
      }, function(err) {
        if (err.id === 'idbNull') {
          return;
        }
        throw err;
      });
    }
    if (opts.filter && typeof opts.filter === 'string') {
      if (opts.filter === '_view') {
        opts.view = normalizeDesignDocFunctionName(opts.view);
      } else {
        opts.filter = normalizeDesignDocFunctionName(opts.filter);
      }
      if (this.db.type() !== 'http' && !opts.doc_ids) {
        return this.filterChanges(opts);
      }
    }
    if (!('descending' in opts)) {
      opts.descending = false;
    }
    opts.limit = opts.limit === 0 ? 1 : opts.limit;
    opts.complete = callback;
    var newPromise = this.db._changes(opts);
    if (newPromise && typeof newPromise.cancel === 'function') {
      var cancel = self.cancel;
      self.cancel = getArguments(function(args) {
        newPromise.cancel();
        cancel.apply(this, args);
      });
    }
  };
  Changes$1.prototype.filterChanges = function(opts) {
    var self = this;
    var callback = opts.complete;
    if (opts.filter === '_view') {
      if (!opts.view || typeof opts.view !== 'string') {
        var err = createError(BAD_REQUEST, '`view` filter parameter not found or invalid.');
        return callback(err);
      }
      var viewName = parseDesignDocFunctionName(opts.view);
      this.db.get('_design/' + viewName[0], function(err, ddoc) {
        if (self.isCancelled) {
          return callback(null, {status: 'cancelled'});
        }
        if (err) {
          return callback(generateErrorFromResponse(err));
        }
        var mapFun = ddoc && ddoc.views && ddoc.views[viewName[1]] && ddoc.views[viewName[1]].map;
        if (!mapFun) {
          return callback(createError(MISSING_DOC, (ddoc.views ? 'missing json key: ' + viewName[1] : 'missing json key: views')));
        }
        opts.filter = evalView(mapFun);
        self.doChanges(opts);
      });
    } else {
      var filterName = parseDesignDocFunctionName(opts.filter);
      if (!filterName) {
        return self.doChanges(opts);
      }
      this.db.get('_design/' + filterName[0], function(err, ddoc) {
        if (self.isCancelled) {
          return callback(null, {status: 'cancelled'});
        }
        if (err) {
          return callback(generateErrorFromResponse(err));
        }
        var filterFun = ddoc && ddoc.filters && ddoc.filters[filterName[1]];
        if (!filterFun) {
          return callback(createError(MISSING_DOC, ((ddoc && ddoc.filters) ? 'missing json key: ' + filterName[1] : 'missing json key: filters')));
        }
        opts.filter = evalFilter(filterFun);
        self.doChanges(opts);
      });
    }
  };
  function bulkGet(db, opts, callback) {
    var requests = Array.isArray(opts) ? opts : opts.docs;
    var requestsById = {};
    requests.forEach(function(request) {
      if (request.id in requestsById) {
        requestsById[request.id].push(request);
      } else {
        requestsById[request.id] = [request];
      }
    });
    var numDocs = Object.keys(requestsById).length;
    var numDone = 0;
    var perDocResults = new Array(numDocs);
    function collapseResults() {
      var results = [];
      perDocResults.forEach(function(res) {
        res.docs.forEach(function(info) {
          results.push({
            id: res.id,
            docs: [info]
          });
        });
      });
      callback(null, {results: results});
    }
    function checkDone() {
      if (++numDone === numDocs) {
        collapseResults();
      }
    }
    function gotResult(i, id, docs) {
      perDocResults[i] = {
        id: id,
        docs: docs
      };
      checkDone();
    }
    Object.keys(requestsById).forEach(function(docId, i) {
      var docRequests = requestsById[docId];
      var docOpts = pick(docRequests[0], ['atts_since', 'attachments']);
      docOpts.open_revs = docRequests.map(function(request) {
        return request.rev;
      });
      docOpts.open_revs = docOpts.open_revs.filter(function(e) {
        return e;
      });
      var formatResult = function(result) {
        return result;
      };
      if (docOpts.open_revs.length === 0) {
        delete docOpts.open_revs;
        formatResult = function(result) {
          return [{ok: result}];
        };
      }
      ['revs', 'attachments', 'binary'].forEach(function(param) {
        if (param in opts) {
          docOpts[param] = opts[param];
        }
      });
      db.get(docId, docOpts, function(err, res) {
        gotResult(i, docId, err ? [{error: err}] : formatResult(res));
      });
    });
  }
  function isLocalId(id) {
    return (/^_local/).test(id);
  }
  function rootToLeaf(revs) {
    var paths = [];
    var toVisit = revs.slice();
    var node;
    while ((node = toVisit.pop())) {
      var pos = node.pos;
      var tree = node.ids;
      var id = tree[0];
      var opts = tree[1];
      var branches = tree[2];
      var isLeaf = branches.length === 0;
      var history = node.history ? node.history.slice() : [];
      history.push({
        id: id,
        opts: opts
      });
      if (isLeaf) {
        paths.push({
          pos: (pos + 1 - history.length),
          ids: history
        });
      }
      for (var i = 0,
          len = branches.length; i < len; i++) {
        toVisit.push({
          pos: pos + 1,
          ids: branches[i],
          history: history
        });
      }
    }
    return paths.reverse();
  }
  var chars = ('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz').split('');
  function getValue(radix) {
    return 0 | Math.random() * radix;
  }
  function uuid(len, radix) {
    radix = radix || chars.length;
    var out = '';
    var i = -1;
    if (len) {
      while (++i < len) {
        out += chars[getValue(radix)];
      }
      return out;
    }
    while (++i < 36) {
      switch (i) {
        case 8:
        case 13:
        case 18:
        case 23:
          out += '-';
          break;
        case 19:
          out += chars[(getValue(16) & 0x3) | 0x8];
          break;
        default:
          out += chars[getValue(16)];
      }
    }
    return out;
  }
  function toObject(array) {
    return array.reduce(function(obj, item) {
      obj[item] = true;
      return obj;
    }, {});
  }
  var reservedWords = toObject(['_id', '_rev', '_attachments', '_deleted', '_revisions', '_revs_info', '_conflicts', '_deleted_conflicts', '_local_seq', '_rev_tree', '_replication_id', '_replication_state', '_replication_state_time', '_replication_state_reason', '_replication_stats', '_removed']);
  var dataWords = toObject(['_attachments', '_replication_id', '_replication_state', '_replication_state_time', '_replication_state_reason', '_replication_stats']);
  function invalidIdError(id) {
    var err;
    if (!id) {
      err = createError(MISSING_ID);
    } else if (typeof id !== 'string') {
      err = createError(INVALID_ID);
    } else if (/^_/.test(id) && !(/^_(design|local)/).test(id)) {
      err = createError(RESERVED_ID);
    }
    if (err) {
      throw err;
    }
  }
  function parseRevisionInfo(rev) {
    if (!/^\d+\-./.test(rev)) {
      return createError(INVALID_REV);
    }
    var idx = rev.indexOf('-');
    var left = rev.substring(0, idx);
    var right = rev.substring(idx + 1);
    return {
      prefix: parseInt(left, 10),
      id: right
    };
  }
  function makeRevTreeFromRevisions(revisions, opts) {
    var pos = revisions.start - revisions.ids.length + 1;
    var revisionIds = revisions.ids;
    var ids = [revisionIds[0], opts, []];
    for (var i = 1,
        len = revisionIds.length; i < len; i++) {
      ids = [revisionIds[i], {status: 'missing'}, [ids]];
    }
    return [{
      pos: pos,
      ids: ids
    }];
  }
  function parseDoc(doc, newEdits) {
    var nRevNum;
    var newRevId;
    var revInfo;
    var opts = {status: 'available'};
    if (doc._deleted) {
      opts.deleted = true;
    }
    if (newEdits) {
      if (!doc._id) {
        doc._id = uuid();
      }
      newRevId = uuid(32, 16).toLowerCase();
      if (doc._rev) {
        revInfo = parseRevisionInfo(doc._rev);
        if (revInfo.error) {
          return revInfo;
        }
        doc._rev_tree = [{
          pos: revInfo.prefix,
          ids: [revInfo.id, {status: 'missing'}, [[newRevId, opts, []]]]
        }];
        nRevNum = revInfo.prefix + 1;
      } else {
        doc._rev_tree = [{
          pos: 1,
          ids: [newRevId, opts, []]
        }];
        nRevNum = 1;
      }
    } else {
      if (doc._revisions) {
        doc._rev_tree = makeRevTreeFromRevisions(doc._revisions, opts);
        nRevNum = doc._revisions.start;
        newRevId = doc._revisions.ids[0];
      }
      if (!doc._rev_tree) {
        revInfo = parseRevisionInfo(doc._rev);
        if (revInfo.error) {
          return revInfo;
        }
        nRevNum = revInfo.prefix;
        newRevId = revInfo.id;
        doc._rev_tree = [{
          pos: nRevNum,
          ids: [newRevId, opts, []]
        }];
      }
    }
    invalidIdError(doc._id);
    doc._rev = nRevNum + '-' + newRevId;
    var result = {
      metadata: {},
      data: {}
    };
    for (var key in doc) {
      if (Object.prototype.hasOwnProperty.call(doc, key)) {
        var specialKey = key[0] === '_';
        if (specialKey && !reservedWords[key]) {
          var error = createError(DOC_VALIDATION, key);
          error.message = DOC_VALIDATION.message + ': ' + key;
          throw error;
        } else if (specialKey && !dataWords[key]) {
          result.metadata[key.slice(1)] = doc[key];
        } else {
          result.data[key] = doc[key];
        }
      }
    }
    return result;
  }
  function compare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  function arrayFirst(arr, callback) {
    for (var i = 0; i < arr.length; i++) {
      if (callback(arr[i], i) === true) {
        return arr[i];
      }
    }
  }
  function yankError(callback) {
    return function(err, results) {
      if (err || (results[0] && results[0].error)) {
        callback(err || results[0]);
      } else {
        callback(null, results.length ? results[0] : results);
      }
    };
  }
  function cleanDocs(docs) {
    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i];
      if (doc._deleted) {
        delete doc._attachments;
      } else if (doc._attachments) {
        var atts = Object.keys(doc._attachments);
        for (var j = 0; j < atts.length; j++) {
          var att = atts[j];
          doc._attachments[att] = pick(doc._attachments[att], ['data', 'digest', 'content_type', 'length', 'revpos', 'stub']);
        }
      }
    }
  }
  function compareByIdThenRev(a, b) {
    var idCompare = compare(a._id, b._id);
    if (idCompare !== 0) {
      return idCompare;
    }
    var aStart = a._revisions ? a._revisions.start : 0;
    var bStart = b._revisions ? b._revisions.start : 0;
    return compare(aStart, bStart);
  }
  function computeHeight(revs) {
    var height = {};
    var edges = [];
    traverseRevTree(revs, function(isLeaf, pos, id, prnt) {
      var rev = pos + "-" + id;
      if (isLeaf) {
        height[rev] = 0;
      }
      if (prnt !== undefined) {
        edges.push({
          from: prnt,
          to: rev
        });
      }
      return rev;
    });
    edges.reverse();
    edges.forEach(function(edge) {
      if (height[edge.from] === undefined) {
        height[edge.from] = 1 + height[edge.to];
      } else {
        height[edge.from] = Math.min(height[edge.from], 1 + height[edge.to]);
      }
    });
    return height;
  }
  function allDocsKeysQuery(api, opts, callback) {
    var keys = ('limit' in opts) ? opts.keys.slice(opts.skip, opts.limit + opts.skip) : (opts.skip > 0) ? opts.keys.slice(opts.skip) : opts.keys;
    if (opts.descending) {
      keys.reverse();
    }
    if (!keys.length) {
      return api._allDocs({limit: 0}, callback);
    }
    var finalResults = {offset: opts.skip};
    return PouchPromise.all(keys.map(function(key) {
      var subOpts = jsExtend.extend({
        key: key,
        deleted: 'ok'
      }, opts);
      ['limit', 'skip', 'keys'].forEach(function(optKey) {
        delete subOpts[optKey];
      });
      return new PouchPromise(function(resolve, reject) {
        api._allDocs(subOpts, function(err, res) {
          if (err) {
            return reject(err);
          }
          finalResults.total_rows = res.total_rows;
          resolve(res.rows[0] || {
            key: key,
            error: 'not_found'
          });
        });
      });
    })).then(function(results) {
      finalResults.rows = results;
      return finalResults;
    });
  }
  function doNextCompaction(self) {
    var task = self._compactionQueue[0];
    var opts = task.opts;
    var callback = task.callback;
    self.get('_local/compaction').catch(function() {
      return false;
    }).then(function(doc) {
      if (doc && doc.last_seq) {
        opts.last_seq = doc.last_seq;
      }
      self._compact(opts, function(err, res) {
        if (err) {
          callback(err);
        } else {
          callback(null, res);
        }
        process.nextTick(function() {
          self._compactionQueue.shift();
          if (self._compactionQueue.length) {
            doNextCompaction(self);
          }
        });
      });
    });
  }
  function attachmentNameError(name) {
    if (name.charAt(0) === '_') {
      return name + 'is not a valid attachment name, attachment ' + 'names cannot start with \'_\'';
    }
    return false;
  }
  inherits(AbstractPouchDB, events.EventEmitter);
  function AbstractPouchDB() {
    events.EventEmitter.call(this);
  }
  AbstractPouchDB.prototype.post = adapterFun('post', function(doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      return callback(createError(NOT_AN_OBJECT));
    }
    this.bulkDocs({docs: [doc]}, opts, yankError(callback));
  });
  AbstractPouchDB.prototype.put = adapterFun('put', getArguments(function(args) {
    var temp,
        temptype,
        opts,
        callback;
    var doc = args.shift();
    var id = '_id' in doc;
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      callback = args.pop();
      return callback(createError(NOT_AN_OBJECT));
    }
    while (true) {
      temp = args.shift();
      temptype = typeof temp;
      if (temptype === "string" && !id) {
        doc._id = temp;
        id = true;
      } else if (temptype === "string" && id && !('_rev' in doc)) {
        doc._rev = temp;
      } else if (temptype === "object") {
        opts = temp;
      } else if (temptype === "function") {
        callback = temp;
      }
      if (!args.length) {
        break;
      }
    }
    opts = opts || {};
    invalidIdError(doc._id);
    if (isLocalId(doc._id) && typeof this._putLocal === 'function') {
      if (doc._deleted) {
        return this._removeLocal(doc, callback);
      } else {
        return this._putLocal(doc, callback);
      }
    }
    this.bulkDocs({docs: [doc]}, opts, yankError(callback));
  }));
  AbstractPouchDB.prototype.putAttachment = adapterFun('putAttachment', function(docId, attachmentId, rev, blob, type, callback) {
    var api = this;
    if (typeof type === 'function') {
      callback = type;
      type = blob;
      blob = rev;
      rev = null;
    }
    if (typeof type === 'undefined') {
      type = blob;
      blob = rev;
      rev = null;
    }
    function createAttachment(doc) {
      doc._attachments = doc._attachments || {};
      doc._attachments[attachmentId] = {
        content_type: type,
        data: blob
      };
      return api.put(doc);
    }
    return api.get(docId).then(function(doc) {
      if (doc._rev !== rev) {
        throw createError(REV_CONFLICT);
      }
      return createAttachment(doc);
    }, function(err) {
      if (err.reason === MISSING_DOC.message) {
        return createAttachment({_id: docId});
      } else {
        throw err;
      }
    });
  });
  AbstractPouchDB.prototype.removeAttachment = adapterFun('removeAttachment', function(docId, attachmentId, rev, callback) {
    var self = this;
    self.get(docId, function(err, obj) {
      if (err) {
        callback(err);
        return;
      }
      if (obj._rev !== rev) {
        callback(createError(REV_CONFLICT));
        return;
      }
      if (!obj._attachments) {
        return callback();
      }
      delete obj._attachments[attachmentId];
      if (Object.keys(obj._attachments).length === 0) {
        delete obj._attachments;
      }
      self.put(obj, callback);
    });
  });
  AbstractPouchDB.prototype.remove = adapterFun('remove', function(docOrId, optsOrRev, opts, callback) {
    var doc;
    if (typeof optsOrRev === 'string') {
      doc = {
        _id: docOrId,
        _rev: optsOrRev
      };
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
    } else {
      doc = docOrId;
      if (typeof optsOrRev === 'function') {
        callback = optsOrRev;
        opts = {};
      } else {
        callback = opts;
        opts = optsOrRev;
      }
    }
    opts = opts || {};
    opts.was_delete = true;
    var newDoc = {
      _id: doc._id,
      _rev: (doc._rev || opts.rev)
    };
    newDoc._deleted = true;
    if (isLocalId(newDoc._id) && typeof this._removeLocal === 'function') {
      return this._removeLocal(doc, callback);
    }
    this.bulkDocs({docs: [newDoc]}, opts, yankError(callback));
  });
  AbstractPouchDB.prototype.revsDiff = adapterFun('revsDiff', function(req, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    var ids = Object.keys(req);
    if (!ids.length) {
      return callback(null, {});
    }
    var count = 0;
    var missing = new collections.Map();
    function addToMissing(id, revId) {
      if (!missing.has(id)) {
        missing.set(id, {missing: []});
      }
      missing.get(id).missing.push(revId);
    }
    function processDoc(id, rev_tree) {
      var missingForId = req[id].slice(0);
      traverseRevTree(rev_tree, function(isLeaf, pos, revHash, ctx, opts) {
        var rev = pos + '-' + revHash;
        var idx = missingForId.indexOf(rev);
        if (idx === -1) {
          return;
        }
        missingForId.splice(idx, 1);
        if (opts.status !== 'available') {
          addToMissing(id, rev);
        }
      });
      missingForId.forEach(function(rev) {
        addToMissing(id, rev);
      });
    }
    ids.map(function(id) {
      this._getRevisionTree(id, function(err, rev_tree) {
        if (err && err.status === 404 && err.message === 'missing') {
          missing.set(id, {missing: req[id]});
        } else if (err) {
          return callback(err);
        } else {
          processDoc(id, rev_tree);
        }
        if (++count === ids.length) {
          var missingObj = {};
          missing.forEach(function(value, key) {
            missingObj[key] = value;
          });
          return callback(null, missingObj);
        }
      });
    }, this);
  });
  AbstractPouchDB.prototype.bulkGet = adapterFun('bulkGet', function(opts, callback) {
    bulkGet(this, opts, callback);
  });
  AbstractPouchDB.prototype.compactDocument = adapterFun('compactDocument', function(docId, maxHeight, callback) {
    var self = this;
    this._getRevisionTree(docId, function(err, revTree) {
      if (err) {
        return callback(err);
      }
      var height = computeHeight(revTree);
      var candidates = [];
      var revs = [];
      Object.keys(height).forEach(function(rev) {
        if (height[rev] > maxHeight) {
          candidates.push(rev);
        }
      });
      traverseRevTree(revTree, function(isLeaf, pos, revHash, ctx, opts) {
        var rev = pos + '-' + revHash;
        if (opts.status === 'available' && candidates.indexOf(rev) !== -1) {
          revs.push(rev);
        }
      });
      self._doCompaction(docId, revs, callback);
    });
  });
  AbstractPouchDB.prototype.compact = adapterFun('compact', function(opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    var self = this;
    opts = opts || {};
    self._compactionQueue = self._compactionQueue || [];
    self._compactionQueue.push({
      opts: opts,
      callback: callback
    });
    if (self._compactionQueue.length === 1) {
      doNextCompaction(self);
    }
  });
  AbstractPouchDB.prototype._compact = function(opts, callback) {
    var self = this;
    var changesOpts = {
      return_docs: false,
      last_seq: opts.last_seq || 0
    };
    var promises = [];
    function onChange(row) {
      promises.push(self.compactDocument(row.id, 0));
    }
    function onComplete(resp) {
      var lastSeq = resp.last_seq;
      PouchPromise.all(promises).then(function() {
        return upsert(self, '_local/compaction', function deltaFunc(doc) {
          if (!doc.last_seq || doc.last_seq < lastSeq) {
            doc.last_seq = lastSeq;
            return doc;
          }
          return false;
        });
      }).then(function() {
        callback(null, {ok: true});
      }).catch(callback);
    }
    self.changes(changesOpts).on('change', onChange).on('complete', onComplete).on('error', callback);
  };
  AbstractPouchDB.prototype.get = adapterFun('get', function(id, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (typeof id !== 'string') {
      return callback(createError(INVALID_ID));
    }
    if (isLocalId(id) && typeof this._getLocal === 'function') {
      return this._getLocal(id, callback);
    }
    var leaves = [],
        self = this;
    function finishOpenRevs() {
      var result = [];
      var count = leaves.length;
      if (!count) {
        return callback(null, result);
      }
      leaves.forEach(function(leaf) {
        self.get(id, {
          rev: leaf,
          revs: opts.revs,
          attachments: opts.attachments
        }, function(err, doc) {
          if (!err) {
            result.push({ok: doc});
          } else {
            result.push({missing: leaf});
          }
          count--;
          if (!count) {
            callback(null, result);
          }
        });
      });
    }
    if (opts.open_revs) {
      if (opts.open_revs === "all") {
        this._getRevisionTree(id, function(err, rev_tree) {
          if (err) {
            return callback(err);
          }
          leaves = collectLeaves(rev_tree).map(function(leaf) {
            return leaf.rev;
          });
          finishOpenRevs();
        });
      } else {
        if (Array.isArray(opts.open_revs)) {
          leaves = opts.open_revs;
          for (var i = 0; i < leaves.length; i++) {
            var l = leaves[i];
            if (!(typeof(l) === "string" && /^\d+-/.test(l))) {
              return callback(createError(INVALID_REV));
            }
          }
          finishOpenRevs();
        } else {
          return callback(createError(UNKNOWN_ERROR, 'function_clause'));
        }
      }
      return;
    }
    return this._get(id, opts, function(err, result) {
      if (err) {
        return callback(err);
      }
      var doc = result.doc;
      var metadata = result.metadata;
      var ctx = result.ctx;
      if (opts.conflicts) {
        var conflicts = collectConflicts(metadata);
        if (conflicts.length) {
          doc._conflicts = conflicts;
        }
      }
      if (isDeleted(metadata, doc._rev)) {
        doc._deleted = true;
      }
      if (opts.revs || opts.revs_info) {
        var paths = rootToLeaf(metadata.rev_tree);
        var path = arrayFirst(paths, function(arr) {
          return arr.ids.map(function(x) {
            return x.id;
          }).indexOf(doc._rev.split('-')[1]) !== -1;
        });
        var indexOfRev = path.ids.map(function(x) {
          return x.id;
        }).indexOf(doc._rev.split('-')[1]) + 1;
        var howMany = path.ids.length - indexOfRev;
        path.ids.splice(indexOfRev, howMany);
        path.ids.reverse();
        if (opts.revs) {
          doc._revisions = {
            start: (path.pos + path.ids.length) - 1,
            ids: path.ids.map(function(rev) {
              return rev.id;
            })
          };
        }
        if (opts.revs_info) {
          var pos = path.pos + path.ids.length;
          doc._revs_info = path.ids.map(function(rev) {
            pos--;
            return {
              rev: pos + '-' + rev.id,
              status: rev.opts.status
            };
          });
        }
      }
      if (opts.attachments && doc._attachments) {
        var attachments = doc._attachments;
        var count = Object.keys(attachments).length;
        if (count === 0) {
          return callback(null, doc);
        }
        Object.keys(attachments).forEach(function(key) {
          this._getAttachment(attachments[key], {
            binary: opts.binary,
            ctx: ctx
          }, function(err, data) {
            var att = doc._attachments[key];
            att.data = data;
            delete att.stub;
            delete att.length;
            if (!--count) {
              callback(null, doc);
            }
          });
        }, self);
      } else {
        if (doc._attachments) {
          for (var key in doc._attachments) {
            if (doc._attachments.hasOwnProperty(key)) {
              doc._attachments[key].stub = true;
            }
          }
        }
        callback(null, doc);
      }
    });
  });
  AbstractPouchDB.prototype.getAttachment = adapterFun('getAttachment', function(docId, attachmentId, opts, callback) {
    var self = this;
    if (opts instanceof Function) {
      callback = opts;
      opts = {};
    }
    this._get(docId, opts, function(err, res) {
      if (err) {
        return callback(err);
      }
      if (res.doc._attachments && res.doc._attachments[attachmentId]) {
        opts.ctx = res.ctx;
        opts.binary = true;
        self._getAttachment(res.doc._attachments[attachmentId], opts, callback);
      } else {
        return callback(createError(MISSING_DOC));
      }
    });
  });
  AbstractPouchDB.prototype.allDocs = adapterFun('allDocs', function(opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts.skip = typeof opts.skip !== 'undefined' ? opts.skip : 0;
    if (opts.start_key) {
      opts.startkey = opts.start_key;
    }
    if (opts.end_key) {
      opts.endkey = opts.end_key;
    }
    if ('keys' in opts) {
      if (!Array.isArray(opts.keys)) {
        return callback(new TypeError('options.keys must be an array'));
      }
      var incompatibleOpt = ['startkey', 'endkey', 'key'].filter(function(incompatibleOpt) {
        return incompatibleOpt in opts;
      })[0];
      if (incompatibleOpt) {
        callback(createError(QUERY_PARSE_ERROR, 'Query parameter `' + incompatibleOpt + '` is not compatible with multi-get'));
        return;
      }
      if (this.type() !== 'http') {
        return allDocsKeysQuery(this, opts, callback);
      }
    }
    return this._allDocs(opts, callback);
  });
  AbstractPouchDB.prototype.changes = function(opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    return new Changes$1(this, opts, callback);
  };
  AbstractPouchDB.prototype.close = adapterFun('close', function(callback) {
    this._closed = true;
    return this._close(callback);
  });
  AbstractPouchDB.prototype.info = adapterFun('info', function(callback) {
    var self = this;
    this._info(function(err, info) {
      if (err) {
        return callback(err);
      }
      info.db_name = info.db_name || self._db_name;
      info.auto_compaction = !!(self.auto_compaction && self.type() !== 'http');
      info.adapter = self.type();
      callback(null, info);
    });
  });
  AbstractPouchDB.prototype.id = adapterFun('id', function(callback) {
    return this._id(callback);
  });
  AbstractPouchDB.prototype.type = function() {
    return (typeof this._type === 'function') ? this._type() : this.adapter;
  };
  AbstractPouchDB.prototype.bulkDocs = adapterFun('bulkDocs', function(req, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = opts || {};
    if (Array.isArray(req)) {
      req = {docs: req};
    }
    if (!req || !req.docs || !Array.isArray(req.docs)) {
      return callback(createError(MISSING_BULK_DOCS));
    }
    for (var i = 0; i < req.docs.length; ++i) {
      if (typeof req.docs[i] !== 'object' || Array.isArray(req.docs[i])) {
        return callback(createError(NOT_AN_OBJECT));
      }
    }
    var attachmentError;
    req.docs.forEach(function(doc) {
      if (doc._attachments) {
        Object.keys(doc._attachments).forEach(function(name) {
          attachmentError = attachmentError || attachmentNameError(name);
        });
      }
    });
    if (attachmentError) {
      return callback(createError(BAD_REQUEST, attachmentError));
    }
    if (!('new_edits' in opts)) {
      if ('new_edits' in req) {
        opts.new_edits = req.new_edits;
      } else {
        opts.new_edits = true;
      }
    }
    if (!opts.new_edits && this.type() !== 'http') {
      req.docs.sort(compareByIdThenRev);
    }
    cleanDocs(req.docs);
    return this._bulkDocs(req, opts, function(err, res) {
      if (err) {
        return callback(err);
      }
      if (!opts.new_edits) {
        res = res.filter(function(x) {
          return x.error;
        });
      }
      callback(null, res);
    });
  });
  AbstractPouchDB.prototype.registerDependentDatabase = adapterFun('registerDependentDatabase', function(dependentDb, callback) {
    var depDB = new this.constructor(dependentDb, this.__opts);
    function diffFun(doc) {
      doc.dependentDbs = doc.dependentDbs || {};
      if (doc.dependentDbs[dependentDb]) {
        return false;
      }
      doc.dependentDbs[dependentDb] = true;
      return doc;
    }
    upsert(this, '_local/_pouch_dependentDbs', diffFun).then(function() {
      callback(null, {db: depDB});
    }).catch(callback);
  });
  AbstractPouchDB.prototype.destroy = adapterFun('destroy', function(opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    var self = this;
    var usePrefix = 'use_prefix' in self ? self.use_prefix : true;
    function destroyDb() {
      self._destroy(opts, function(err, resp) {
        if (err) {
          return callback(err);
        }
        self.emit('destroyed');
        callback(null, resp || {'ok': true});
      });
    }
    if (self.type() === 'http') {
      return destroyDb();
    }
    self.get('_local/_pouch_dependentDbs', function(err, localDoc) {
      if (err) {
        if (err.status !== 404) {
          return callback(err);
        } else {
          return destroyDb();
        }
      }
      var dependentDbs = localDoc.dependentDbs;
      var PouchDB = self.constructor;
      var deletedMap = Object.keys(dependentDbs).map(function(name) {
        var trueName = usePrefix ? name.replace(new RegExp('^' + PouchDB.prefix), '') : name;
        return new PouchDB(trueName, self.__opts).destroy();
      });
      PouchPromise.all(deletedMap).then(destroyDb, callback);
    });
  });
  function TaskQueue$1() {
    this.isReady = false;
    this.failed = false;
    this.queue = [];
  }
  TaskQueue$1.prototype.execute = function() {
    var fun;
    if (this.failed) {
      while ((fun = this.queue.shift())) {
        fun(this.failed);
      }
    } else {
      while ((fun = this.queue.shift())) {
        fun();
      }
    }
  };
  TaskQueue$1.prototype.fail = function(err) {
    this.failed = err;
    this.execute();
  };
  TaskQueue$1.prototype.ready = function(db) {
    this.isReady = true;
    this.db = db;
    this.execute();
  };
  TaskQueue$1.prototype.addTask = function(fun) {
    this.queue.push(fun);
    if (this.failed) {
      this.execute();
    }
  };
  function defaultCallback(err) {
    if (err && global.debug) {
      console.error(err);
    }
  }
  function prepareForDestruction(self, opts) {
    var name = opts.originalName;
    var ctor = self.constructor;
    var destructionListeners = ctor._destructionListeners;
    function onDestroyed() {
      ctor.emit('destroyed', name);
      ctor.emit(name, 'destroyed');
    }
    function onConstructorDestroyed() {
      self.removeListener('destroyed', onDestroyed);
      self.emit('destroyed', self);
    }
    self.once('destroyed', onDestroyed);
    if (!destructionListeners.has(name)) {
      destructionListeners.set(name, []);
    }
    destructionListeners.get(name).push(onConstructorDestroyed);
  }
  inherits(PouchDB, AbstractPouchDB);
  function PouchDB(name, opts, callback) {
    if (!(this instanceof PouchDB)) {
      return new PouchDB(name, opts, callback);
    }
    var self = this;
    if (typeof opts === 'function' || typeof opts === 'undefined') {
      callback = opts;
      opts = {};
    }
    if (name && typeof name === 'object') {
      opts = name;
      name = undefined;
    }
    if (typeof callback === 'undefined') {
      callback = defaultCallback;
    }
    name = name || opts.name;
    opts = clone(opts);
    delete opts.name;
    this.__opts = opts;
    var oldCB = callback;
    self.auto_compaction = opts.auto_compaction;
    self.prefix = PouchDB.prefix;
    AbstractPouchDB.call(self);
    self.taskqueue = new TaskQueue$1();
    var promise = new PouchPromise(function(fulfill, reject) {
      callback = function(err, resp) {
        if (err) {
          return reject(err);
        }
        delete resp.then;
        fulfill(resp);
      };
      opts = clone(opts);
      var originalName = opts.name || name;
      var backend,
          error;
      (function() {
        try {
          if (typeof originalName !== 'string') {
            error = new Error('Missing/invalid DB name');
            error.code = 400;
            throw error;
          }
          backend = PouchDB.parseAdapter(originalName, opts);
          opts.originalName = originalName;
          opts.name = backend.name;
          if (opts.prefix && backend.adapter !== 'http' && backend.adapter !== 'https') {
            opts.name = opts.prefix + opts.name;
          }
          opts.adapter = opts.adapter || backend.adapter;
          self._adapter = opts.adapter;
          debug('pouchdb:adapter')('Picked adapter: ' + opts.adapter);
          self._db_name = originalName;
          if (!PouchDB.adapters[opts.adapter]) {
            error = new Error('Adapter is missing');
            error.code = 404;
            throw error;
          }
          if (!PouchDB.adapters[opts.adapter].valid()) {
            error = new Error('Invalid Adapter');
            error.code = 404;
            throw error;
          }
        } catch (err) {
          self.taskqueue.fail(err);
        }
      }());
      if (error) {
        return reject(error);
      }
      self.adapter = opts.adapter;
      self.replicate = {};
      self.replicate.from = function(url, opts, callback) {
        return self.constructor.replicate(url, self, opts, callback);
      };
      self.replicate.to = function(url, opts, callback) {
        return self.constructor.replicate(self, url, opts, callback);
      };
      self.sync = function(dbName, opts, callback) {
        return self.constructor.sync(self, dbName, opts, callback);
      };
      self.replicate.sync = self.sync;
      PouchDB.adapters[opts.adapter].call(self, opts, function(err) {
        if (err) {
          self.taskqueue.fail(err);
          callback(err);
          return;
        }
        prepareForDestruction(self, opts);
        self.emit('created', self);
        PouchDB.emit('created', opts.originalName);
        self.taskqueue.ready(self);
        callback(null, self);
      });
    });
    promise.then(function(resp) {
      oldCB(null, resp);
    }, oldCB);
    self.then = promise.then.bind(promise);
    self.catch = promise.catch.bind(promise);
  }
  PouchDB.debug = debug;
  function hasLocalStorage() {
    return false;
  }
  PouchDB.adapters = {};
  PouchDB.preferredAdapters = [];
  PouchDB.prefix = '_pouch_';
  var eventEmitter = new events.EventEmitter();
  function setUpEventEmitter(Pouch) {
    Object.keys(events.EventEmitter.prototype).forEach(function(key) {
      if (typeof events.EventEmitter.prototype[key] === 'function') {
        Pouch[key] = eventEmitter[key].bind(eventEmitter);
      }
    });
    var destructListeners = Pouch._destructionListeners = new collections.Map();
    Pouch.on('destroyed', function onConstructorDestroyed(name) {
      if (!destructListeners.has(name)) {
        return;
      }
      destructListeners.get(name).forEach(function(callback) {
        callback();
      });
      destructListeners.delete(name);
    });
  }
  setUpEventEmitter(PouchDB);
  PouchDB.parseAdapter = function(name, opts) {
    var match = name.match(/([a-z\-]*):\/\/(.*)/);
    var adapter,
        adapterName;
    if (match) {
      name = /http(s?)/.test(match[1]) ? match[1] + '://' + match[2] : match[2];
      adapter = match[1];
      if (!PouchDB.adapters[adapter].valid()) {
        throw 'Invalid adapter';
      }
      return {
        name: name,
        adapter: match[1]
      };
    }
    var skipIdb = 'idb' in PouchDB.adapters && 'websql' in PouchDB.adapters && hasLocalStorage() && localStorage['_pouch__websqldb_' + PouchDB.prefix + name];
    if (opts.adapter) {
      adapterName = opts.adapter;
    } else if (typeof opts !== 'undefined' && opts.db) {
      adapterName = 'leveldb';
    } else {
      for (var i = 0; i < PouchDB.preferredAdapters.length; ++i) {
        adapterName = PouchDB.preferredAdapters[i];
        if (adapterName in PouchDB.adapters) {
          if (skipIdb && adapterName === 'idb') {
            console.log('PouchDB is downgrading "' + name + '" to WebSQL to' + ' avoid data loss, because it was already opened with WebSQL.');
            continue;
          }
          break;
        }
      }
    }
    adapter = PouchDB.adapters[adapterName];
    var usePrefix = (adapter && 'use_prefix' in adapter) ? adapter.use_prefix : true;
    return {
      name: usePrefix ? (PouchDB.prefix + name) : name,
      adapter: adapterName
    };
  };
  PouchDB.adapter = function(id, obj, addToPreferredAdapters) {
    if (obj.valid()) {
      PouchDB.adapters[id] = obj;
      if (addToPreferredAdapters) {
        PouchDB.preferredAdapters.push(id);
      }
    }
  };
  PouchDB.plugin = function(obj) {
    Object.keys(obj).forEach(function(id) {
      PouchDB.prototype[id] = obj[id];
    });
    return PouchDB;
  };
  PouchDB.defaults = function(defaultOpts) {
    function PouchAlt(name, opts, callback) {
      if (!(this instanceof PouchAlt)) {
        return new PouchAlt(name, opts, callback);
      }
      if (typeof opts === 'function' || typeof opts === 'undefined') {
        callback = opts;
        opts = {};
      }
      if (name && typeof name === 'object') {
        opts = name;
        name = undefined;
      }
      opts = jsExtend.extend({}, defaultOpts, opts);
      PouchDB.call(this, name, opts, callback);
    }
    inherits(PouchAlt, PouchDB);
    setUpEventEmitter(PouchAlt);
    PouchAlt.preferredAdapters = PouchDB.preferredAdapters.slice();
    Object.keys(PouchDB).forEach(function(key) {
      if (!(key in PouchAlt)) {
        PouchAlt[key] = PouchDB[key];
      }
    });
    return PouchAlt;
  };
  var request = require('request');
  function applyTypeToBuffer(buffer, resp) {
    buffer.type = resp.headers['content-type'];
  }
  var buffer = Buffer;
  function defaultBody() {
    return new buffer('', 'binary');
  }
  function ajaxCore(options, callback) {
    options = clone(options);
    var defaultOptions = {
      method: "GET",
      headers: {},
      json: true,
      processData: true,
      timeout: 10000,
      cache: false
    };
    options = jsExtend.extend(defaultOptions, options);
    function onSuccess(obj, resp, cb) {
      if (!options.binary && options.json && typeof obj === 'string') {
        try {
          obj = JSON.parse(obj);
        } catch (e) {
          return cb(e);
        }
      }
      if (Array.isArray(obj)) {
        obj = obj.map(function(v) {
          if (v.error || v.missing) {
            return generateErrorFromResponse(v);
          } else {
            return v;
          }
        });
      }
      if (options.binary) {
        applyTypeToBuffer(obj, resp);
      }
      cb(null, obj, resp);
    }
    function onError(err, cb) {
      var errParsed,
          errObj;
      if (err.code && err.status) {
        var err2 = new Error(err.message || err.code);
        err2.status = err.status;
        return cb(err2);
      }
      try {
        errParsed = JSON.parse(err.responseText);
        errObj = generateErrorFromResponse(errParsed);
      } catch (e) {
        errObj = generateErrorFromResponse(err);
      }
      cb(errObj);
    }
    if (options.json) {
      if (!options.binary) {
        options.headers.Accept = 'application/json';
      }
      options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
    }
    if (options.binary) {
      options.encoding = null;
      options.json = false;
    }
    if (!options.processData) {
      options.json = false;
    }
    return request(options, function(err, response, body) {
      if (err) {
        err.status = response ? response.statusCode : 400;
        return onError(err, callback);
      }
      var error;
      var content_type = response.headers && response.headers['content-type'];
      var data = body || defaultBody();
      if (!options.binary && (options.json || !options.processData) && typeof data !== 'object' && (/json/.test(content_type) || (/^[\s]*\{/.test(data) && /\}[\s]*$/.test(data)))) {
        try {
          data = JSON.parse(data.toString());
        } catch (e) {}
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        onSuccess(data, response, callback);
      } else {
        error = generateErrorFromResponse(data);
        error.status = response.statusCode;
        callback(error);
      }
    });
  }
  function ajax(opts, callback) {
    return ajaxCore(opts, callback);
  }
  var keys = ["source", "protocol", "authority", "userInfo", "user", "password", "host", "port", "relative", "path", "directory", "file", "query", "anchor"];
  var qName = "queryKey";
  var qParser = /(?:^|&)([^&=]*)=?([^&]*)/g;
  var parser = /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/;
  function parseUri(str) {
    var m = parser.exec(str);
    var uri = {};
    var i = 14;
    while (i--) {
      var key = keys[i];
      var value = m[i] || "";
      var encoded = ['user', 'password'].indexOf(key) !== -1;
      uri[key] = encoded ? decodeURIComponent(value) : value;
    }
    uri[qName] = {};
    uri[keys[12]].replace(qParser, function($0, $1, $2) {
      if ($1) {
        uri[qName][$1] = $2;
      }
    });
    return uri;
  }
  function atob(str) {
    var base64 = new buffer(str, 'base64');
    if (base64.toString('base64') !== str) {
      throw new Error("attachment is not a valid base64 string");
    }
    return base64.toString('binary');
  }
  function thisBtoa(str) {
    return new buffer(str, 'binary').toString('base64');
  }
  function typedBuffer(binString, buffType, type) {
    var buff = new buffer(binString, buffType);
    buff.type = type;
    return buff;
  }
  function binStringToBluffer(binString, type) {
    return typedBuffer(binString, 'binary', type);
  }
  var extend$1 = jsExtend__default.extend;
  var utils = {
    ajax: ajax,
    parseUri: parseUri,
    uuid: uuid,
    Promise: PouchPromise,
    atob: atob,
    btoa: thisBtoa,
    binaryStringToBlobOrBuffer: binStringToBluffer,
    clone: clone,
    extend: extend$1,
    createError: createError
  };
  function tryFilter(filter, doc, req) {
    try {
      return !filter(doc, req);
    } catch (err) {
      var msg = 'Filter function threw: ' + err.toString();
      return createError(BAD_REQUEST, msg);
    }
  }
  function filterChange(opts) {
    var req = {};
    var hasFilter = opts.filter && typeof opts.filter === 'function';
    req.query = opts.query_params;
    return function filter(change) {
      if (!change.doc) {
        change.doc = {};
      }
      var filterReturn = hasFilter && tryFilter(opts.filter, change.doc, req);
      if (typeof filterReturn === 'object') {
        return filterReturn;
      }
      if (filterReturn) {
        return false;
      }
      if (!opts.include_docs) {
        delete change.doc;
      } else if (!opts.attachments) {
        for (var att in change.doc._attachments) {
          if (change.doc._attachments.hasOwnProperty(att)) {
            change.doc._attachments[att].stub = true;
          }
        }
      }
      return true;
    };
  }
  var res = function() {};
  var collate$2 = pouchCollate__default.collate;
  var CHECKPOINT_VERSION = 1;
  var REPLICATOR = "pouchdb";
  var CHECKPOINT_HISTORY_SIZE = 5;
  var LOWEST_SEQ = 0;
  function updateCheckpoint(db, id, checkpoint, session, returnValue) {
    return db.get(id).catch(function(err) {
      if (err.status === 404) {
        if (db.type() === 'http') {
          res(404, 'PouchDB is just checking if a remote checkpoint exists.');
        }
        return {
          session_id: session,
          _id: id,
          history: [],
          replicator: REPLICATOR,
          version: CHECKPOINT_VERSION
        };
      }
      throw err;
    }).then(function(doc) {
      if (returnValue.cancelled) {
        return;
      }
      doc.history = (doc.history || []).filter(function(item) {
        return item.session_id !== session;
      });
      doc.history.unshift({
        last_seq: checkpoint,
        session_id: session
      });
      doc.history = doc.history.slice(0, CHECKPOINT_HISTORY_SIZE);
      doc.version = CHECKPOINT_VERSION;
      doc.replicator = REPLICATOR;
      doc.session_id = session;
      doc.last_seq = checkpoint;
      return db.put(doc).catch(function(err) {
        if (err.status === 409) {
          return updateCheckpoint(db, id, checkpoint, session, returnValue);
        }
        throw err;
      });
    });
  }
  function Checkpointer(src, target, id, returnValue) {
    this.src = src;
    this.target = target;
    this.id = id;
    this.returnValue = returnValue;
  }
  Checkpointer.prototype.writeCheckpoint = function(checkpoint, session) {
    var self = this;
    return this.updateTarget(checkpoint, session).then(function() {
      return self.updateSource(checkpoint, session);
    });
  };
  Checkpointer.prototype.updateTarget = function(checkpoint, session) {
    return updateCheckpoint(this.target, this.id, checkpoint, session, this.returnValue);
  };
  Checkpointer.prototype.updateSource = function(checkpoint, session) {
    var self = this;
    if (this.readOnlySource) {
      return PouchPromise.resolve(true);
    }
    return updateCheckpoint(this.src, this.id, checkpoint, session, this.returnValue).catch(function(err) {
      if (isForbiddenError(err)) {
        self.readOnlySource = true;
        return true;
      }
      throw err;
    });
  };
  var comparisons = {
    "undefined": function(targetDoc, sourceDoc) {
      if (collate$2(targetDoc.last_seq, sourceDoc.last_seq) === 0) {
        return sourceDoc.last_seq;
      }
      return 0;
    },
    "1": function(targetDoc, sourceDoc) {
      return compareReplicationLogs(sourceDoc, targetDoc).last_seq;
    }
  };
  Checkpointer.prototype.getCheckpoint = function() {
    var self = this;
    return self.target.get(self.id).then(function(targetDoc) {
      if (self.readOnlySource) {
        return PouchPromise.resolve(targetDoc.last_seq);
      }
      return self.src.get(self.id).then(function(sourceDoc) {
        if (targetDoc.version !== sourceDoc.version) {
          return LOWEST_SEQ;
        }
        var version;
        if (targetDoc.version) {
          version = targetDoc.version.toString();
        } else {
          version = "undefined";
        }
        if (version in comparisons) {
          return comparisons[version](targetDoc, sourceDoc);
        }
        return LOWEST_SEQ;
      }, function(err) {
        if (err.status === 404 && targetDoc.last_seq) {
          return self.src.put({
            _id: self.id,
            last_seq: LOWEST_SEQ
          }).then(function() {
            return LOWEST_SEQ;
          }, function(err) {
            if (isForbiddenError(err)) {
              self.readOnlySource = true;
              return targetDoc.last_seq;
            }
            return LOWEST_SEQ;
          });
        }
        throw err;
      });
    }).catch(function(err) {
      if (err.status !== 404) {
        throw err;
      }
      return LOWEST_SEQ;
    });
  };
  function compareReplicationLogs(srcDoc, tgtDoc) {
    if (srcDoc.session_id === tgtDoc.session_id) {
      return {
        last_seq: srcDoc.last_seq,
        history: srcDoc.history || []
      };
    }
    var sourceHistory = srcDoc.history || [];
    var targetHistory = tgtDoc.history || [];
    return compareReplicationHistory(sourceHistory, targetHistory);
  }
  function compareReplicationHistory(sourceHistory, targetHistory) {
    var S = sourceHistory[0];
    var sourceRest = sourceHistory.slice(1);
    var T = targetHistory[0];
    var targetRest = targetHistory.slice(1);
    if (!S || targetHistory.length === 0) {
      return {
        last_seq: LOWEST_SEQ,
        history: []
      };
    }
    var sourceId = S.session_id;
    if (hasSessionId(sourceId, targetHistory)) {
      return {
        last_seq: S.last_seq,
        history: sourceHistory
      };
    }
    var targetId = T.session_id;
    if (hasSessionId(targetId, sourceRest)) {
      return {
        last_seq: T.last_seq,
        history: targetRest
      };
    }
    return compareReplicationHistory(sourceRest, targetRest);
  }
  function hasSessionId(sessionId, history) {
    var props = history[0];
    var rest = history.slice(1);
    if (!sessionId || history.length === 0) {
      return false;
    }
    if (sessionId === props.session_id) {
      return true;
    }
    return hasSessionId(sessionId, rest);
  }
  function isForbiddenError(err) {
    return typeof err.status === 'number' && Math.floor(err.status / 100) === 4;
  }
  var STARTING_BACK_OFF = 0;
  function randomNumber(min, max) {
    min = parseInt(min, 10) || 0;
    max = parseInt(max, 10);
    if (max !== max || max <= min) {
      max = (min || 1) << 1;
    } else {
      max = max + 1;
    }
    var ratio = Math.random();
    var range = max - min;
    return ~~(range * ratio + min);
  }
  function defaultBackOff(min) {
    var max = 0;
    if (!min) {
      max = 2000;
    }
    return randomNumber(min, max);
  }
  function backOff(opts, returnValue, error, callback) {
    if (opts.retry === false) {
      returnValue.emit('error', error);
      returnValue.removeAllListeners();
      return;
    }
    if (typeof opts.back_off_function !== 'function') {
      opts.back_off_function = defaultBackOff;
    }
    returnValue.emit('requestError', error);
    if (returnValue.state === 'active' || returnValue.state === 'pending') {
      returnValue.emit('paused', error);
      returnValue.state = 'stopped';
      returnValue.once('active', function() {
        opts.current_back_off = STARTING_BACK_OFF;
      });
    }
    opts.current_back_off = opts.current_back_off || STARTING_BACK_OFF;
    opts.current_back_off = opts.back_off_function(opts.current_back_off);
    setTimeout(callback, opts.current_back_off);
  }
  var res$1 = toPromise(function(data, callback) {
    var base64 = crypto.createHash('md5').update(data).digest('base64');
    callback(null, base64);
  });
  function sortObjectPropertiesByKey(queryParams) {
    return Object.keys(queryParams).sort(pouchCollate.collate).reduce(function(result, key) {
      result[key] = queryParams[key];
      return result;
    }, {});
  }
  function generateReplicationId(src, target, opts) {
    var docIds = opts.doc_ids ? opts.doc_ids.sort(pouchCollate.collate) : '';
    var filterFun = opts.filter ? opts.filter.toString() : '';
    var queryParams = '';
    var filterViewName = '';
    if (opts.filter && opts.query_params) {
      queryParams = JSON.stringify(sortObjectPropertiesByKey(opts.query_params));
    }
    if (opts.filter && opts.filter === '_view') {
      filterViewName = opts.view.toString();
    }
    return PouchPromise.all([src.id(), target.id()]).then(function(res) {
      var queryData = res[0] + res[1] + filterFun + filterViewName + queryParams + docIds;
      return res$1(queryData);
    }).then(function(md5sum) {
      md5sum = md5sum.replace(/\//g, '.').replace(/\+/g, '_');
      return '_local/' + md5sum;
    });
  }
  function isGenOne$1(rev) {
    return /^1-/.test(rev);
  }
  function createBulkGetOpts(diffs) {
    var requests = [];
    Object.keys(diffs).forEach(function(id) {
      var missingRevs = diffs[id].missing;
      missingRevs.forEach(function(missingRev) {
        requests.push({
          id: id,
          rev: missingRev
        });
      });
    });
    return {
      docs: requests,
      revs: true,
      attachments: true,
      binary: true
    };
  }
  function getDocs(src, diffs, state) {
    diffs = clone(diffs);
    var resultDocs = [];
    function getAllDocs() {
      var bulkGetOpts = createBulkGetOpts(diffs);
      if (!bulkGetOpts.docs.length) {
        return;
      }
      return src.bulkGet(bulkGetOpts).then(function(bulkGetResponse) {
        if (state.cancelled) {
          throw new Error('cancelled');
        }
        bulkGetResponse.results.forEach(function(bulkGetInfo) {
          bulkGetInfo.docs.forEach(function(doc) {
            if (doc.ok) {
              resultDocs.push(doc.ok);
            }
          });
        });
      });
    }
    function hasAttachments(doc) {
      return doc._attachments && Object.keys(doc._attachments).length > 0;
    }
    function fetchRevisionOneDocs(ids) {
      return src.allDocs({
        keys: ids,
        include_docs: true
      }).then(function(res) {
        if (state.cancelled) {
          throw new Error('cancelled');
        }
        res.rows.forEach(function(row) {
          if (row.deleted || !row.doc || !isGenOne$1(row.value.rev) || hasAttachments(row.doc)) {
            return;
          }
          resultDocs.push(row.doc);
          delete diffs[row.id];
        });
      });
    }
    function getRevisionOneDocs() {
      var ids = Object.keys(diffs).filter(function(id) {
        var missing = diffs[id].missing;
        return missing.length === 1 && isGenOne$1(missing[0]);
      });
      if (ids.length > 0) {
        return fetchRevisionOneDocs(ids);
      }
    }
    function returnDocs() {
      return resultDocs;
    }
    return PouchPromise.resolve().then(getRevisionOneDocs).then(getAllDocs).then(returnDocs);
  }
  function replicate$1(src, target, opts, returnValue, result) {
    var batches = [];
    var currentBatch;
    var pendingBatch = {
      seq: 0,
      changes: [],
      docs: []
    };
    var writingCheckpoint = false;
    var changesCompleted = false;
    var replicationCompleted = false;
    var last_seq = 0;
    var continuous = opts.continuous || opts.live || false;
    var batch_size = opts.batch_size || 100;
    var batches_limit = opts.batches_limit || 10;
    var changesPending = false;
    var doc_ids = opts.doc_ids;
    var repId;
    var checkpointer;
    var allErrors = [];
    var changedDocs = [];
    var session = uuid();
    result = result || {
      ok: true,
      start_time: new Date(),
      docs_read: 0,
      docs_written: 0,
      doc_write_failures: 0,
      errors: []
    };
    var changesOpts = {};
    returnValue.ready(src, target);
    function initCheckpointer() {
      if (checkpointer) {
        return PouchPromise.resolve();
      }
      return generateReplicationId(src, target, opts).then(function(res) {
        repId = res;
        checkpointer = new Checkpointer(src, target, repId, returnValue);
      });
    }
    function writeDocs() {
      changedDocs = [];
      if (currentBatch.docs.length === 0) {
        return;
      }
      var docs = currentBatch.docs;
      return target.bulkDocs({
        docs: docs,
        new_edits: false
      }).then(function(res) {
        if (returnValue.cancelled) {
          completeReplication();
          throw new Error('cancelled');
        }
        var errors = [];
        var errorsById = {};
        res.forEach(function(res) {
          if (res.error) {
            result.doc_write_failures++;
            errors.push(res);
            errorsById[res.id] = res;
          }
        });
        allErrors = allErrors.concat(errors);
        result.docs_written += currentBatch.docs.length - errors.length;
        var non403s = errors.filter(function(error) {
          return error.name !== 'unauthorized' && error.name !== 'forbidden';
        });
        docs.forEach(function(doc) {
          var error = errorsById[doc._id];
          if (error) {
            returnValue.emit('denied', clone(error));
          } else {
            changedDocs.push(doc);
          }
        });
        if (non403s.length > 0) {
          var error = new Error('bulkDocs error');
          error.other_errors = errors;
          abortReplication('target.bulkDocs failed to write docs', error);
          throw new Error('bulkWrite partial failure');
        }
      }, function(err) {
        result.doc_write_failures += docs.length;
        throw err;
      });
    }
    function finishBatch() {
      result.last_seq = last_seq = currentBatch.seq;
      var outResult = clone(result);
      if (changedDocs.length) {
        outResult.docs = changedDocs;
        returnValue.emit('change', outResult);
      }
      writingCheckpoint = true;
      return checkpointer.writeCheckpoint(currentBatch.seq, session).then(function() {
        writingCheckpoint = false;
        if (returnValue.cancelled) {
          completeReplication();
          throw new Error('cancelled');
        }
        currentBatch = undefined;
        getChanges();
      }).catch(function(err) {
        writingCheckpoint = false;
        abortReplication('writeCheckpoint completed with error', err);
        throw err;
      });
    }
    function getDiffs() {
      var diff = {};
      currentBatch.changes.forEach(function(change) {
        if (change.id === "_user/") {
          return;
        }
        diff[change.id] = change.changes.map(function(x) {
          return x.rev;
        });
      });
      return target.revsDiff(diff).then(function(diffs) {
        if (returnValue.cancelled) {
          completeReplication();
          throw new Error('cancelled');
        }
        currentBatch.diffs = diffs;
      });
    }
    function getBatchDocs() {
      return getDocs(src, currentBatch.diffs, returnValue).then(function(docs) {
        docs.forEach(function(doc) {
          delete currentBatch.diffs[doc._id];
          result.docs_read++;
          currentBatch.docs.push(doc);
        });
      });
    }
    function startNextBatch() {
      if (returnValue.cancelled || currentBatch) {
        return;
      }
      if (batches.length === 0) {
        processPendingBatch(true);
        return;
      }
      currentBatch = batches.shift();
      getDiffs().then(getBatchDocs).then(writeDocs).then(finishBatch).then(startNextBatch).catch(function(err) {
        abortReplication('batch processing terminated with error', err);
      });
    }
    function processPendingBatch(immediate) {
      if (pendingBatch.changes.length === 0) {
        if (batches.length === 0 && !currentBatch) {
          if ((continuous && changesOpts.live) || changesCompleted) {
            returnValue.state = 'pending';
            returnValue.emit('paused');
          }
          if (changesCompleted) {
            completeReplication();
          }
        }
        return;
      }
      if (immediate || changesCompleted || pendingBatch.changes.length >= batch_size) {
        batches.push(pendingBatch);
        pendingBatch = {
          seq: 0,
          changes: [],
          docs: []
        };
        if (returnValue.state === 'pending' || returnValue.state === 'stopped') {
          returnValue.state = 'active';
          returnValue.emit('active');
        }
        startNextBatch();
      }
    }
    function abortReplication(reason, err) {
      if (replicationCompleted) {
        return;
      }
      if (!err.message) {
        err.message = reason;
      }
      result.ok = false;
      result.status = 'aborting';
      result.errors.push(err);
      allErrors = allErrors.concat(err);
      batches = [];
      pendingBatch = {
        seq: 0,
        changes: [],
        docs: []
      };
      completeReplication();
    }
    function completeReplication() {
      if (replicationCompleted) {
        return;
      }
      if (returnValue.cancelled) {
        result.status = 'cancelled';
        if (writingCheckpoint) {
          return;
        }
      }
      result.status = result.status || 'complete';
      result.end_time = new Date();
      result.last_seq = last_seq;
      replicationCompleted = true;
      var non403s = allErrors.filter(function(error) {
        return error.name !== 'unauthorized' && error.name !== 'forbidden';
      });
      if (non403s.length > 0) {
        var error = allErrors.pop();
        if (allErrors.length > 0) {
          error.other_errors = allErrors;
        }
        error.result = result;
        backOff(opts, returnValue, error, function() {
          replicate$1(src, target, opts, returnValue);
        });
      } else {
        result.errors = allErrors;
        returnValue.emit('complete', result);
        returnValue.removeAllListeners();
      }
    }
    function onChange(change) {
      if (returnValue.cancelled) {
        return completeReplication();
      }
      var filter = filterChange(opts)(change);
      if (!filter) {
        return;
      }
      pendingBatch.seq = change.seq;
      pendingBatch.changes.push(change);
      processPendingBatch(changesOpts.live);
    }
    function onChangesComplete(changes) {
      changesPending = false;
      if (returnValue.cancelled) {
        return completeReplication();
      }
      if (changes.results.length > 0) {
        changesOpts.since = changes.last_seq;
        getChanges();
      } else {
        if (continuous) {
          changesOpts.live = true;
          getChanges();
        } else {
          changesCompleted = true;
        }
      }
      processPendingBatch(true);
    }
    function onChangesError(err) {
      changesPending = false;
      if (returnValue.cancelled) {
        return completeReplication();
      }
      abortReplication('changes rejected', err);
    }
    function getChanges() {
      if (!(!changesPending && !changesCompleted && batches.length < batches_limit)) {
        return;
      }
      changesPending = true;
      function abortChanges() {
        changes.cancel();
      }
      function removeListener() {
        returnValue.removeListener('cancel', abortChanges);
      }
      if (returnValue._changes) {
        returnValue.removeListener('cancel', returnValue._abortChanges);
        returnValue._changes.cancel();
      }
      returnValue.once('cancel', abortChanges);
      var changes = src.changes(changesOpts).on('change', onChange);
      changes.then(removeListener, removeListener);
      changes.then(onChangesComplete).catch(onChangesError);
      if (opts.retry) {
        returnValue._changes = changes;
        returnValue._abortChanges = abortChanges;
      }
    }
    function startChanges() {
      initCheckpointer().then(function() {
        if (returnValue.cancelled) {
          completeReplication();
          return;
        }
        return checkpointer.getCheckpoint().then(function(checkpoint) {
          last_seq = checkpoint;
          changesOpts = {
            since: last_seq,
            limit: batch_size,
            batch_size: batch_size,
            style: 'all_docs',
            doc_ids: doc_ids,
            return_docs: true
          };
          if (opts.filter) {
            if (typeof opts.filter !== 'string') {
              changesOpts.include_docs = true;
            } else {
              changesOpts.filter = opts.filter;
            }
          }
          if ('heartbeat' in opts) {
            changesOpts.heartbeat = opts.heartbeat;
          }
          if ('timeout' in opts) {
            changesOpts.timeout = opts.timeout;
          }
          if (opts.query_params) {
            changesOpts.query_params = opts.query_params;
          }
          if (opts.view) {
            changesOpts.view = opts.view;
          }
          getChanges();
        });
      }).catch(function(err) {
        abortReplication('getCheckpoint rejected with ', err);
      });
    }
    function onCheckpointError(err) {
      writingCheckpoint = false;
      abortReplication('writeCheckpoint completed with error', err);
      throw err;
    }
    if (returnValue.cancelled) {
      completeReplication();
      return;
    }
    if (!returnValue._addedListeners) {
      returnValue.once('cancel', completeReplication);
      if (typeof opts.complete === 'function') {
        returnValue.once('error', opts.complete);
        returnValue.once('complete', function(result) {
          opts.complete(null, result);
        });
      }
      returnValue._addedListeners = true;
    }
    if (typeof opts.since === 'undefined') {
      startChanges();
    } else {
      initCheckpointer().then(function() {
        writingCheckpoint = true;
        return checkpointer.writeCheckpoint(opts.since, session);
      }).then(function() {
        writingCheckpoint = false;
        if (returnValue.cancelled) {
          completeReplication();
          return;
        }
        last_seq = opts.since;
        startChanges();
      }).catch(onCheckpointError);
    }
  }
  inherits(Replication, events.EventEmitter);
  function Replication() {
    events.EventEmitter.call(this);
    this.cancelled = false;
    this.state = 'pending';
    var self = this;
    var promise = new PouchPromise(function(fulfill, reject) {
      self.once('complete', fulfill);
      self.once('error', reject);
    });
    self.then = function(resolve, reject) {
      return promise.then(resolve, reject);
    };
    self.catch = function(reject) {
      return promise.catch(reject);
    };
    self.catch(function() {});
  }
  Replication.prototype.cancel = function() {
    this.cancelled = true;
    this.state = 'cancelled';
    this.emit('cancel');
  };
  Replication.prototype.ready = function(src, target) {
    var self = this;
    if (self._readyCalled) {
      return;
    }
    self._readyCalled = true;
    function onDestroy() {
      self.cancel();
    }
    src.once('destroyed', onDestroy);
    target.once('destroyed', onDestroy);
    function cleanup() {
      src.removeListener('destroyed', onDestroy);
      target.removeListener('destroyed', onDestroy);
    }
    self.once('complete', cleanup);
  };
  function toPouch(db, opts) {
    var PouchConstructor = opts.PouchConstructor;
    if (typeof db === 'string') {
      return new PouchConstructor(db, opts);
    } else {
      return db;
    }
  }
  function replicateWrapper(src, target, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (typeof opts === 'undefined') {
      opts = {};
    }
    if (opts.doc_ids && !Array.isArray(opts.doc_ids)) {
      throw createError(BAD_REQUEST, "`doc_ids` filter parameter is not a list.");
    }
    opts.complete = callback;
    opts = clone(opts);
    opts.continuous = opts.continuous || opts.live;
    opts.retry = ('retry' in opts) ? opts.retry : false;
    opts.PouchConstructor = opts.PouchConstructor || this;
    var replicateRet = new Replication(opts);
    var srcPouch = toPouch(src, opts);
    var targetPouch = toPouch(target, opts);
    replicate$1(srcPouch, targetPouch, opts, replicateRet);
    return replicateRet;
  }
  var replication = {
    replicate: replicateWrapper,
    toPouch: toPouch
  };
  var replicate = replication.replicate;
  inherits(Sync, events.EventEmitter);
  function sync(src, target, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (typeof opts === 'undefined') {
      opts = {};
    }
    opts = clone(opts);
    opts.PouchConstructor = opts.PouchConstructor || this;
    src = replication.toPouch(src, opts);
    target = replication.toPouch(target, opts);
    return new Sync(src, target, opts, callback);
  }
  function Sync(src, target, opts, callback) {
    var self = this;
    this.canceled = false;
    var optsPush = opts.push ? jsExtend.extend({}, opts, opts.push) : opts;
    var optsPull = opts.pull ? jsExtend.extend({}, opts, opts.pull) : opts;
    this.push = replicate(src, target, optsPush);
    this.pull = replicate(target, src, optsPull);
    this.pushPaused = true;
    this.pullPaused = true;
    function pullChange(change) {
      self.emit('change', {
        direction: 'pull',
        change: change
      });
    }
    function pushChange(change) {
      self.emit('change', {
        direction: 'push',
        change: change
      });
    }
    function pushDenied(doc) {
      self.emit('denied', {
        direction: 'push',
        doc: doc
      });
    }
    function pullDenied(doc) {
      self.emit('denied', {
        direction: 'pull',
        doc: doc
      });
    }
    function pushPaused() {
      self.pushPaused = true;
      if (self.pullPaused) {
        self.emit('paused');
      }
    }
    function pullPaused() {
      self.pullPaused = true;
      if (self.pushPaused) {
        self.emit('paused');
      }
    }
    function pushActive() {
      self.pushPaused = false;
      if (self.pullPaused) {
        self.emit('active', {direction: 'push'});
      }
    }
    function pullActive() {
      self.pullPaused = false;
      if (self.pushPaused) {
        self.emit('active', {direction: 'pull'});
      }
    }
    var removed = {};
    function removeAll(type) {
      return function(event, func) {
        var isChange = event === 'change' && (func === pullChange || func === pushChange);
        var isDenied = event === 'denied' && (func === pullDenied || func === pushDenied);
        var isPaused = event === 'paused' && (func === pullPaused || func === pushPaused);
        var isActive = event === 'active' && (func === pullActive || func === pushActive);
        if (isChange || isDenied || isPaused || isActive) {
          if (!(event in removed)) {
            removed[event] = {};
          }
          removed[event][type] = true;
          if (Object.keys(removed[event]).length === 2) {
            self.removeAllListeners(event);
          }
        }
      };
    }
    if (opts.live) {
      this.push.on('complete', self.pull.cancel.bind(self.pull));
      this.pull.on('complete', self.push.cancel.bind(self.push));
    }
    this.on('newListener', function(event) {
      if (event === 'change') {
        self.pull.on('change', pullChange);
        self.push.on('change', pushChange);
      } else if (event === 'denied') {
        self.pull.on('denied', pullDenied);
        self.push.on('denied', pushDenied);
      } else if (event === 'active') {
        self.pull.on('active', pullActive);
        self.push.on('active', pushActive);
      } else if (event === 'paused') {
        self.pull.on('paused', pullPaused);
        self.push.on('paused', pushPaused);
      }
    });
    this.on('removeListener', function(event) {
      if (event === 'change') {
        self.pull.removeListener('change', pullChange);
        self.push.removeListener('change', pushChange);
      } else if (event === 'denied') {
        self.pull.removeListener('denied', pullDenied);
        self.push.removeListener('denied', pushDenied);
      } else if (event === 'active') {
        self.pull.removeListener('active', pullActive);
        self.push.removeListener('active', pushActive);
      } else if (event === 'paused') {
        self.pull.removeListener('paused', pullPaused);
        self.push.removeListener('paused', pushPaused);
      }
    });
    this.pull.on('removeListener', removeAll('pull'));
    this.push.on('removeListener', removeAll('push'));
    var promise = PouchPromise.all([this.push, this.pull]).then(function(resp) {
      var out = {
        push: resp[0],
        pull: resp[1]
      };
      self.emit('complete', out);
      if (callback) {
        callback(null, out);
      }
      self.removeAllListeners();
      return out;
    }, function(err) {
      self.cancel();
      if (callback) {
        callback(err);
      } else {
        self.emit('error', err);
      }
      self.removeAllListeners();
      if (callback) {
        throw err;
      }
    });
    this.then = function(success, err) {
      return promise.then(success, err);
    };
    this.catch = function(err) {
      return promise.catch(err);
    };
  }
  Sync.prototype.cancel = function() {
    if (!this.canceled) {
      this.canceled = true;
      this.push.cancel();
      this.pull.cancel();
    }
  };
  function b64ToBluffer(b64, type) {
    return typedBuffer(b64, 'base64', type);
  }
  function blobToBase64(blobOrBuffer) {
    return PouchPromise.resolve(blobOrBuffer.toString('base64'));
  }
  function flatten(arrs) {
    var res = [];
    for (var i = 0,
        len = arrs.length; i < len; i++) {
      res = res.concat(arrs[i]);
    }
    return res;
  }
  var CHANGES_BATCH_SIZE = 25;
  var MAX_SIMULTANEOUS_REVS = 50;
  var supportsBulkGetMap = {};
  var MAX_URL_LENGTH = 1800;
  var log = debug('pouchdb:http');
  function readAttachmentsAsBlobOrBuffer(row) {
    var atts = row.doc && row.doc._attachments;
    if (!atts) {
      return;
    }
    Object.keys(atts).forEach(function(filename) {
      var att = atts[filename];
      att.data = b64ToBluffer(att.data, att.content_type);
    });
  }
  function encodeDocId(id) {
    if (/^_design/.test(id)) {
      return '_design/' + encodeURIComponent(id.slice(8));
    }
    if (/^_local/.test(id)) {
      return '_local/' + encodeURIComponent(id.slice(7));
    }
    return encodeURIComponent(id);
  }
  function preprocessAttachments(doc) {
    if (!doc._attachments || !Object.keys(doc._attachments)) {
      return PouchPromise.resolve();
    }
    return PouchPromise.all(Object.keys(doc._attachments).map(function(key) {
      var attachment = doc._attachments[key];
      if (attachment.data && typeof attachment.data !== 'string') {
        return blobToBase64(attachment.data).then(function(b64) {
          attachment.data = b64;
        });
      }
    }));
  }
  function getHost(name) {
    var uri = parseUri(name);
    if (uri.user || uri.password) {
      uri.auth = {
        username: uri.user,
        password: uri.password
      };
    }
    var parts = uri.path.replace(/(^\/|\/$)/g, '').split('/');
    uri.db = parts.pop();
    if (uri.db.indexOf('%') === -1) {
      uri.db = encodeURIComponent(uri.db);
    }
    uri.path = parts.join('/');
    return uri;
  }
  function genDBUrl(opts, path) {
    return genUrl(opts, opts.db + '/' + path);
  }
  function genUrl(opts, path) {
    var pathDel = !opts.path ? '' : '/';
    return opts.protocol + '://' + opts.host + (opts.port ? (':' + opts.port) : '') + '/' + opts.path + pathDel + path;
  }
  function paramsToStr(params) {
    return '?' + Object.keys(params).map(function(k) {
      return k + '=' + encodeURIComponent(params[k]);
    }).join('&');
  }
  function HttpPouch(opts, callback) {
    var api = this;
    var getHostFun = getHost;
    if (opts.getHost) {
      getHostFun = opts.getHost;
    }
    var host = getHostFun(opts.name, opts);
    var dbUrl = genDBUrl(host, '');
    opts = clone(opts);
    var ajaxOpts = opts.ajax || {};
    api.getUrl = function() {
      return dbUrl;
    };
    api.getHeaders = function() {
      return ajaxOpts.headers || {};
    };
    if (opts.auth || host.auth) {
      var nAuth = opts.auth || host.auth;
      var token = thisBtoa(nAuth.username + ':' + nAuth.password);
      ajaxOpts.headers = ajaxOpts.headers || {};
      ajaxOpts.headers.Authorization = 'Basic ' + token;
    }
    function ajax(userOpts, options, callback) {
      var reqAjax = userOpts.ajax || {};
      var reqOpts = jsExtend.extend(clone(ajaxOpts), reqAjax, options);
      log(reqOpts.method + ' ' + reqOpts.url);
      return utils.ajax(reqOpts, callback);
    }
    function ajaxPromise(userOpts, opts) {
      return new PouchPromise(function(resolve, reject) {
        ajax(userOpts, opts, function(err, res$$) {
          if (err) {
            return reject(err);
          }
          resolve(res$$);
        });
      });
    }
    function adapterFun$$(name, fun) {
      return adapterFun(name, getArguments(function(args) {
        setup().then(function(res$$) {
          return fun.apply(this, args);
        }).catch(function(e) {
          var callback = args.pop();
          callback(e);
        });
      }));
    }
    var setupPromise;
    function setup() {
      if (opts.skipSetup || opts.skip_setup) {
        return PouchPromise.resolve();
      }
      if (setupPromise) {
        return setupPromise;
      }
      var checkExists = {
        method: 'GET',
        url: dbUrl
      };
      setupPromise = ajaxPromise({}, checkExists).catch(function(err) {
        if (err && err.status && err.status === 404) {
          res(404, 'PouchDB is just detecting if the remote exists.');
          return ajaxPromise({}, {
            method: 'PUT',
            url: dbUrl
          });
        } else {
          return PouchPromise.reject(err);
        }
      }).catch(function(err) {
        if (err && err.status && err.status === 412) {
          return true;
        }
        return PouchPromise.reject(err);
      });
      setupPromise.catch(function() {
        setupPromise = null;
      });
      return setupPromise;
    }
    setTimeout(function() {
      callback(null, api);
    });
    api.type = function() {
      return 'http';
    };
    api.id = adapterFun$$('id', function(callback) {
      ajax({}, {
        method: 'GET',
        url: genUrl(host, '')
      }, function(err, result) {
        var uuid = (result && result.uuid) ? (result.uuid + host.db) : genDBUrl(host, '');
        callback(null, uuid);
      });
    });
    api.request = adapterFun$$('request', function(options, callback) {
      options.url = genDBUrl(host, options.url);
      ajax({}, options, callback);
    });
    api.compact = adapterFun$$('compact', function(opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      opts = clone(opts);
      ajax(opts, {
        url: genDBUrl(host, '_compact'),
        method: 'POST'
      }, function() {
        function ping() {
          api.info(function(err, res$$) {
            if (res$$ && !res$$.compact_running) {
              callback(null, {ok: true});
            } else {
              setTimeout(ping, opts.interval || 200);
            }
          });
        }
        ping();
      });
    });
    api.bulkGet = adapterFun('bulkGet', function(opts, callback) {
      var self = this;
      function doBulkGet(cb) {
        var params = {};
        if (opts.revs) {
          params.revs = true;
        }
        if (opts.attachments) {
          params.attachments = true;
        }
        ajax({}, {
          url: genDBUrl(host, '_bulk_get' + paramsToStr(params)),
          method: 'POST',
          body: {docs: opts.docs}
        }, cb);
      }
      function doBulkGetShim() {
        var batchSize = MAX_SIMULTANEOUS_REVS;
        var numBatches = Math.ceil(opts.docs.length / batchSize);
        var numDone = 0;
        var results = new Array(numBatches);
        function onResult(batchNum) {
          return function(err, res$$) {
            results[batchNum] = res$$.results;
            if (++numDone === numBatches) {
              callback(null, {results: flatten(results)});
            }
          };
        }
        for (var i = 0; i < numBatches; i++) {
          var subOpts = pick(opts, ['revs', 'attachments']);
          subOpts.docs = opts.docs.slice(i * batchSize, Math.min(opts.docs.length, (i + 1) * batchSize));
          bulkGet(self, subOpts, onResult(i));
        }
      }
      var dbUrl = genUrl(host, '');
      var supportsBulkGet = supportsBulkGetMap[dbUrl];
      if (typeof supportsBulkGet !== 'boolean') {
        doBulkGet(function(err, res$$) {
          if (err) {
            var status = Math.floor(err.status / 100);
            if (status === 4 || status === 5) {
              supportsBulkGetMap[dbUrl] = false;
              res(err.status, 'PouchDB is just detecting if the remote ' + 'supports the _bulk_get API.');
              doBulkGetShim();
            } else {
              callback(err);
            }
          } else {
            supportsBulkGetMap[dbUrl] = true;
            callback(null, res$$);
          }
        });
      } else if (supportsBulkGet) {
        doBulkGet(callback);
      } else {
        doBulkGetShim();
      }
    });
    api._info = function(callback) {
      setup().then(function() {
        ajax({}, {
          method: 'GET',
          url: genDBUrl(host, '')
        }, function(err, res$$) {
          if (err) {
            return callback(err);
          }
          res$$.host = genDBUrl(host, '');
          callback(null, res$$);
        });
      }).catch(callback);
    };
    api.get = adapterFun$$('get', function(id, opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      opts = clone(opts);
      var params = {};
      if (opts.revs) {
        params.revs = true;
      }
      if (opts.revs_info) {
        params.revs_info = true;
      }
      if (opts.open_revs) {
        if (opts.open_revs !== "all") {
          opts.open_revs = JSON.stringify(opts.open_revs);
        }
        params.open_revs = opts.open_revs;
      }
      if (opts.rev) {
        params.rev = opts.rev;
      }
      if (opts.conflicts) {
        params.conflicts = opts.conflicts;
      }
      id = encodeDocId(id);
      var options = {
        method: 'GET',
        url: genDBUrl(host, id + paramsToStr(params))
      };
      function fetchAttachments(doc) {
        var atts = doc._attachments;
        var filenames = atts && Object.keys(atts);
        if (!atts || !filenames.length) {
          return;
        }
        return PouchPromise.all(filenames.map(function(filename) {
          var att = atts[filename];
          var path = encodeDocId(doc._id) + '/' + encodeAttachmentId(filename) + '?rev=' + doc._rev;
          return ajaxPromise(opts, {
            method: 'GET',
            url: genDBUrl(host, path),
            binary: true
          }).then(function(blob) {
            if (opts.binary) {
              return blob;
            }
            return blobToBase64(blob);
          }).then(function(data) {
            delete att.stub;
            delete att.length;
            att.data = data;
          });
        }));
      }
      function fetchAllAttachments(docOrDocs) {
        if (Array.isArray(docOrDocs)) {
          return PouchPromise.all(docOrDocs.map(function(doc) {
            if (doc.ok) {
              return fetchAttachments(doc.ok);
            }
          }));
        }
        return fetchAttachments(docOrDocs);
      }
      ajaxPromise(opts, options).then(function(res$$) {
        return PouchPromise.resolve().then(function() {
          if (opts.attachments) {
            return fetchAllAttachments(res$$);
          }
        }).then(function() {
          callback(null, res$$);
        });
      }).catch(callback);
    });
    api.remove = adapterFun$$('remove', function(docOrId, optsOrRev, opts, callback) {
      var doc;
      if (typeof optsOrRev === 'string') {
        doc = {
          _id: docOrId,
          _rev: optsOrRev
        };
        if (typeof opts === 'function') {
          callback = opts;
          opts = {};
        }
      } else {
        doc = docOrId;
        if (typeof optsOrRev === 'function') {
          callback = optsOrRev;
          opts = {};
        } else {
          callback = opts;
          opts = optsOrRev;
        }
      }
      var rev = (doc._rev || opts.rev);
      ajax(opts, {
        method: 'DELETE',
        url: genDBUrl(host, encodeDocId(doc._id)) + '?rev=' + rev
      }, callback);
    });
    function encodeAttachmentId(attachmentId) {
      return attachmentId.split("/").map(encodeURIComponent).join("/");
    }
    api.getAttachment = adapterFun$$('getAttachment', function(docId, attachmentId, opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      var params = opts.rev ? ('?rev=' + opts.rev) : '';
      var url = genDBUrl(host, encodeDocId(docId)) + '/' + encodeAttachmentId(attachmentId) + params;
      ajax(opts, {
        method: 'GET',
        url: url,
        binary: true
      }, callback);
    });
    api.removeAttachment = adapterFun$$('removeAttachment', function(docId, attachmentId, rev, callback) {
      var url = genDBUrl(host, encodeDocId(docId) + '/' + encodeAttachmentId(attachmentId)) + '?rev=' + rev;
      ajax({}, {
        method: 'DELETE',
        url: url
      }, callback);
    });
    api.putAttachment = adapterFun$$('putAttachment', function(docId, attachmentId, rev, blob, type, callback) {
      if (typeof type === 'function') {
        callback = type;
        type = blob;
        blob = rev;
        rev = null;
      }
      var id = encodeDocId(docId) + '/' + encodeAttachmentId(attachmentId);
      var url = genDBUrl(host, id);
      if (rev) {
        url += '?rev=' + rev;
      }
      if (typeof blob === 'string') {
        var binary;
        try {
          binary = atob(blob);
        } catch (err) {
          return callback(createError(BAD_ARG, 'Attachment is not a valid base64 string'));
        }
        blob = binary ? binStringToBluffer(binary, type) : '';
      }
      var opts = {
        headers: {'Content-Type': type},
        method: 'PUT',
        url: url,
        processData: false,
        body: blob,
        timeout: ajaxOpts.timeout || 60000
      };
      ajax({}, opts, callback);
    });
    api._bulkDocs = function(req, opts, callback) {
      req.new_edits = opts.new_edits;
      setup().then(function() {
        return PouchPromise.all(req.docs.map(preprocessAttachments));
      }).then(function() {
        ajax(opts, {
          method: 'POST',
          url: genDBUrl(host, '_bulk_docs'),
          body: req
        }, function(err, results) {
          if (err) {
            return callback(err);
          }
          results.forEach(function(result) {
            result.ok = true;
          });
          callback(null, results);
        });
      }).catch(callback);
    };
    api.allDocs = adapterFun$$('allDocs', function(opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      opts = clone(opts);
      var params = {};
      var body;
      var method = 'GET';
      if (opts.conflicts) {
        params.conflicts = true;
      }
      if (opts.descending) {
        params.descending = true;
      }
      if (opts.include_docs) {
        params.include_docs = true;
      }
      if (opts.attachments) {
        params.attachments = true;
      }
      if (opts.key) {
        params.key = JSON.stringify(opts.key);
      }
      if (opts.start_key) {
        opts.startkey = opts.start_key;
      }
      if (opts.startkey) {
        params.startkey = JSON.stringify(opts.startkey);
      }
      if (opts.end_key) {
        opts.endkey = opts.end_key;
      }
      if (opts.endkey) {
        params.endkey = JSON.stringify(opts.endkey);
      }
      if (typeof opts.inclusive_end !== 'undefined') {
        params.inclusive_end = !!opts.inclusive_end;
      }
      if (typeof opts.limit !== 'undefined') {
        params.limit = opts.limit;
      }
      if (typeof opts.skip !== 'undefined') {
        params.skip = opts.skip;
      }
      var paramStr = paramsToStr(params);
      if (typeof opts.keys !== 'undefined') {
        var keysAsString = 'keys=' + encodeURIComponent(JSON.stringify(opts.keys));
        if (keysAsString.length + paramStr.length + 1 <= MAX_URL_LENGTH) {
          paramStr += '&' + keysAsString;
        } else {
          method = 'POST';
          body = {keys: opts.keys};
        }
      }
      ajaxPromise(opts, {
        method: method,
        url: genDBUrl(host, '_all_docs' + paramStr),
        body: body
      }).then(function(res$$) {
        if (opts.include_docs && opts.attachments && opts.binary) {
          res$$.rows.forEach(readAttachmentsAsBlobOrBuffer);
        }
        callback(null, res$$);
      }).catch(callback);
    });
    api._changes = function(opts) {
      var batchSize = 'batch_size' in opts ? opts.batch_size : CHANGES_BATCH_SIZE;
      opts = clone(opts);
      opts.timeout = ('timeout' in opts) ? opts.timeout : ('timeout' in ajaxOpts) ? ajaxOpts.timeout : 30 * 1000;
      var params = opts.timeout ? {timeout: opts.timeout - (5 * 1000)} : {};
      var limit = (typeof opts.limit !== 'undefined') ? opts.limit : false;
      var returnDocs;
      if ('return_docs' in opts) {
        returnDocs = opts.return_docs;
      } else if ('returnDocs' in opts) {
        returnDocs = opts.returnDocs;
      } else {
        returnDocs = true;
      }
      var leftToFetch = limit;
      if (opts.style) {
        params.style = opts.style;
      }
      if (opts.include_docs || opts.filter && typeof opts.filter === 'function') {
        params.include_docs = true;
      }
      if (opts.attachments) {
        params.attachments = true;
      }
      if (opts.continuous) {
        params.feed = 'longpoll';
      }
      if (opts.conflicts) {
        params.conflicts = true;
      }
      if (opts.descending) {
        params.descending = true;
      }
      if ('heartbeat' in opts) {
        if (opts.heartbeat) {
          params.heartbeat = opts.heartbeat;
        }
      } else {
        params.heartbeat = 10000;
      }
      if (opts.filter && typeof opts.filter === 'string') {
        params.filter = opts.filter;
        if (opts.filter === '_view' && opts.view && typeof opts.view === 'string') {
          params.view = opts.view;
        }
      }
      if (opts.query_params && typeof opts.query_params === 'object') {
        for (var param_name in opts.query_params) {
          if (opts.query_params.hasOwnProperty(param_name)) {
            params[param_name] = opts.query_params[param_name];
          }
        }
      }
      var method = 'GET';
      var body;
      if (opts.doc_ids) {
        params.filter = '_doc_ids';
        var docIdsJson = JSON.stringify(opts.doc_ids);
        if (docIdsJson.length < MAX_URL_LENGTH) {
          params.doc_ids = docIdsJson;
        } else {
          method = 'POST';
          body = {doc_ids: opts.doc_ids};
        }
      }
      var xhr;
      var lastFetchedSeq;
      var fetch = function(since, callback) {
        if (opts.aborted) {
          return;
        }
        params.since = since;
        if (typeof params.since === "object") {
          params.since = JSON.stringify(params.since);
        }
        if (opts.descending) {
          if (limit) {
            params.limit = leftToFetch;
          }
        } else {
          params.limit = (!limit || leftToFetch > batchSize) ? batchSize : leftToFetch;
        }
        var xhrOpts = {
          method: method,
          url: genDBUrl(host, '_changes' + paramsToStr(params)),
          timeout: opts.timeout,
          body: body
        };
        lastFetchedSeq = since;
        if (opts.aborted) {
          return;
        }
        setup().then(function() {
          xhr = ajax(opts, xhrOpts, callback);
        }).catch(callback);
      };
      var results = {results: []};
      var fetched = function(err, res$$) {
        if (opts.aborted) {
          return;
        }
        var raw_results_length = 0;
        if (res$$ && res$$.results) {
          raw_results_length = res$$.results.length;
          results.last_seq = res$$.last_seq;
          var req = {};
          req.query = opts.query_params;
          res$$.results = res$$.results.filter(function(c) {
            leftToFetch--;
            var ret = filterChange(opts)(c);
            if (ret) {
              if (opts.include_docs && opts.attachments && opts.binary) {
                readAttachmentsAsBlobOrBuffer(c);
              }
              if (returnDocs) {
                results.results.push(c);
              }
              opts.onChange(c);
            }
            return ret;
          });
        } else if (err) {
          opts.aborted = true;
          opts.complete(err);
          return;
        }
        if (res$$ && res$$.last_seq) {
          lastFetchedSeq = res$$.last_seq;
        }
        var finished = (limit && leftToFetch <= 0) || (res$$ && raw_results_length < batchSize) || (opts.descending);
        if ((opts.continuous && !(limit && leftToFetch <= 0)) || !finished) {
          setTimeout(function() {
            fetch(lastFetchedSeq, fetched);
          }, 0);
        } else {
          opts.complete(null, results);
        }
      };
      fetch(opts.since || 0, fetched);
      return {cancel: function() {
          opts.aborted = true;
          if (xhr) {
            xhr.abort();
          }
        }};
    };
    api.revsDiff = adapterFun$$('revsDiff', function(req, opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      ajax(opts, {
        method: 'POST',
        url: genDBUrl(host, '_revs_diff'),
        body: req
      }, callback);
    });
    api._close = function(callback) {
      callback();
    };
    api._destroy = function(options, callback) {
      ajax(options, {
        url: genDBUrl(host, ''),
        method: 'DELETE'
      }, function(err, resp) {
        if (err && err.status && err.status !== 404) {
          return callback(err);
        }
        api.emit('destroyed');
        api.constructor.emit('destroyed', opts.name);
        callback(null, resp);
      });
    };
  }
  HttpPouch.valid = function() {
    return true;
  };
  function TaskQueue() {
    this.promise = new PouchPromise(function(fulfill) {
      fulfill();
    });
  }
  TaskQueue.prototype.add = function(promiseFactory) {
    this.promise = this.promise.catch(function() {}).then(function() {
      return promiseFactory();
    });
    return this.promise;
  };
  TaskQueue.prototype.finish = function() {
    return this.promise;
  };
  function MD5(string) {
    return crypto.createHash('md5').update(string).digest('hex');
  }
  function createView(opts) {
    var sourceDB = opts.db;
    var viewName = opts.viewName;
    var mapFun = opts.map;
    var reduceFun = opts.reduce;
    var temporary = opts.temporary;
    var viewSignature = mapFun.toString() + (reduceFun && reduceFun.toString()) + 'undefined';
    if (!temporary && sourceDB._cachedViews) {
      var cachedView = sourceDB._cachedViews[viewSignature];
      if (cachedView) {
        return PouchPromise.resolve(cachedView);
      }
    }
    return sourceDB.info().then(function(info) {
      var depDbName = info.db_name + '-mrview-' + (temporary ? 'temp' : MD5(viewSignature));
      function diffFunction(doc) {
        doc.views = doc.views || {};
        var fullViewName = viewName;
        if (fullViewName.indexOf('/') === -1) {
          fullViewName = viewName + '/' + viewName;
        }
        var depDbs = doc.views[fullViewName] = doc.views[fullViewName] || {};
        if (depDbs[depDbName]) {
          return;
        }
        depDbs[depDbName] = true;
        return doc;
      }
      return upsert(sourceDB, '_local/mrviews', diffFunction).then(function() {
        return sourceDB.registerDependentDatabase(depDbName).then(function(res) {
          var db = res.db;
          db.auto_compaction = true;
          var view = {
            name: depDbName,
            db: db,
            sourceDB: sourceDB,
            adapter: sourceDB.adapter,
            mapFun: mapFun,
            reduceFun: reduceFun
          };
          return view.db.get('_local/lastSeq').catch(function(err) {
            if (err.status !== 404) {
              throw err;
            }
          }).then(function(lastSeqDoc) {
            view.seq = lastSeqDoc ? lastSeqDoc.seq : 0;
            if (!temporary) {
              sourceDB._cachedViews = sourceDB._cachedViews || {};
              sourceDB._cachedViews[viewSignature] = view;
              view.db.once('destroyed', function() {
                delete sourceDB._cachedViews[viewSignature];
              });
            }
            return view;
          });
        });
      });
    });
  }
  function evalfunc(func, emit, sum, log, isArray, toJSON) {
    return scopedEval("return (" + func.replace(/;\s*$/, "") + ");", {
      emit: emit,
      sum: sum,
      log: log,
      isArray: isArray,
      toJSON: toJSON
    });
  }
  var promisedCallback$1 = function(promise, callback) {
    if (callback) {
      promise.then(function(res) {
        process.nextTick(function() {
          callback(null, res);
        });
      }, function(reason) {
        process.nextTick(function() {
          callback(reason);
        });
      });
    }
    return promise;
  };
  var callbackify$1 = function(fun) {
    return getArguments(function(args) {
      var cb = args.pop();
      var promise = fun.apply(this, args);
      if (typeof cb === 'function') {
        promisedCallback$1(promise, cb);
      }
      return promise;
    });
  };
  var fin$1 = function(promise, finalPromiseFactory) {
    return promise.then(function(res) {
      return finalPromiseFactory().then(function() {
        return res;
      });
    }, function(reason) {
      return finalPromiseFactory().then(function() {
        throw reason;
      });
    });
  };
  var sequentialize$1 = function(queue, promiseFactory) {
    return function() {
      var args = arguments;
      var that = this;
      return queue.add(function() {
        return promiseFactory.apply(that, args);
      });
    };
  };
  var uniq$1 = function(arr) {
    var map = {};
    for (var i = 0,
        len = arr.length; i < len; i++) {
      map['$' + arr[i]] = true;
    }
    var keys = Object.keys(map);
    var output = new Array(keys.length);
    for (i = 0, len = keys.length; i < len; i++) {
      output[i] = keys[i].substring(1);
    }
    return output;
  };
  var utils$1 = {
    uniq: uniq$1,
    sequentialize: sequentialize$1,
    fin: fin$1,
    callbackify: callbackify$1,
    promisedCallback: promisedCallback$1
  };
  var collate$1 = pouchCollate__default.collate;
  var toIndexableString = pouchCollate__default.toIndexableString;
  var normalizeKey = pouchCollate__default.normalizeKey;
  var parseIndexableString = pouchCollate__default.parseIndexableString;
  var log$1;
  if ((typeof console !== 'undefined') && (typeof console.log === 'function')) {
    log$1 = Function.prototype.bind.call(console.log, console);
  } else {
    log$1 = function() {};
  }
  var callbackify = utils$1.callbackify;
  var sequentialize = utils$1.sequentialize;
  var uniq = utils$1.uniq;
  var fin = utils$1.fin;
  var promisedCallback = utils$1.promisedCallback;
  var persistentQueues = {};
  var tempViewQueue = new TaskQueue();
  var CHANGES_BATCH_SIZE$1 = 50;
  function parseViewName(name) {
    return name.indexOf('/') === -1 ? [name, name] : name.split('/');
  }
  function isGenOne(changes) {
    return changes.length === 1 && /^1-/.test(changes[0].rev);
  }
  function emitError(db, e) {
    try {
      db.emit('error', e);
    } catch (err) {
      console.error('The user\'s map/reduce function threw an uncaught error.\n' + 'You can debug this error by doing:\n' + 'myDatabase.on(\'error\', function (err) { debugger; });\n' + 'Please double-check your map/reduce function.');
      console.error(e);
    }
  }
  function tryCode(db, fun, args) {
    try {
      return {output: fun.apply(null, args)};
    } catch (e) {
      emitError(db, e);
      return {error: e};
    }
  }
  function sortByKeyThenValue(x, y) {
    var keyCompare = collate$1(x.key, y.key);
    return keyCompare !== 0 ? keyCompare : collate$1(x.value, y.value);
  }
  function sliceResults(results, limit, skip) {
    skip = skip || 0;
    if (typeof limit === 'number') {
      return results.slice(skip, limit + skip);
    } else if (skip > 0) {
      return results.slice(skip);
    }
    return results;
  }
  function rowToDocId(row) {
    var val = row.value;
    var docId = (val && typeof val === 'object' && val._id) || row.id;
    return docId;
  }
  function readAttachmentsAsBlobOrBuffer$1(res) {
    res.rows.forEach(function(row) {
      var atts = row.doc && row.doc._attachments;
      if (!atts) {
        return;
      }
      Object.keys(atts).forEach(function(filename) {
        var att = atts[filename];
        atts[filename].data = b64ToBluffer(att.data, att.content_type);
      });
    });
  }
  function postprocessAttachments(opts) {
    return function(res) {
      if (opts.include_docs && opts.attachments && opts.binary) {
        readAttachmentsAsBlobOrBuffer$1(res);
      }
      return res;
    };
  }
  function createBuiltInError(name) {
    var message = 'builtin ' + name + ' function requires map values to be numbers' + ' or number arrays';
    return new BuiltInError(message);
  }
  function sum(values) {
    var result = 0;
    for (var i = 0,
        len = values.length; i < len; i++) {
      var num = values[i];
      if (typeof num !== 'number') {
        if (Array.isArray(num)) {
          result = typeof result === 'number' ? [result] : result;
          for (var j = 0,
              jLen = num.length; j < jLen; j++) {
            var jNum = num[j];
            if (typeof jNum !== 'number') {
              throw createBuiltInError('_sum');
            } else if (typeof result[j] === 'undefined') {
              result.push(jNum);
            } else {
              result[j] += jNum;
            }
          }
        } else {
          throw createBuiltInError('_sum');
        }
      } else if (typeof result === 'number') {
        result += num;
      } else {
        result[0] += num;
      }
    }
    return result;
  }
  var builtInReduce = {
    _sum: function(keys, values) {
      return sum(values);
    },
    _count: function(keys, values) {
      return values.length;
    },
    _stats: function(keys, values) {
      function sumsqr(values) {
        var _sumsqr = 0;
        for (var i = 0,
            len = values.length; i < len; i++) {
          var num = values[i];
          _sumsqr += (num * num);
        }
        return _sumsqr;
      }
      return {
        sum: sum(values),
        min: Math.min.apply(null, values),
        max: Math.max.apply(null, values),
        count: values.length,
        sumsqr: sumsqr(values)
      };
    }
  };
  function addHttpParam(paramName, opts, params, asJson) {
    var val = opts[paramName];
    if (typeof val !== 'undefined') {
      if (asJson) {
        val = encodeURIComponent(JSON.stringify(val));
      }
      params.push(paramName + '=' + val);
    }
  }
  function coerceInteger(integerCandidate) {
    if (typeof integerCandidate !== 'undefined') {
      var asNumber = Number(integerCandidate);
      if (!isNaN(asNumber) && asNumber === parseInt(integerCandidate, 10)) {
        return asNumber;
      } else {
        return integerCandidate;
      }
    }
  }
  function coerceOptions(opts) {
    opts.group_level = coerceInteger(opts.group_level);
    opts.limit = coerceInteger(opts.limit);
    opts.skip = coerceInteger(opts.skip);
    return opts;
  }
  function checkPositiveInteger(number) {
    if (number) {
      if (typeof number !== 'number') {
        return new QueryParseError('Invalid value for integer: "' + number + '"');
      }
      if (number < 0) {
        return new QueryParseError('Invalid value for positive integer: ' + '"' + number + '"');
      }
    }
  }
  function checkQueryParseError(options, fun) {
    var startkeyName = options.descending ? 'endkey' : 'startkey';
    var endkeyName = options.descending ? 'startkey' : 'endkey';
    if (typeof options[startkeyName] !== 'undefined' && typeof options[endkeyName] !== 'undefined' && collate$1(options[startkeyName], options[endkeyName]) > 0) {
      throw new QueryParseError('No rows can match your key range, ' + 'reverse your start_key and end_key or set {descending : true}');
    } else if (fun.reduce && options.reduce !== false) {
      if (options.include_docs) {
        throw new QueryParseError('{include_docs:true} is invalid for reduce');
      } else if (options.keys && options.keys.length > 1 && !options.group && !options.group_level) {
        throw new QueryParseError('Multi-key fetches for reduce views must use ' + '{group: true}');
      }
    }
    ['group_level', 'limit', 'skip'].forEach(function(optionName) {
      var error = checkPositiveInteger(options[optionName]);
      if (error) {
        throw error;
      }
    });
  }
  function httpQuery(db, fun, opts) {
    var params = [];
    var body;
    var method = 'GET';
    addHttpParam('reduce', opts, params);
    addHttpParam('include_docs', opts, params);
    addHttpParam('attachments', opts, params);
    addHttpParam('limit', opts, params);
    addHttpParam('descending', opts, params);
    addHttpParam('group', opts, params);
    addHttpParam('group_level', opts, params);
    addHttpParam('skip', opts, params);
    addHttpParam('stale', opts, params);
    addHttpParam('conflicts', opts, params);
    addHttpParam('startkey', opts, params, true);
    addHttpParam('start_key', opts, params, true);
    addHttpParam('endkey', opts, params, true);
    addHttpParam('end_key', opts, params, true);
    addHttpParam('inclusive_end', opts, params);
    addHttpParam('key', opts, params, true);
    params = params.join('&');
    params = params === '' ? '' : '?' + params;
    if (typeof opts.keys !== 'undefined') {
      var MAX_URL_LENGTH = 2000;
      var keysAsString = 'keys=' + encodeURIComponent(JSON.stringify(opts.keys));
      if (keysAsString.length + params.length + 1 <= MAX_URL_LENGTH) {
        params += (params[0] === '?' ? '&' : '?') + keysAsString;
      } else {
        method = 'POST';
        if (typeof fun === 'string') {
          body = {keys: opts.keys};
        } else {
          fun.keys = opts.keys;
        }
      }
    }
    if (typeof fun === 'string') {
      var parts = parseViewName(fun);
      return db.request({
        method: method,
        url: '_design/' + parts[0] + '/_view/' + parts[1] + params,
        body: body
      }).then(postprocessAttachments(opts));
    }
    body = body || {};
    Object.keys(fun).forEach(function(key) {
      if (Array.isArray(fun[key])) {
        body[key] = fun[key];
      } else {
        body[key] = fun[key].toString();
      }
    });
    return db.request({
      method: 'POST',
      url: '_temp_view' + params,
      body: body
    }).then(postprocessAttachments(opts));
  }
  function customQuery(db, fun, opts) {
    return new PouchPromise(function(resolve, reject) {
      db._query(fun, opts, function(err, res) {
        if (err) {
          return reject(err);
        }
        resolve(res);
      });
    });
  }
  function customViewCleanup(db) {
    return new PouchPromise(function(resolve, reject) {
      db._viewCleanup(function(err, res) {
        if (err) {
          return reject(err);
        }
        resolve(res);
      });
    });
  }
  function defaultsTo(value) {
    return function(reason) {
      if (reason.status === 404) {
        return value;
      } else {
        throw reason;
      }
    };
  }
  function getDocsToPersist(docId, view, docIdsToChangesAndEmits) {
    var metaDocId = '_local/doc_' + docId;
    var defaultMetaDoc = {
      _id: metaDocId,
      keys: []
    };
    var docData = docIdsToChangesAndEmits[docId];
    var indexableKeysToKeyValues = docData.indexableKeysToKeyValues;
    var changes = docData.changes;
    function getMetaDoc() {
      if (isGenOne(changes)) {
        return PouchPromise.resolve(defaultMetaDoc);
      }
      return view.db.get(metaDocId).catch(defaultsTo(defaultMetaDoc));
    }
    function getKeyValueDocs(metaDoc) {
      if (!metaDoc.keys.length) {
        return PouchPromise.resolve({rows: []});
      }
      return view.db.allDocs({
        keys: metaDoc.keys,
        include_docs: true
      });
    }
    function processKvDocs(metaDoc, kvDocsRes) {
      var kvDocs = [];
      var oldKeysMap = {};
      for (var i = 0,
          len = kvDocsRes.rows.length; i < len; i++) {
        var row = kvDocsRes.rows[i];
        var doc = row.doc;
        if (!doc) {
          continue;
        }
        kvDocs.push(doc);
        oldKeysMap[doc._id] = true;
        doc._deleted = !indexableKeysToKeyValues[doc._id];
        if (!doc._deleted) {
          var keyValue = indexableKeysToKeyValues[doc._id];
          if ('value' in keyValue) {
            doc.value = keyValue.value;
          }
        }
      }
      var newKeys = Object.keys(indexableKeysToKeyValues);
      newKeys.forEach(function(key) {
        if (!oldKeysMap[key]) {
          var kvDoc = {_id: key};
          var keyValue = indexableKeysToKeyValues[key];
          if ('value' in keyValue) {
            kvDoc.value = keyValue.value;
          }
          kvDocs.push(kvDoc);
        }
      });
      metaDoc.keys = uniq(newKeys.concat(metaDoc.keys));
      kvDocs.push(metaDoc);
      return kvDocs;
    }
    return getMetaDoc().then(function(metaDoc) {
      return getKeyValueDocs(metaDoc).then(function(kvDocsRes) {
        return processKvDocs(metaDoc, kvDocsRes);
      });
    });
  }
  function saveKeyValues(view, docIdsToChangesAndEmits, seq) {
    var seqDocId = '_local/lastSeq';
    return view.db.get(seqDocId).catch(defaultsTo({
      _id: seqDocId,
      seq: 0
    })).then(function(lastSeqDoc) {
      var docIds = Object.keys(docIdsToChangesAndEmits);
      return PouchPromise.all(docIds.map(function(docId) {
        return getDocsToPersist(docId, view, docIdsToChangesAndEmits);
      })).then(function(listOfDocsToPersist) {
        var docsToPersist = flatten(listOfDocsToPersist);
        lastSeqDoc.seq = seq;
        docsToPersist.push(lastSeqDoc);
        return view.db.bulkDocs({docs: docsToPersist});
      });
    });
  }
  function getQueue(view) {
    var viewName = typeof view === 'string' ? view : view.name;
    var queue = persistentQueues[viewName];
    if (!queue) {
      queue = persistentQueues[viewName] = new TaskQueue();
    }
    return queue;
  }
  function updateView(view) {
    return sequentialize(getQueue(view), function() {
      return updateViewInQueue(view);
    })();
  }
  function updateViewInQueue(view) {
    var mapResults;
    var doc;
    function emit(key, value) {
      var output = {
        id: doc._id,
        key: normalizeKey(key)
      };
      if (typeof value !== 'undefined' && value !== null) {
        output.value = normalizeKey(value);
      }
      mapResults.push(output);
    }
    var mapFun;
    if (typeof view.mapFun === "function" && view.mapFun.length === 2) {
      var origMap = view.mapFun;
      mapFun = function(doc) {
        return origMap(doc, emit);
      };
    } else {
      mapFun = evalfunc(view.mapFun.toString(), emit, sum, log$1, Array.isArray, JSON.parse);
    }
    var currentSeq = view.seq || 0;
    function processChange(docIdsToChangesAndEmits, seq) {
      return function() {
        return saveKeyValues(view, docIdsToChangesAndEmits, seq);
      };
    }
    var queue = new TaskQueue();
    return new PouchPromise(function(resolve, reject) {
      function complete() {
        queue.finish().then(function() {
          view.seq = currentSeq;
          resolve();
        });
      }
      function processNextBatch() {
        view.sourceDB.changes({
          conflicts: true,
          include_docs: true,
          style: 'all_docs',
          since: currentSeq,
          limit: CHANGES_BATCH_SIZE$1
        }).on('complete', function(response) {
          var results = response.results;
          if (!results.length) {
            return complete();
          }
          var docIdsToChangesAndEmits = {};
          for (var i = 0,
              l = results.length; i < l; i++) {
            var change = results[i];
            if (change.doc._id[0] !== '_') {
              mapResults = [];
              doc = change.doc;
              if (!doc._deleted) {
                tryCode(view.sourceDB, mapFun, [doc]);
              }
              mapResults.sort(sortByKeyThenValue);
              var indexableKeysToKeyValues = {};
              var lastKey;
              for (var j = 0,
                  jl = mapResults.length; j < jl; j++) {
                var obj = mapResults[j];
                var complexKey = [obj.key, obj.id];
                if (collate$1(obj.key, lastKey) === 0) {
                  complexKey.push(j);
                }
                var indexableKey = toIndexableString(complexKey);
                indexableKeysToKeyValues[indexableKey] = obj;
                lastKey = obj.key;
              }
              docIdsToChangesAndEmits[change.doc._id] = {
                indexableKeysToKeyValues: indexableKeysToKeyValues,
                changes: change.changes
              };
            }
            currentSeq = change.seq;
          }
          queue.add(processChange(docIdsToChangesAndEmits, currentSeq));
          if (results.length < CHANGES_BATCH_SIZE$1) {
            return complete();
          }
          return processNextBatch();
        }).on('error', onError);
        function onError(err) {
          reject(err);
        }
      }
      processNextBatch();
    });
  }
  function reduceView(view, results, options) {
    if (options.group_level === 0) {
      delete options.group_level;
    }
    var shouldGroup = options.group || options.group_level;
    var reduceFun;
    if (builtInReduce[view.reduceFun]) {
      reduceFun = builtInReduce[view.reduceFun];
    } else {
      reduceFun = evalfunc(view.reduceFun.toString(), null, sum, log$1, Array.isArray, JSON.parse);
    }
    var groups = [];
    var lvl = options.group_level;
    results.forEach(function(e) {
      var last = groups[groups.length - 1];
      var key = shouldGroup ? e.key : null;
      if (shouldGroup && Array.isArray(key) && typeof lvl === 'number') {
        key = key.length > lvl ? key.slice(0, lvl) : key;
      }
      if (last && collate$1(last.key[0][0], key) === 0) {
        last.key.push([key, e.id]);
        last.value.push(e.value);
        return;
      }
      groups.push({
        key: [[key, e.id]],
        value: [e.value]
      });
    });
    for (var i = 0,
        len = groups.length; i < len; i++) {
      var e = groups[i];
      var reduceTry = tryCode(view.sourceDB, reduceFun, [e.key, e.value, false]);
      if (reduceTry.error && reduceTry.error instanceof BuiltInError) {
        throw reduceTry.error;
      }
      e.value = reduceTry.error ? null : reduceTry.output;
      e.key = e.key[0][0];
    }
    return {rows: sliceResults(groups, options.limit, options.skip)};
  }
  function queryView(view, opts) {
    return sequentialize(getQueue(view), function() {
      return queryViewInQueue(view, opts);
    })();
  }
  function queryViewInQueue(view, opts) {
    var totalRows;
    var shouldReduce = view.reduceFun && opts.reduce !== false;
    var skip = opts.skip || 0;
    if (typeof opts.keys !== 'undefined' && !opts.keys.length) {
      opts.limit = 0;
      delete opts.keys;
    }
    function fetchFromView(viewOpts) {
      viewOpts.include_docs = true;
      return view.db.allDocs(viewOpts).then(function(res) {
        totalRows = res.total_rows;
        return res.rows.map(function(result) {
          if ('value' in result.doc && typeof result.doc.value === 'object' && result.doc.value !== null) {
            var keys = Object.keys(result.doc.value).sort();
            var expectedKeys = ['id', 'key', 'value'];
            if (!(keys < expectedKeys || keys > expectedKeys)) {
              return result.doc.value;
            }
          }
          var parsedKeyAndDocId = parseIndexableString(result.doc._id);
          return {
            key: parsedKeyAndDocId[0],
            id: parsedKeyAndDocId[1],
            value: ('value' in result.doc ? result.doc.value : null)
          };
        });
      });
    }
    function onMapResultsReady(rows) {
      var finalResults;
      if (shouldReduce) {
        finalResults = reduceView(view, rows, opts);
      } else {
        finalResults = {
          total_rows: totalRows,
          offset: skip,
          rows: rows
        };
      }
      if (opts.include_docs) {
        var docIds = uniq(rows.map(rowToDocId));
        return view.sourceDB.allDocs({
          keys: docIds,
          include_docs: true,
          conflicts: opts.conflicts,
          attachments: opts.attachments,
          binary: opts.binary
        }).then(function(allDocsRes) {
          var docIdsToDocs = {};
          allDocsRes.rows.forEach(function(row) {
            if (row.doc) {
              docIdsToDocs['$' + row.id] = row.doc;
            }
          });
          rows.forEach(function(row) {
            var docId = rowToDocId(row);
            var doc = docIdsToDocs['$' + docId];
            if (doc) {
              row.doc = doc;
            }
          });
          return finalResults;
        });
      } else {
        return finalResults;
      }
    }
    if (typeof opts.keys !== 'undefined') {
      var keys = opts.keys;
      var fetchPromises = keys.map(function(key) {
        var viewOpts = {
          startkey: toIndexableString([key]),
          endkey: toIndexableString([key, {}])
        };
        return fetchFromView(viewOpts);
      });
      return PouchPromise.all(fetchPromises).then(flatten).then(onMapResultsReady);
    } else {
      var viewOpts = {descending: opts.descending};
      if (opts.start_key) {
        opts.startkey = opts.start_key;
      }
      if (opts.end_key) {
        opts.endkey = opts.end_key;
      }
      if (typeof opts.startkey !== 'undefined') {
        viewOpts.startkey = opts.descending ? toIndexableString([opts.startkey, {}]) : toIndexableString([opts.startkey]);
      }
      if (typeof opts.endkey !== 'undefined') {
        var inclusiveEnd = opts.inclusive_end !== false;
        if (opts.descending) {
          inclusiveEnd = !inclusiveEnd;
        }
        viewOpts.endkey = toIndexableString(inclusiveEnd ? [opts.endkey, {}] : [opts.endkey]);
      }
      if (typeof opts.key !== 'undefined') {
        var keyStart = toIndexableString([opts.key]);
        var keyEnd = toIndexableString([opts.key, {}]);
        if (viewOpts.descending) {
          viewOpts.endkey = keyStart;
          viewOpts.startkey = keyEnd;
        } else {
          viewOpts.startkey = keyStart;
          viewOpts.endkey = keyEnd;
        }
      }
      if (!shouldReduce) {
        if (typeof opts.limit === 'number') {
          viewOpts.limit = opts.limit;
        }
        viewOpts.skip = skip;
      }
      return fetchFromView(viewOpts).then(onMapResultsReady);
    }
  }
  function httpViewCleanup(db) {
    return db.request({
      method: 'POST',
      url: '_view_cleanup'
    });
  }
  function localViewCleanup(db) {
    return db.get('_local/mrviews').then(function(metaDoc) {
      var docsToViews = {};
      Object.keys(metaDoc.views).forEach(function(fullViewName) {
        var parts = parseViewName(fullViewName);
        var designDocName = '_design/' + parts[0];
        var viewName = parts[1];
        docsToViews[designDocName] = docsToViews[designDocName] || {};
        docsToViews[designDocName][viewName] = true;
      });
      var opts = {
        keys: Object.keys(docsToViews),
        include_docs: true
      };
      return db.allDocs(opts).then(function(res) {
        var viewsToStatus = {};
        res.rows.forEach(function(row) {
          var ddocName = row.key.substring(8);
          Object.keys(docsToViews[row.key]).forEach(function(viewName) {
            var fullViewName = ddocName + '/' + viewName;
            if (!metaDoc.views[fullViewName]) {
              fullViewName = viewName;
            }
            var viewDBNames = Object.keys(metaDoc.views[fullViewName]);
            var statusIsGood = row.doc && row.doc.views && row.doc.views[viewName];
            viewDBNames.forEach(function(viewDBName) {
              viewsToStatus[viewDBName] = viewsToStatus[viewDBName] || statusIsGood;
            });
          });
        });
        var dbsToDelete = Object.keys(viewsToStatus).filter(function(viewDBName) {
          return !viewsToStatus[viewDBName];
        });
        var destroyPromises = dbsToDelete.map(function(viewDBName) {
          return sequentialize(getQueue(viewDBName), function() {
            return new db.constructor(viewDBName, db.__opts).destroy();
          })();
        });
        return PouchPromise.all(destroyPromises).then(function() {
          return {ok: true};
        });
      });
    }, defaultsTo({ok: true}));
  }
  var viewCleanup = callbackify(function() {
    var db = this;
    if (db.type() === 'http') {
      return httpViewCleanup(db);
    }
    if (typeof db._viewCleanup === 'function') {
      return customViewCleanup(db);
    }
    return localViewCleanup(db);
  });
  function queryPromised(db, fun, opts) {
    if (db.type() === 'http') {
      return httpQuery(db, fun, opts);
    }
    if (typeof db._query === 'function') {
      return customQuery(db, fun, opts);
    }
    if (typeof fun !== 'string') {
      checkQueryParseError(opts, fun);
      var createViewOpts = {
        db: db,
        viewName: 'temp_view/temp_view',
        map: fun.map,
        reduce: fun.reduce,
        temporary: true
      };
      tempViewQueue.add(function() {
        return createView(createViewOpts).then(function(view) {
          function cleanup() {
            return view.db.destroy();
          }
          return fin(updateView(view).then(function() {
            return queryView(view, opts);
          }), cleanup);
        });
      });
      return tempViewQueue.finish();
    } else {
      var fullViewName = fun;
      var parts = parseViewName(fullViewName);
      var designDocName = parts[0];
      var viewName = parts[1];
      return db.get('_design/' + designDocName).then(function(doc) {
        var fun = doc.views && doc.views[viewName];
        if (!fun || typeof fun.map !== 'string') {
          throw new NotFoundError('ddoc ' + designDocName + ' has no view named ' + viewName);
        }
        checkQueryParseError(opts, fun);
        var createViewOpts = {
          db: db,
          viewName: fullViewName,
          map: fun.map,
          reduce: fun.reduce
        };
        return createView(createViewOpts).then(function(view) {
          if (opts.stale === 'ok' || opts.stale === 'update_after') {
            if (opts.stale === 'update_after') {
              process.nextTick(function() {
                updateView(view);
              });
            }
            return queryView(view, opts);
          } else {
            return updateView(view).then(function() {
              return queryView(view, opts);
            });
          }
        });
      });
    }
  }
  var query = function(fun, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = opts ? coerceOptions(opts) : {};
    if (typeof fun === 'function') {
      fun = {map: fun};
    }
    var db = this;
    var promise = PouchPromise.resolve().then(function() {
      return queryPromised(db, fun, opts);
    });
    promisedCallback(promise, callback);
    return promise;
  };
  function QueryParseError(message) {
    this.status = 400;
    this.name = 'query_parse_error';
    this.message = message;
    this.error = true;
    try {
      Error.captureStackTrace(this, QueryParseError);
    } catch (e) {}
  }
  inherits(QueryParseError, Error);
  function NotFoundError(message) {
    this.status = 404;
    this.name = 'not_found';
    this.message = message;
    this.error = true;
    try {
      Error.captureStackTrace(this, NotFoundError);
    } catch (e) {}
  }
  inherits(NotFoundError, Error);
  function BuiltInError(message) {
    this.status = 500;
    this.name = 'invalid_value';
    this.message = message;
    this.error = true;
    try {
      Error.captureStackTrace(this, BuiltInError);
    } catch (e) {}
  }
  inherits(BuiltInError, Error);
  var mapreduce = {
    query: query,
    viewCleanup: viewCleanup
  };
  function isChromeApp() {
    return false;
  }
  inherits(Changes, events.EventEmitter);
  function attachBrowserEvents(self) {
    if (isChromeApp()) {
      chrome.storage.onChanged.addListener(function(e) {
        if (e.db_name != null) {
          self.emit(e.dbName.newValue);
        }
      });
    } else if (hasLocalStorage()) {
      if (typeof addEventListener !== 'undefined') {
        addEventListener("storage", function(e) {
          self.emit(e.key);
        });
      } else {
        window.attachEvent("storage", function(e) {
          self.emit(e.key);
        });
      }
    }
  }
  function Changes() {
    events.EventEmitter.call(this);
    this._listeners = {};
    attachBrowserEvents(this);
  }
  Changes.prototype.addListener = function(dbName, id, db, opts) {
    if (this._listeners[id]) {
      return;
    }
    var self = this;
    var inprogress = false;
    function eventFunction() {
      if (!self._listeners[id]) {
        return;
      }
      if (inprogress) {
        inprogress = 'waiting';
        return;
      }
      inprogress = true;
      var changesOpts = pick(opts, ['style', 'include_docs', 'attachments', 'conflicts', 'filter', 'doc_ids', 'view', 'since', 'query_params', 'binary']);
      function onError() {
        inprogress = false;
      }
      db.changes(changesOpts).on('change', function(c) {
        if (c.seq > opts.since && !opts.cancelled) {
          opts.since = c.seq;
          opts.onChange(c);
        }
      }).on('complete', function() {
        if (inprogress === 'waiting') {
          setTimeout(function() {
            eventFunction();
          }, 0);
        }
        inprogress = false;
      }).on('error', onError);
    }
    this._listeners[id] = eventFunction;
    this.on(dbName, eventFunction);
  };
  Changes.prototype.removeListener = function(dbName, id) {
    if (!(id in this._listeners)) {
      return;
    }
    events.EventEmitter.prototype.removeListener.call(this, dbName, this._listeners[id]);
  };
  Changes.prototype.notifyLocalWindows = function(dbName) {
    if (isChromeApp()) {
      chrome.storage.local.set({dbName: dbName});
    } else if (hasLocalStorage()) {
      localStorage[dbName] = (localStorage[dbName] === "a") ? "b" : "a";
    }
  };
  Changes.prototype.notify = function(dbName) {
    this.emit(dbName);
    this.notifyLocalWindows(dbName);
  };
  function safeJsonParse(str) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return vuvuzela.parse(str);
    }
  }
  function safeJsonStringify(json) {
    try {
      return JSON.stringify(json);
    } catch (e) {
      return vuvuzela.stringify(json);
    }
  }
  function compactTree(metadata) {
    var revs = [];
    traverseRevTree(metadata.rev_tree, function(isLeaf, pos, revHash, ctx, opts) {
      if (opts.status === 'available' && !isLeaf) {
        revs.push(pos + '-' + revHash);
        opts.status = 'missing';
      }
    });
    return revs;
  }
  function sortByPos$1(a, b) {
    return a.pos - b.pos;
  }
  function binarySearch(arr, item, comparator) {
    var low = 0;
    var high = arr.length;
    var mid;
    while (low < high) {
      mid = (low + high) >>> 1;
      if (comparator(arr[mid], item) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }
  function insertSorted(arr, item, comparator) {
    var idx = binarySearch(arr, item, comparator);
    arr.splice(idx, 0, item);
  }
  function pathToTree(path, numStemmed) {
    var root;
    var leaf;
    for (var i = numStemmed,
        len = path.length; i < len; i++) {
      var node = path[i];
      var currentLeaf = [node.id, node.opts, []];
      if (leaf) {
        leaf[2].push(currentLeaf);
        leaf = currentLeaf;
      } else {
        root = leaf = currentLeaf;
      }
    }
    return root;
  }
  function compareTree(a, b) {
    return a[0] < b[0] ? -1 : 1;
  }
  function mergeTree(in_tree1, in_tree2) {
    var queue = [{
      tree1: in_tree1,
      tree2: in_tree2
    }];
    var conflicts = false;
    while (queue.length > 0) {
      var item = queue.pop();
      var tree1 = item.tree1;
      var tree2 = item.tree2;
      if (tree1[1].status || tree2[1].status) {
        tree1[1].status = (tree1[1].status === 'available' || tree2[1].status === 'available') ? 'available' : 'missing';
      }
      for (var i = 0; i < tree2[2].length; i++) {
        if (!tree1[2][0]) {
          conflicts = 'new_leaf';
          tree1[2][0] = tree2[2][i];
          continue;
        }
        var merged = false;
        for (var j = 0; j < tree1[2].length; j++) {
          if (tree1[2][j][0] === tree2[2][i][0]) {
            queue.push({
              tree1: tree1[2][j],
              tree2: tree2[2][i]
            });
            merged = true;
          }
        }
        if (!merged) {
          conflicts = 'new_branch';
          insertSorted(tree1[2], tree2[2][i], compareTree);
        }
      }
    }
    return {
      conflicts: conflicts,
      tree: in_tree1
    };
  }
  function doMerge(tree, path, dontExpand) {
    var restree = [];
    var conflicts = false;
    var merged = false;
    var res;
    if (!tree.length) {
      return {
        tree: [path],
        conflicts: 'new_leaf'
      };
    }
    for (var i = 0,
        len = tree.length; i < len; i++) {
      var branch = tree[i];
      if (branch.pos === path.pos && branch.ids[0] === path.ids[0]) {
        res = mergeTree(branch.ids, path.ids);
        restree.push({
          pos: branch.pos,
          ids: res.tree
        });
        conflicts = conflicts || res.conflicts;
        merged = true;
      } else if (dontExpand !== true) {
        var t1 = branch.pos < path.pos ? branch : path;
        var t2 = branch.pos < path.pos ? path : branch;
        var diff = t2.pos - t1.pos;
        var candidateParents = [];
        var trees = [];
        trees.push({
          ids: t1.ids,
          diff: diff,
          parent: null,
          parentIdx: null
        });
        while (trees.length > 0) {
          var item = trees.pop();
          if (item.diff === 0) {
            if (item.ids[0] === t2.ids[0]) {
              candidateParents.push(item);
            }
            continue;
          }
          var elements = item.ids[2];
          for (var j = 0,
              elementsLen = elements.length; j < elementsLen; j++) {
            trees.push({
              ids: elements[j],
              diff: item.diff - 1,
              parent: item.ids,
              parentIdx: j
            });
          }
        }
        var el = candidateParents[0];
        if (!el) {
          restree.push(branch);
        } else {
          res = mergeTree(el.ids, t2.ids);
          el.parent[2][el.parentIdx] = res.tree;
          restree.push({
            pos: t1.pos,
            ids: t1.ids
          });
          conflicts = conflicts || res.conflicts;
          merged = true;
        }
      } else {
        restree.push(branch);
      }
    }
    if (!merged) {
      restree.push(path);
    }
    restree.sort(sortByPos$1);
    return {
      tree: restree,
      conflicts: conflicts || 'internal_node'
    };
  }
  function stem(tree, depth) {
    var paths = rootToLeaf(tree);
    var result;
    for (var i = 0,
        len = paths.length; i < len; i++) {
      var path = paths[i];
      var stemmed = path.ids;
      var numStemmed = Math.max(0, stemmed.length - depth);
      var stemmedNode = {
        pos: path.pos + numStemmed,
        ids: pathToTree(stemmed, numStemmed)
      };
      if (result) {
        result = doMerge(result, stemmedNode, true).tree;
      } else {
        result = [stemmedNode];
      }
    }
    return result;
  }
  function merge(tree, path, depth) {
    var newTree = doMerge(tree, path);
    return {
      tree: stem(newTree.tree, depth),
      conflicts: newTree.conflicts
    };
  }
  function revExists(revs, rev) {
    var toVisit = revs.slice();
    var splitRev = rev.split('-');
    var targetPos = parseInt(splitRev[0], 10);
    var targetId = splitRev[1];
    var node;
    while ((node = toVisit.pop())) {
      if (node.pos === targetPos && node.ids[0] === targetId) {
        return true;
      }
      var branches = node.ids[2];
      for (var i = 0,
          len = branches.length; i < len; i++) {
        toVisit.push({
          pos: node.pos + 1,
          ids: branches[i]
        });
      }
    }
    return false;
  }
  function updateDoc(revLimit, prev, docInfo, results, i, cb, writeDoc, newEdits) {
    if (revExists(prev.rev_tree, docInfo.metadata.rev)) {
      results[i] = docInfo;
      return cb();
    }
    var previousWinningRev = prev.winningRev || winningRev(prev);
    var previouslyDeleted = 'deleted' in prev ? prev.deleted : isDeleted(prev, previousWinningRev);
    var deleted = 'deleted' in docInfo.metadata ? docInfo.metadata.deleted : isDeleted(docInfo.metadata);
    var isRoot = /^1-/.test(docInfo.metadata.rev);
    if (previouslyDeleted && !deleted && newEdits && isRoot) {
      var newDoc = docInfo.data;
      newDoc._rev = previousWinningRev;
      newDoc._id = docInfo.metadata.id;
      docInfo = parseDoc(newDoc, newEdits);
    }
    var merged = merge(prev.rev_tree, docInfo.metadata.rev_tree[0], revLimit);
    var inConflict = newEdits && (((previouslyDeleted && deleted) || (!previouslyDeleted && merged.conflicts !== 'new_leaf') || (previouslyDeleted && !deleted && merged.conflicts === 'new_branch')));
    if (inConflict) {
      var err = createError(REV_CONFLICT);
      results[i] = err;
      return cb();
    }
    var newRev = docInfo.metadata.rev;
    docInfo.metadata.rev_tree = merged.tree;
    if (prev.rev_map) {
      docInfo.metadata.rev_map = prev.rev_map;
    }
    var winningRev$$ = winningRev(docInfo.metadata);
    var winningRevIsDeleted = isDeleted(docInfo.metadata, winningRev$$);
    var delta = (previouslyDeleted === winningRevIsDeleted) ? 0 : previouslyDeleted < winningRevIsDeleted ? -1 : 1;
    var newRevIsDeleted;
    if (newRev === winningRev$$) {
      newRevIsDeleted = winningRevIsDeleted;
    } else {
      newRevIsDeleted = isDeleted(docInfo.metadata, newRev);
    }
    writeDoc(docInfo, winningRev$$, winningRevIsDeleted, newRevIsDeleted, true, delta, i, cb);
  }
  function rootIsMissing(docInfo) {
    return docInfo.metadata.rev_tree[0].ids[1].status === 'missing';
  }
  function processDocs(revLimit, docInfos, api, fetchedDocs, tx, results, writeDoc, opts, overallCallback) {
    revLimit = revLimit || 1000;
    function insertDoc(docInfo, resultsIdx, callback) {
      var winningRev$$ = winningRev(docInfo.metadata);
      var deleted = isDeleted(docInfo.metadata, winningRev$$);
      if ('was_delete' in opts && deleted) {
        results[resultsIdx] = createError(MISSING_DOC, 'deleted');
        return callback();
      }
      var inConflict = newEdits && rootIsMissing(docInfo);
      if (inConflict) {
        var err = createError(REV_CONFLICT);
        results[resultsIdx] = err;
        return callback();
      }
      var delta = deleted ? 0 : 1;
      writeDoc(docInfo, winningRev$$, deleted, deleted, false, delta, resultsIdx, callback);
    }
    var newEdits = opts.new_edits;
    var idsToDocs = new collections.Map();
    var docsDone = 0;
    var docsToDo = docInfos.length;
    function checkAllDocsDone() {
      if (++docsDone === docsToDo && overallCallback) {
        overallCallback();
      }
    }
    docInfos.forEach(function(currentDoc, resultsIdx) {
      if (currentDoc._id && isLocalId(currentDoc._id)) {
        var fun = currentDoc._deleted ? '_removeLocal' : '_putLocal';
        api[fun](currentDoc, {ctx: tx}, function(err, res) {
          results[resultsIdx] = err || res;
          checkAllDocsDone();
        });
        return;
      }
      var id = currentDoc.metadata.id;
      if (idsToDocs.has(id)) {
        docsToDo--;
        idsToDocs.get(id).push([currentDoc, resultsIdx]);
      } else {
        idsToDocs.set(id, [[currentDoc, resultsIdx]]);
      }
    });
    idsToDocs.forEach(function(docs, id) {
      var numDone = 0;
      function docWritten() {
        if (++numDone < docs.length) {
          nextDoc();
        } else {
          checkAllDocsDone();
        }
      }
      function nextDoc() {
        var value = docs[numDone];
        var currentDoc = value[0];
        var resultsIdx = value[1];
        if (fetchedDocs.has(id)) {
          updateDoc(revLimit, fetchedDocs.get(id), currentDoc, results, resultsIdx, docWritten, writeDoc, newEdits);
        } else {
          var merged = merge([], currentDoc.metadata.rev_tree[0], revLimit);
          currentDoc.metadata.rev_tree = merged.tree;
          insertDoc(currentDoc, resultsIdx, docWritten);
        }
      }
      nextDoc();
    });
  }
  var stores = ['document-store', 'by-sequence', 'attach-store', 'attach-binary-store'];
  function formatSeq(n) {
    return ('0000000000000000' + n).slice(-16);
  }
  var UPDATE_SEQ_KEY$1 = '_local_last_update_seq';
  var DOC_COUNT_KEY$1 = '_local_doc_count';
  var UUID_KEY$1 = '_local_uuid';
  var toSublevel = function(name, db, callback) {
    var leveldown = require('@empty');
    var base = path.resolve(name);
    function move(store, index, cb) {
      var storePath = path.join(base, store);
      var opts;
      if (index === 3) {
        opts = {valueEncoding: 'binary'};
      } else {
        opts = {valueEncoding: 'json'};
      }
      var sub = db.sublevel(store, opts);
      var orig = levelup(storePath, opts);
      var from = orig.createReadStream();
      var writeStream = new LevelWriteStream(sub);
      var to = writeStream();
      from.on('end', function() {
        orig.close(function(err) {
          cb(err, storePath);
        });
      });
      from.pipe(to);
    }
    fs.unlink(base + '.uuid', function(err) {
      if (err) {
        return callback();
      }
      var todo = 4;
      var done = [];
      stores.forEach(function(store, i) {
        move(store, i, function(err, storePath) {
          if (err) {
            return callback(err);
          }
          done.push(storePath);
          if (!(--todo)) {
            done.forEach(function(item) {
              leveldown.destroy(item, function() {
                if (++todo === done.length) {
                  fs.rmdir(base, callback);
                }
              });
            });
          }
        });
      });
    });
  };
  var localAndMetaStores = function(db, stores, callback) {
    var batches = [];
    stores.bySeqStore.get(UUID_KEY$1, function(err, value) {
      if (err) {
        return callback();
      }
      batches.push({
        key: UUID_KEY$1,
        value: value,
        prefix: stores.metaStore,
        type: 'put',
        valueEncoding: 'json'
      });
      batches.push({
        key: UUID_KEY$1,
        prefix: stores.bySeqStore,
        type: 'del'
      });
      stores.bySeqStore.get(DOC_COUNT_KEY$1, function(err, value) {
        if (value) {
          batches.push({
            key: DOC_COUNT_KEY$1,
            value: value,
            prefix: stores.metaStore,
            type: 'put',
            valueEncoding: 'json'
          });
          batches.push({
            key: DOC_COUNT_KEY$1,
            prefix: stores.bySeqStore,
            type: 'del'
          });
        }
        stores.bySeqStore.get(UPDATE_SEQ_KEY$1, function(err, value) {
          if (value) {
            batches.push({
              key: UPDATE_SEQ_KEY$1,
              value: value,
              prefix: stores.metaStore,
              type: 'put',
              valueEncoding: 'json'
            });
            batches.push({
              key: UPDATE_SEQ_KEY$1,
              prefix: stores.bySeqStore,
              type: 'del'
            });
          }
          var deletedSeqs = {};
          stores.docStore.createReadStream({
            startKey: '_',
            endKey: '_\xFF'
          }).pipe(through2.obj(function(ch, _, next) {
            if (!isLocalId(ch.key)) {
              return next();
            }
            batches.push({
              key: ch.key,
              prefix: stores.docStore,
              type: 'del'
            });
            var winner = winningRev(ch.value);
            Object.keys(ch.value.rev_map).forEach(function(key) {
              if (key !== 'winner') {
                this.push(formatSeq(ch.value.rev_map[key]));
              }
            }, this);
            var winningSeq = ch.value.rev_map[winner];
            stores.bySeqStore.get(formatSeq(winningSeq), function(err, value) {
              if (!err) {
                batches.push({
                  key: ch.key,
                  value: value,
                  prefix: stores.localStore,
                  type: 'put',
                  valueEncoding: 'json'
                });
              }
              next();
            });
          })).pipe(through2.obj(function(seq, _, next) {
            if (deletedSeqs[seq]) {
              return next();
            }
            deletedSeqs[seq] = true;
            stores.bySeqStore.get(seq, function(err, resp) {
              if (err || !isLocalId(resp._id)) {
                return next();
              }
              batches.push({
                key: seq,
                prefix: stores.bySeqStore,
                type: 'del'
              });
              next();
            });
          }, function(next) {
            db.batch(batches, callback);
          }));
        });
      });
    });
  };
  var migrate = {
    toSublevel: toSublevel,
    localAndMetaStores: localAndMetaStores
  };
  function f() {}
  var hasName = f.name;
  var res$2;
  if (hasName) {
    res$2 = function(fun) {
      return fun.name;
    };
  } else {
    res$2 = function(fun) {
      return fun.toString().match(/^\s*function\s*(\S*)\s*\(/)[1];
    };
  }
  var functionName = res$2;
  function readAsBlobOrBuffer(storedObject, type) {
    storedObject.type = type;
    return storedObject;
  }
  function prepareAttachmentForStorage(attData, cb) {
    process.nextTick(function() {
      cb(attData);
    });
  }
  function createEmptyBlobOrBuffer(type) {
    return typedBuffer('', 'binary', type);
  }
  function getCacheFor(transaction, store) {
    var prefix = store.prefix()[0];
    var cache = transaction._cache;
    var subCache = cache.get(prefix);
    if (!subCache) {
      subCache = new collections.Map();
      cache.set(prefix, subCache);
    }
    return subCache;
  }
  function LevelTransaction() {
    this._batch = [];
    this._cache = new collections.Map();
  }
  LevelTransaction.prototype.get = function(store, key, callback) {
    var cache = getCacheFor(this, store);
    var exists = cache.get(key);
    if (exists) {
      return process.nextTick(function() {
        callback(null, exists);
      });
    } else if (exists === null) {
      return process.nextTick(function() {
        callback({name: 'NotFoundError'});
      });
    }
    store.get(key, function(err, res) {
      if (err) {
        if (err.name === 'NotFoundError') {
          cache.set(key, null);
        }
        return callback(err);
      }
      cache.set(key, res);
      callback(null, res);
    });
  };
  LevelTransaction.prototype.batch = function(batch) {
    for (var i = 0,
        len = batch.length; i < len; i++) {
      var operation = batch[i];
      var cache = getCacheFor(this, operation.prefix);
      if (operation.type === 'put') {
        cache.set(operation.key, operation.value);
      } else {
        cache.set(operation.key, null);
      }
    }
    this._batch = this._batch.concat(batch);
  };
  LevelTransaction.prototype.execute = function(db, callback) {
    var keys = new collections.Set();
    var uniqBatches = [];
    for (var i = this._batch.length - 1; i >= 0; i--) {
      var operation = this._batch[i];
      var lookupKey = operation.prefix.prefix()[0] + '\xff' + operation.key;
      if (keys.has(lookupKey)) {
        continue;
      }
      keys.add(lookupKey);
      uniqBatches.push(operation);
    }
    db.batch(uniqBatches, callback);
  };
  var DOC_STORE = 'document-store';
  var BY_SEQ_STORE = 'by-sequence';
  var ATTACHMENT_STORE = 'attach-store';
  var BINARY_STORE = 'attach-binary-store';
  var LOCAL_STORE = 'local-store';
  var META_STORE = 'meta-store';
  var dbStores = new collections.Map();
  var UPDATE_SEQ_KEY = '_local_last_update_seq';
  var DOC_COUNT_KEY = '_local_doc_count';
  var UUID_KEY = '_local_uuid';
  var MD5_PREFIX = 'md5-';
  var safeJsonEncoding = {
    encode: safeJsonStringify,
    decode: safeJsonParse,
    buffer: false,
    type: 'cheap-json'
  };
  var requireLeveldown = function() {
    try {
      return require('@empty');
    } catch (err) {
      err = err || 'leveldown import error';
      if (err.code === 'MODULE_NOT_FOUND') {
        return new Error(['the \'leveldown\' package is not available. install it, or,', 'specify another storage backend using the \'db\' option'].join(' '));
      } else if (err.message && err.message.match('Module version mismatch')) {
        return new Error([err.message, 'This generally implies that leveldown was built with a different', 'version of node than that which is running now.  You may try', 'fully removing and reinstalling PouchDB or leveldown to resolve.'].join(' '));
      }
      return new Error(err.toString() + ': unable to import leveldown');
    }
  };
  function getWinningRev(metadata) {
    return 'winningRev' in metadata ? metadata.winningRev : winningRev(metadata);
  }
  function getIsDeleted(metadata, winningRev) {
    return 'deleted' in metadata ? metadata.deleted : isDeleted(metadata, winningRev);
  }
  function fetchAttachment(att, stores, opts) {
    var type = att.content_type;
    return new PouchPromise(function(resolve, reject) {
      stores.binaryStore.get(att.digest, function(err, buffer) {
        var data;
        if (err) {
          if (err.name !== 'NotFoundError') {
            return reject(err);
          } else {
            if (!opts.binary) {
              data = '';
            } else {
              data = binStringToBluffer('', type);
            }
          }
        } else {
          if (opts.binary) {
            data = readAsBlobOrBuffer(buffer, type);
          } else {
            data = buffer.toString('base64');
          }
        }
        delete att.stub;
        delete att.length;
        att.data = data;
        resolve();
      });
    });
  }
  function fetchAttachments(results, stores, opts) {
    var atts = [];
    results.forEach(function(row) {
      if (!(row.doc && row.doc._attachments)) {
        return;
      }
      var attNames = Object.keys(row.doc._attachments);
      attNames.forEach(function(attName) {
        var att = row.doc._attachments[attName];
        if (!('data' in att)) {
          atts.push(att);
        }
      });
    });
    return PouchPromise.all(atts.map(function(att) {
      return fetchAttachment(att, stores, opts);
    }));
  }
  function LevelPouch(opts, callback) {
    opts = clone(opts);
    var api = this;
    var instanceId;
    var stores = {};
    var revLimit = opts.revs_limit;
    var db;
    var name = opts.name;
    if (typeof opts.createIfMissing === 'undefined') {
      opts.createIfMissing = true;
    }
    var leveldown = opts.db || requireLeveldown();
    if (leveldown instanceof Error) {
      return callback(leveldown);
    }
    if (typeof leveldown.destroy !== 'function') {
      leveldown.destroy = function(name, cb) {
        cb();
      };
    }
    var dbStore;
    var leveldownName = functionName(leveldown);
    if (dbStores.has(leveldownName)) {
      dbStore = dbStores.get(leveldownName);
    } else {
      dbStore = new collections.Map();
      dbStores.set(leveldownName, dbStore);
    }
    if (dbStore.has(name)) {
      db = dbStore.get(name);
      afterDBCreated();
    } else {
      dbStore.set(name, sublevel(levelup(name, opts, function(err) {
        if (err) {
          dbStore.delete(name);
          return callback(err);
        }
        db = dbStore.get(name);
        db._docCount = -1;
        db._queue = new Deque();
        if (opts.db || opts.noMigrate) {
          afterDBCreated();
        } else {
          migrate.toSublevel(name, db, afterDBCreated);
        }
      })));
    }
    function afterDBCreated() {
      stores.docStore = db.sublevel(DOC_STORE, {valueEncoding: safeJsonEncoding});
      stores.bySeqStore = db.sublevel(BY_SEQ_STORE, {valueEncoding: 'json'});
      stores.attachmentStore = db.sublevel(ATTACHMENT_STORE, {valueEncoding: 'json'});
      stores.binaryStore = db.sublevel(BINARY_STORE, {valueEncoding: 'binary'});
      stores.localStore = db.sublevel(LOCAL_STORE, {valueEncoding: 'json'});
      stores.metaStore = db.sublevel(META_STORE, {valueEncoding: 'json'});
      migrate.localAndMetaStores(db, stores, function() {
        stores.metaStore.get(UPDATE_SEQ_KEY, function(err, value) {
          if (typeof db._updateSeq === 'undefined') {
            db._updateSeq = value || 0;
          }
          stores.metaStore.get(DOC_COUNT_KEY, function(err, value) {
            db._docCount = !err ? value : 0;
            stores.metaStore.get(UUID_KEY, function(err, value) {
              instanceId = !err ? value : uuid();
              stores.metaStore.put(UUID_KEY, instanceId, function(err, value) {
                process.nextTick(function() {
                  callback(null, api);
                });
              });
            });
          });
        });
      });
    }
    function countDocs(callback) {
      if (db.isClosed()) {
        return callback(new Error('database is closed'));
      }
      return callback(null, db._docCount);
    }
    api.type = function() {
      return 'leveldb';
    };
    api._id = function(callback) {
      callback(null, instanceId);
    };
    api._info = function(callback) {
      var res = {
        doc_count: db._docCount,
        update_seq: db._updateSeq,
        backend_adapter: functionName(leveldown)
      };
      return process.nextTick(function() {
        callback(null, res);
      });
    };
    function tryCode(fun, args) {
      try {
        fun.apply(null, args);
      } catch (err) {
        args[args.length - 1](err);
      }
    }
    function executeNext() {
      var firstTask = db._queue.peekFront();
      if (firstTask.type === 'read') {
        runReadOperation(firstTask);
      } else {
        runWriteOperation(firstTask);
      }
    }
    function runReadOperation(firstTask) {
      var readTasks = [firstTask];
      var i = 1;
      var nextTask = db._queue.get(i);
      while (typeof nextTask !== 'undefined' && nextTask.type === 'read') {
        readTasks.push(nextTask);
        i++;
        nextTask = db._queue.get(i);
      }
      var numDone = 0;
      readTasks.forEach(function(readTask) {
        var args = readTask.args;
        var callback = args[args.length - 1];
        args[args.length - 1] = getArguments(function(cbArgs) {
          callback.apply(null, cbArgs);
          if (++numDone === readTasks.length) {
            process.nextTick(function() {
              readTasks.forEach(function() {
                db._queue.shift();
              });
              if (db._queue.length) {
                executeNext();
              }
            });
          }
        });
        tryCode(readTask.fun, args);
      });
    }
    function runWriteOperation(firstTask) {
      var args = firstTask.args;
      var callback = args[args.length - 1];
      args[args.length - 1] = getArguments(function(cbArgs) {
        callback.apply(null, cbArgs);
        process.nextTick(function() {
          db._queue.shift();
          if (db._queue.length) {
            executeNext();
          }
        });
      });
      tryCode(firstTask.fun, args);
    }
    function writeLock(fun) {
      return getArguments(function(args) {
        db._queue.push({
          fun: fun,
          args: args,
          type: 'write'
        });
        if (db._queue.length === 1) {
          process.nextTick(executeNext);
        }
      });
    }
    function readLock(fun) {
      return getArguments(function(args) {
        db._queue.push({
          fun: fun,
          args: args,
          type: 'read'
        });
        if (db._queue.length === 1) {
          process.nextTick(executeNext);
        }
      });
    }
    function formatSeq(n) {
      return ('0000000000000000' + n).slice(-16);
    }
    function parseSeq(s) {
      return parseInt(s, 10);
    }
    api._get = readLock(function(id, opts, callback) {
      opts = clone(opts);
      stores.docStore.get(id, function(err, metadata) {
        if (err || !metadata) {
          return callback(createError(MISSING_DOC, 'missing'));
        }
        var rev = getWinningRev(metadata);
        var deleted = getIsDeleted(metadata, rev);
        if (deleted && !opts.rev) {
          return callback(createError(MISSING_DOC, "deleted"));
        }
        rev = opts.rev ? opts.rev : rev;
        var seq = metadata.rev_map[rev];
        stores.bySeqStore.get(formatSeq(seq), function(err, doc) {
          if (!doc) {
            return callback(createError(MISSING_DOC));
          }
          if ('_id' in doc && doc._id !== metadata.id) {
            return callback(new Error('wrong doc returned'));
          }
          doc._id = metadata.id;
          if ('_rev' in doc) {
            if (doc._rev !== rev) {
              return callback(new Error('wrong doc returned'));
            }
          } else {
            doc._rev = rev;
          }
          return callback(null, {
            doc: doc,
            metadata: metadata
          });
        });
      });
    });
    api._getAttachment = function(attachment, opts, callback) {
      var digest = attachment.digest;
      var type = attachment.content_type;
      stores.binaryStore.get(digest, function(err, attach) {
        if (err) {
          if (err.name !== 'NotFoundError') {
            return callback(err);
          }
          return callback(null, opts.binary ? createEmptyBlobOrBuffer(type) : '');
        }
        if (opts.binary) {
          callback(null, readAsBlobOrBuffer(attach, type));
        } else {
          callback(null, attach.toString('base64'));
        }
      });
    };
    api._bulkDocs = writeLock(function(req, opts, callback) {
      var newEdits = opts.new_edits;
      var results = new Array(req.docs.length);
      var fetchedDocs = new collections.Map();
      var txn = new LevelTransaction();
      var docCountDelta = 0;
      var newUpdateSeq = db._updateSeq;
      var userDocs = req.docs;
      var docInfos = userDocs.map(function(doc, i) {
        if (doc._id && isLocalId(doc._id)) {
          return doc;
        }
        var newDoc = parseDoc(doc, newEdits);
        if (newDoc.metadata && !newDoc.metadata.rev_map) {
          newDoc.metadata.rev_map = {};
        }
        return newDoc;
      });
      var infoErrors = docInfos.filter(function(doc) {
        return doc.error;
      });
      if (infoErrors.length) {
        return callback(infoErrors[0]);
      }
      function verifyAttachment(digest, callback) {
        txn.get(stores.attachmentStore, digest, function(levelErr) {
          if (levelErr) {
            var err = createError(MISSING_STUB, 'unknown stub attachment with digest ' + digest);
            callback(err);
          } else {
            callback();
          }
        });
      }
      function verifyAttachments(finish) {
        var digests = [];
        userDocs.forEach(function(doc) {
          if (doc && doc._attachments) {
            Object.keys(doc._attachments).forEach(function(filename) {
              var att = doc._attachments[filename];
              if (att.stub) {
                digests.push(att.digest);
              }
            });
          }
        });
        if (!digests.length) {
          return finish();
        }
        var numDone = 0;
        var err;
        digests.forEach(function(digest) {
          verifyAttachment(digest, function(attErr) {
            if (attErr && !err) {
              err = attErr;
            }
            if (++numDone === digests.length) {
              finish(err);
            }
          });
        });
      }
      function fetchExistingDocs(finish) {
        var numDone = 0;
        var overallErr;
        function checkDone() {
          if (++numDone === userDocs.length) {
            return finish(overallErr);
          }
        }
        userDocs.forEach(function(doc) {
          if (doc._id && isLocalId(doc._id)) {
            return checkDone();
          }
          txn.get(stores.docStore, doc._id, function(err, info) {
            if (err) {
              if (err.name !== 'NotFoundError') {
                overallErr = err;
              }
            } else {
              fetchedDocs.set(doc._id, info);
            }
            checkDone();
          });
        });
      }
      function autoCompact(callback) {
        var promise = PouchPromise.resolve();
        fetchedDocs.forEach(function(metadata, docId) {
          promise = promise.then(function() {
            return new PouchPromise(function(resolve, reject) {
              var revs = compactTree(metadata);
              api._doCompactionNoLock(docId, revs, {ctx: txn}, function(err) {
                if (err) {
                  return reject(err);
                }
                resolve();
              });
            });
          });
        });
        promise.then(function() {
          callback();
        }, callback);
      }
      function finish() {
        if (api.auto_compaction) {
          return autoCompact(complete);
        }
        return complete();
      }
      function writeDoc(docInfo, winningRev, winningRevIsDeleted, newRevIsDeleted, isUpdate, delta, resultsIdx, callback2) {
        docCountDelta += delta;
        var err = null;
        var recv = 0;
        docInfo.metadata.winningRev = winningRev;
        docInfo.metadata.deleted = winningRevIsDeleted;
        docInfo.data._id = docInfo.metadata.id;
        docInfo.data._rev = docInfo.metadata.rev;
        if (newRevIsDeleted) {
          docInfo.data._deleted = true;
        }
        var attachments = docInfo.data._attachments ? Object.keys(docInfo.data._attachments) : [];
        function attachmentSaved(attachmentErr) {
          recv++;
          if (!err) {
            if (attachmentErr) {
              err = attachmentErr;
              callback2(err);
            } else if (recv === attachments.length) {
              finish();
            }
          }
        }
        function onMD5Load(doc, key, data, attachmentSaved) {
          return function(result) {
            saveAttachment(doc, MD5_PREFIX + result, key, data, attachmentSaved);
          };
        }
        function doMD5(doc, key, attachmentSaved) {
          return function(data) {
            res$1(data).then(onMD5Load(doc, key, data, attachmentSaved));
          };
        }
        for (var i = 0; i < attachments.length; i++) {
          var key = attachments[i];
          var att = docInfo.data._attachments[key];
          if (att.stub) {
            var id = docInfo.data._id;
            var rev = docInfo.data._rev;
            saveAttachmentRefs(id, rev, att.digest, attachmentSaved);
            continue;
          }
          var data;
          if (typeof att.data === 'string') {
            try {
              data = atob(att.data);
            } catch (e) {
              callback(createError(BAD_ARG, 'Attachment is not a valid base64 string'));
              return;
            }
            doMD5(docInfo, key, attachmentSaved)(data);
          } else {
            prepareAttachmentForStorage(att.data, doMD5(docInfo, key, attachmentSaved));
          }
        }
        function finish() {
          var seq = docInfo.metadata.rev_map[docInfo.metadata.rev];
          if (seq) {
            return callback2();
          }
          seq = ++newUpdateSeq;
          docInfo.metadata.rev_map[docInfo.metadata.rev] = docInfo.metadata.seq = seq;
          var seqKey = formatSeq(seq);
          var batch = [{
            key: seqKey,
            value: docInfo.data,
            prefix: stores.bySeqStore,
            type: 'put'
          }, {
            key: docInfo.metadata.id,
            value: docInfo.metadata,
            prefix: stores.docStore,
            type: 'put'
          }];
          txn.batch(batch);
          results[resultsIdx] = {
            ok: true,
            id: docInfo.metadata.id,
            rev: winningRev
          };
          fetchedDocs.set(docInfo.metadata.id, docInfo.metadata);
          callback2();
        }
        if (!attachments.length) {
          finish();
        }
      }
      var attachmentQueues = {};
      function saveAttachmentRefs(id, rev, digest, callback) {
        function fetchAtt() {
          return new PouchPromise(function(resolve, reject) {
            txn.get(stores.attachmentStore, digest, function(err, oldAtt) {
              if (err && err.name !== 'NotFoundError') {
                return reject(err);
              }
              resolve(oldAtt);
            });
          });
        }
        function saveAtt(oldAtt) {
          var ref = [id, rev].join('@');
          var newAtt = {};
          if (oldAtt) {
            if (oldAtt.refs) {
              newAtt.refs = oldAtt.refs;
              newAtt.refs[ref] = true;
            }
          } else {
            newAtt.refs = {};
            newAtt.refs[ref] = true;
          }
          return new PouchPromise(function(resolve, reject) {
            txn.batch([{
              type: 'put',
              prefix: stores.attachmentStore,
              key: digest,
              value: newAtt
            }]);
            resolve(!oldAtt);
          });
        }
        var queue = attachmentQueues[digest] || PouchPromise.resolve();
        attachmentQueues[digest] = queue.then(function() {
          return fetchAtt().then(saveAtt).then(function(isNewAttachment) {
            callback(null, isNewAttachment);
          }, callback);
        });
      }
      function saveAttachment(docInfo, digest, key, data, callback) {
        var att = docInfo.data._attachments[key];
        delete att.data;
        att.digest = digest;
        att.length = data.length;
        var id = docInfo.metadata.id;
        var rev = docInfo.metadata.rev;
        saveAttachmentRefs(id, rev, digest, function(err, isNewAttachment) {
          if (err) {
            return callback(err);
          }
          if (data.length === 0) {
            return callback(err);
          }
          if (!isNewAttachment) {
            return callback(err);
          }
          txn.batch([{
            type: 'put',
            prefix: stores.binaryStore,
            key: digest,
            value: new Buffer(data, 'binary')
          }]);
          callback();
        });
      }
      function complete(err) {
        if (err) {
          return process.nextTick(function() {
            callback(err);
          });
        }
        txn.batch([{
          prefix: stores.metaStore,
          type: 'put',
          key: UPDATE_SEQ_KEY,
          value: newUpdateSeq
        }, {
          prefix: stores.metaStore,
          type: 'put',
          key: DOC_COUNT_KEY,
          value: db._docCount + docCountDelta
        }]);
        txn.execute(db, function(err) {
          if (err) {
            return callback(err);
          }
          db._docCount += docCountDelta;
          db._updateSeq = newUpdateSeq;
          LevelPouch.Changes.notify(name);
          process.nextTick(function() {
            callback(null, results);
          });
        });
      }
      if (!docInfos.length) {
        return callback(null, []);
      }
      verifyAttachments(function(err) {
        if (err) {
          return callback(err);
        }
        fetchExistingDocs(function(err) {
          if (err) {
            return callback(err);
          }
          processDocs(revLimit, docInfos, api, fetchedDocs, txn, results, writeDoc, opts, finish);
        });
      });
    });
    api._allDocs = readLock(function(opts, callback) {
      opts = clone(opts);
      countDocs(function(err, docCount) {
        if (err) {
          return callback(err);
        }
        var readstreamOpts = {};
        var skip = opts.skip || 0;
        if (opts.startkey) {
          readstreamOpts.gte = opts.startkey;
        }
        if (opts.endkey) {
          readstreamOpts.lte = opts.endkey;
        }
        if (opts.key) {
          readstreamOpts.gte = readstreamOpts.lte = opts.key;
        }
        if (opts.descending) {
          readstreamOpts.reverse = true;
          var tmp = readstreamOpts.lte;
          readstreamOpts.lte = readstreamOpts.gte;
          readstreamOpts.gte = tmp;
        }
        var limit;
        if (typeof opts.limit === 'number') {
          limit = opts.limit;
        }
        if (limit === 0 || ('start' in readstreamOpts && 'end' in readstreamOpts && readstreamOpts.start > readstreamOpts.end)) {
          return callback(null, {
            total_rows: docCount,
            offset: opts.skip,
            rows: []
          });
        }
        var results = [];
        var docstream = stores.docStore.readStream(readstreamOpts);
        var throughStream = through2.obj(function(entry, _, next) {
          var metadata = entry.value;
          var winningRev = getWinningRev(metadata);
          var deleted = getIsDeleted(metadata, winningRev);
          if (!deleted) {
            if (skip-- > 0) {
              next();
              return;
            } else if (typeof limit === 'number' && limit-- <= 0) {
              docstream.unpipe();
              docstream.destroy();
              next();
              return;
            }
          } else if (opts.deleted !== 'ok') {
            next();
            return;
          }
          function allDocsInner(data) {
            var doc = {
              id: metadata.id,
              key: metadata.id,
              value: {rev: winningRev}
            };
            if (opts.include_docs) {
              doc.doc = data;
              doc.doc._rev = doc.value.rev;
              if (opts.conflicts) {
                doc.doc._conflicts = collectConflicts(metadata);
              }
              for (var att in doc.doc._attachments) {
                if (doc.doc._attachments.hasOwnProperty(att)) {
                  doc.doc._attachments[att].stub = true;
                }
              }
            }
            if (opts.inclusive_end === false && metadata.id === opts.endkey) {
              return next();
            } else if (deleted) {
              if (opts.deleted === 'ok') {
                doc.value.deleted = true;
                doc.doc = null;
              } else {
                return next();
              }
            }
            results.push(doc);
            next();
          }
          if (opts.include_docs) {
            var seq = metadata.rev_map[winningRev];
            stores.bySeqStore.get(formatSeq(seq), function(err, data) {
              allDocsInner(data);
            });
          } else {
            allDocsInner();
          }
        }, function(next) {
          PouchPromise.resolve().then(function() {
            if (opts.include_docs && opts.attachments) {
              return fetchAttachments(results, stores, opts);
            }
          }).then(function() {
            callback(null, {
              total_rows: docCount,
              offset: opts.skip,
              rows: results
            });
          }, callback);
          next();
        }).on('unpipe', function() {
          throughStream.end();
        });
        docstream.on('error', callback);
        docstream.pipe(throughStream);
      });
    });
    api._changes = function(opts) {
      opts = clone(opts);
      if (opts.continuous) {
        var id = name + ':' + uuid();
        LevelPouch.Changes.addListener(name, id, api, opts);
        LevelPouch.Changes.notify(name);
        return {cancel: function() {
            LevelPouch.Changes.removeListener(name, id);
          }};
      }
      var descending = opts.descending;
      var results = [];
      var lastSeq = opts.since || 0;
      var called = 0;
      var streamOpts = {reverse: descending};
      var limit;
      if ('limit' in opts && opts.limit > 0) {
        limit = opts.limit;
      }
      if (!streamOpts.reverse) {
        streamOpts.start = formatSeq(opts.since || 0);
      }
      var docIds = opts.doc_ids && new collections.Set(opts.doc_ids);
      var filter = filterChange(opts);
      var docIdsToMetadata = new collections.Map();
      var returnDocs;
      if ('return_docs' in opts) {
        returnDocs = opts.return_docs;
      } else if ('returnDocs' in opts) {
        returnDocs = opts.returnDocs;
      } else {
        returnDocs = true;
      }
      function complete() {
        opts.done = true;
        if (returnDocs && opts.limit) {
          if (opts.limit < results.length) {
            results.length = opts.limit;
          }
        }
        changeStream.unpipe(throughStream);
        changeStream.destroy();
        if (!opts.continuous && !opts.cancelled) {
          if (opts.include_docs && opts.attachments) {
            fetchAttachments(results, stores, opts).then(function() {
              opts.complete(null, {
                results: results,
                last_seq: lastSeq
              });
            });
          } else {
            opts.complete(null, {
              results: results,
              last_seq: lastSeq
            });
          }
        }
      }
      var changeStream = stores.bySeqStore.readStream(streamOpts);
      var throughStream = through2.obj(function(data, _, next) {
        if (limit && called >= limit) {
          complete();
          return next();
        }
        if (opts.cancelled || opts.done) {
          return next();
        }
        var seq = parseSeq(data.key);
        var doc = data.value;
        if (seq === opts.since && !descending) {
          return next();
        }
        if (docIds && !docIds.has(doc._id)) {
          return next();
        }
        var metadata;
        function onGetMetadata(metadata) {
          var winningRev = getWinningRev(metadata);
          function onGetWinningDoc(winningDoc) {
            var change = opts.processChange(winningDoc, metadata, opts);
            change.seq = metadata.seq;
            var filtered = filter(change);
            if (typeof filtered === 'object') {
              return opts.complete(filtered);
            }
            if (filtered) {
              called++;
              if (opts.attachments && opts.include_docs) {
                fetchAttachments([change], stores, opts).then(function() {
                  opts.onChange(change);
                });
              } else {
                opts.onChange(change);
              }
              if (returnDocs) {
                results.push(change);
              }
            }
            next();
          }
          if (metadata.seq !== seq) {
            return next();
          }
          lastSeq = seq;
          if (winningRev === doc._rev) {
            return onGetWinningDoc(doc);
          }
          var winningSeq = metadata.rev_map[winningRev];
          stores.bySeqStore.get(formatSeq(winningSeq), function(err, doc) {
            onGetWinningDoc(doc);
          });
        }
        metadata = docIdsToMetadata.get(doc._id);
        if (metadata) {
          return onGetMetadata(metadata);
        }
        stores.docStore.get(doc._id, function(err, metadata) {
          if (opts.cancelled || opts.done || db.isClosed() || isLocalId(metadata.id)) {
            return next();
          }
          docIdsToMetadata.set(doc._id, metadata);
          onGetMetadata(metadata);
        });
      }, function(next) {
        if (opts.cancelled) {
          return next();
        }
        if (returnDocs && opts.limit) {
          if (opts.limit < results.length) {
            results.length = opts.limit;
          }
        }
        next();
      }).on('unpipe', function() {
        throughStream.end();
        complete();
      });
      changeStream.pipe(throughStream);
      return {cancel: function() {
          opts.cancelled = true;
          complete();
        }};
    };
    api._close = function(callback) {
      if (db.isClosed()) {
        return callback(createError(NOT_OPEN));
      }
      db.close(function(err) {
        if (err) {
          callback(err);
        } else {
          dbStore.delete(name);
          callback();
        }
      });
    };
    api._getRevisionTree = function(docId, callback) {
      stores.docStore.get(docId, function(err, metadata) {
        if (err) {
          callback(createError(MISSING_DOC));
        } else {
          callback(null, metadata.rev_tree);
        }
      });
    };
    api._doCompaction = writeLock(function(docId, revs, opts, callback) {
      api._doCompactionNoLock(docId, revs, opts, callback);
    });
    api._doCompactionNoLock = function(docId, revs, opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      if (!revs.length) {
        return callback();
      }
      var txn = opts.ctx || new LevelTransaction();
      txn.get(stores.docStore, docId, function(err, metadata) {
        if (err) {
          return callback(err);
        }
        var seqs = metadata.rev_map;
        traverseRevTree(metadata.rev_tree, function(isLeaf, pos, revHash, ctx, opts) {
          var rev = pos + '-' + revHash;
          if (revs.indexOf(rev) !== -1) {
            opts.status = 'missing';
          }
        });
        var batch = [];
        batch.push({
          key: metadata.id,
          value: metadata,
          type: 'put',
          prefix: stores.docStore
        });
        var digestMap = {};
        var numDone = 0;
        var overallErr;
        function checkDone(err) {
          if (err) {
            overallErr = err;
          }
          if (++numDone === revs.length) {
            if (overallErr) {
              return callback(overallErr);
            }
            deleteOrphanedAttachments();
          }
        }
        function finish(err) {
          if (err) {
            return callback(err);
          }
          txn.batch(batch);
          if (opts.ctx) {
            return callback();
          }
          txn.execute(db, callback);
        }
        function deleteOrphanedAttachments() {
          var possiblyOrphanedAttachments = Object.keys(digestMap);
          if (!possiblyOrphanedAttachments.length) {
            return finish();
          }
          var numDone = 0;
          var overallErr;
          function checkDone(err) {
            if (err) {
              overallErr = err;
            }
            if (++numDone === possiblyOrphanedAttachments.length) {
              finish(overallErr);
            }
          }
          var refsToDelete = new collections.Map();
          revs.forEach(function(rev) {
            refsToDelete.set(docId + '@' + rev, true);
          });
          possiblyOrphanedAttachments.forEach(function(digest) {
            txn.get(stores.attachmentStore, digest, function(err, attData) {
              if (err) {
                if (err.name === 'NotFoundError') {
                  return checkDone();
                } else {
                  return checkDone(err);
                }
              }
              var refs = Object.keys(attData.refs || {}).filter(function(ref) {
                return !refsToDelete.has(ref);
              });
              var newRefs = {};
              refs.forEach(function(ref) {
                newRefs[ref] = true;
              });
              if (refs.length) {
                batch.push({
                  key: digest,
                  type: 'put',
                  value: {refs: newRefs},
                  prefix: stores.attachmentStore
                });
              } else {
                batch = batch.concat([{
                  key: digest,
                  type: 'del',
                  prefix: stores.attachmentStore
                }, {
                  key: digest,
                  type: 'del',
                  prefix: stores.binaryStore
                }]);
              }
              checkDone();
            });
          });
        }
        revs.forEach(function(rev) {
          var seq = seqs[rev];
          batch.push({
            key: formatSeq(seq),
            type: 'del',
            prefix: stores.bySeqStore
          });
          txn.get(stores.bySeqStore, formatSeq(seq), function(err, doc) {
            if (err) {
              if (err.name === 'NotFoundError') {
                return checkDone();
              } else {
                return checkDone(err);
              }
            }
            var atts = Object.keys(doc._attachments || {});
            atts.forEach(function(attName) {
              var digest = doc._attachments[attName].digest;
              digestMap[digest] = true;
            });
            checkDone();
          });
        });
      });
    };
    api._getLocal = function(id, callback) {
      stores.localStore.get(id, function(err, doc) {
        if (err) {
          callback(createError(MISSING_DOC));
        } else {
          callback(null, doc);
        }
      });
    };
    api._putLocal = function(doc, opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      if (opts.ctx) {
        api._putLocalNoLock(doc, opts, callback);
      } else {
        api._putLocalWithLock(doc, opts, callback);
      }
    };
    api._putLocalWithLock = writeLock(function(doc, opts, callback) {
      api._putLocalNoLock(doc, opts, callback);
    });
    api._putLocalNoLock = function(doc, opts, callback) {
      delete doc._revisions;
      var oldRev = doc._rev;
      var id = doc._id;
      var txn = opts.ctx || new LevelTransaction();
      txn.get(stores.localStore, id, function(err, resp) {
        if (err && oldRev) {
          return callback(createError(REV_CONFLICT));
        }
        if (resp && resp._rev !== oldRev) {
          return callback(createError(REV_CONFLICT));
        }
        doc._rev = oldRev ? '0-' + (parseInt(oldRev.split('-')[1], 10) + 1) : '0-1';
        var batch = [{
          type: 'put',
          prefix: stores.localStore,
          key: id,
          value: doc
        }];
        txn.batch(batch);
        var ret = {
          ok: true,
          id: doc._id,
          rev: doc._rev
        };
        if (opts.ctx) {
          return callback(null, ret);
        }
        txn.execute(db, function(err) {
          if (err) {
            return callback(err);
          }
          callback(null, ret);
        });
      });
    };
    api._removeLocal = function(doc, opts, callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      if (opts.ctx) {
        api._removeLocalNoLock(doc, opts, callback);
      } else {
        api._removeLocalWithLock(doc, opts, callback);
      }
    };
    api._removeLocalWithLock = writeLock(function(doc, opts, callback) {
      api._removeLocalNoLock(doc, opts, callback);
    });
    api._removeLocalNoLock = function(doc, opts, callback) {
      var txn = opts.ctx || new LevelTransaction();
      txn.get(stores.localStore, doc._id, function(err, resp) {
        if (err) {
          if (err.name !== 'NotFoundError') {
            return callback(err);
          } else {
            return callback(createError(MISSING_DOC));
          }
        }
        if (resp._rev !== doc._rev) {
          return callback(createError(REV_CONFLICT));
        }
        txn.batch([{
          prefix: stores.localStore,
          type: 'del',
          key: doc._id
        }]);
        var ret = {
          ok: true,
          id: doc._id,
          rev: '0-0'
        };
        if (opts.ctx) {
          return callback(null, ret);
        }
        txn.execute(db, function(err) {
          if (err) {
            return callback(err);
          }
          callback(null, ret);
        });
      });
    };
    api._destroy = function(opts, callback) {
      var dbStore;
      var leveldownName = functionName(leveldown);
      if (dbStores.has(leveldownName)) {
        dbStore = dbStores.get(leveldownName);
      } else {
        return callDestroy(name, callback);
      }
      if (dbStore.has(name)) {
        LevelPouch.Changes.removeAllListeners(name);
        dbStore.get(name).close(function() {
          dbStore.delete(name);
          callDestroy(name, callback);
        });
      } else {
        callDestroy(name, callback);
      }
    };
    function callDestroy(name, cb) {
      if (typeof leveldown.destroy === 'function') {
        leveldown.destroy(name, cb);
      } else {
        process.nextTick(cb);
      }
    }
  }
  LevelPouch.valid = function() {
    return true;
  };
  LevelPouch.use_prefix = false;
  LevelPouch.Changes = new Changes();
  var adapters = {leveldb: LevelPouch};
  PouchDB.ajax = ajax;
  PouchDB.utils = utils;
  PouchDB.Errors = allErrors;
  PouchDB.replicate = replication.replicate;
  PouchDB.sync = sync;
  PouchDB.version = '5.2.1';
  PouchDB.adapter('http', HttpPouch);
  PouchDB.adapter('https', HttpPouch);
  PouchDB.plugin(mapreduce);
  Object.keys(adapters).forEach(function(adapterName) {
    PouchDB.adapter(adapterName, adapters[adapterName], true);
  });
  module.exports = PouchDB;
})(require('buffer').Buffer, require('process'));