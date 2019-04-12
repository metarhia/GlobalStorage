'use strict';

const fs = require('fs');
const common = require('@metarhia/common');
const { FileStorage } = require('@metarhia/filestorage');
const metasync = require('metasync');
const mdsf = require('mdsf');

const { StorageProvider } = require('./provider');
const { FsCursor } = require('./fs.cursor');

const readStat = Symbol('readStat');
const writeStat = Symbol('writeStat');

const THROTTLE_TIMEOUT = 5000;

class FsProvider extends StorageProvider {
  // Create FsProvider
  //   options <Object>
  constructor(options) {
    super(options);
    this.stat = null;
    this.storage = null;
    this.dbOptions = {};
  }

  // Read storage stats
  //   callback - <Function>
  //     err - <Error>
  //     data - <Object>, database stats
  [readStat](callback) {
    fs.readFile(this.path + '/.gs', 'utf8', (err, stat) => {
      if (err) {
        callback(err, this);
        return;
      }
      const data = mdsf.parse(stat);
      data.count = data.count || 0;
      data.size = data.size || 0;
      data.next = data.next || 1;
      callback(null, data);
    });
  }

  // Write storage stats
  //   callback - <Function>
  //     err - <Error>
  [writeStat](callback) {
    callback = common.once(callback);
    const save = () => {
      const data = mdsf.stringify(this.stat);
      fs.writeFile(this.path + '/.gs', data, callback);
    };
    this.save = this.save || metasync.throttle(THROTTLE_TIMEOUT, save);
    this.save();
  }

  // Open FsProvider
  //   options - <Object>
  //     path - <string>
  //     minCompressSize - <number>
  //     checksum - <string>, checksum type
  //     dedupHash - <string>, second checksum type
  //   callback - <Function>
  //     err - <Error>
  open(options, callback) {
    this.path = options.path;
    this.dbOptions.checksum = options.checksum;
    this.dbOptions.dedupHash = options.dedupHash;
    super.open(options, () => {
      this[readStat]((err, stat) => {
        if (err) {
          callback(new Error('Can not open database: ' + this.path));
          return;
        }
        this.stat = stat;
        this.active = true;
        this.storage = new FileStorage(
          Object.assign({ dir: options.path }, options)
        );
        callback(null, this);
      });
    });
  }

  // Close FsProvider
  //   callback - <Function>
  close(callback) {
    this[writeStat]();
    this.active = false;
    callback();
  }

  // Generate unique id
  //   callback - <Function>
  //     err - <Error>
  //     id - <number>
  takeId(callback) {
    callback(null, this.stat.next++);
    this.stat.count++;
    this[writeStat]();
  }

  // Get record from GlobalStorage
  //   id - <number>
  //   callback - <Function>
  //     err - <Error>
  //     data - <Object>
  get(id, callback) {
    this.storage.read(id, this.dbOptions, (err, data) => {
      if (err) callback(err);
      else callback(null, mdsf.parse(data.toString()));
    });
  }

  // Create record in GlobalStorage
  //   obj - <Object>
  //   callback - <Function>
  //     err - <Error>
  //     id - <number>
  create(obj, callback) {
    this.takeId((err, id) => {
      if (err) {
        callback(err);
        return;
      }
      obj.Id = id;
      const data = mdsf.stringify(obj);
      this.storage.write(id, data, this.dbOptions, (err, stats) => {
        if (err) {
          callback(err);
          return;
        }
        this.stat.size += stats.size;
        this[writeStat]();
        callback(null, id);
      });
    });
  }

  // Update record in GlobalStorage
  //   obj - <Object>
  //     Id - <number>
  //   callback - <Function>
  //     err - <Error>
  update(obj, callback) {
    const data = mdsf.stringify(obj);
    this.storage.update(obj.Id, data, this.dbOptions, (err, stats) => {
      if (err) {
        callback(err);
        return;
      }
      this.stat.size += stats.size - stats.originalSize;
      this[writeStat]();
      callback();
    });
  }

  // Delete record from GlobalStorage
  //   id - <number>
  //   callback - <Function>
  //     err - <Error>
  delete(id, callback) {
    this.storage.stat(id, (err, stats) => {
      if (err) {
        callback(err);
        return;
      }
      this.storage.rm(id, err => {
        if (err) {
          callback(err);
          return;
        }
        this.stat.count--;
        this.stat.size -= stats.size;
        this[writeStat]();
        callback();
      });
    });
  }

  select(query, options, callback) {
    if (callback) callback();
    return new FsCursor({
      provider: this,
      jsql: [{ op: 'select', query, options }],
    });
  }
}

module.exports = { FsProvider };
