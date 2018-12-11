'use strict';

const submodules = [
  'memory.provider',
  'remote.provider',
  'fs.provider',
  'pg.provider',
];

const api = {};
submodules.forEach(name => Object.assign(api, require('./lib/' + name)));

const providers = {
  fs: api.FsProvider,
  memory: api.MemoryProvider,
  pg: api.PostgresProvider,
  remote: api.RemoteProvider,
};

module.exports = (provider, options) => new providers[provider](options);
