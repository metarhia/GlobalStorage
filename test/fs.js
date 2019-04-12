'use strict';

const gs = require('..');

const fs = require('fs');

const metasync = require('metasync');
const metatests = require('metatests');
const { Uint64 } = require('@metarhia/common');

const provider = gs('fs', {
  serverSuffix: new Uint64(0x4000000),
  serverBitmask: new Uint64(0x7ffffff),
});

const fsTest = metatests.test('FsProvider');

fsTest.beforeEach((test, cb) => {
  provider.open({ path: './data' }, err => {
    if (err) {
      test.error(err, 'Cannot open database');
      test.end();
      return;
    }
    cb();
  });
});

fsTest.afterEach((test, cb) =>
  provider.close(() =>
    setTimeout(
      () =>
        fs.writeFile(
          './data/.gs',
          `{server:'0',count:0,size:0,next:0}`,
          err => {
            test.error(err);
            cb();
          }
        ),
      6000
    )
  )
);

fsTest.test('fs test', test => {
  const item = { Num: 123 };
  const nextId = provider.stat.next;
  provider.create(item, (err, id) => {
    if (err) {
      test.error(err);
      test.end();
      return;
    }
    test.strictSame(id, nextId);
    test.strictSame(item.Id, nextId);
    test.end();
  });
});

fsTest.test('fs test', test => {
  const processItem = (item, callback) => {
    provider.create(item, (err, id) => {
      if (err) {
        callback(err);
        return;
      }
      item.Name = id % 2 ? 'Marcus' : 'Aurelius';
      provider.update(item, err => {
        if (err) {
          callback(err);
          return;
        }
        if (id % 3) {
          provider.delete(id, callback);
        } else {
          callback(null);
        }
      });
    });
  };

  const queue = metasync
    .queue(100, 100)
    .process(processItem)
    .timeout(1000, () => {
      test.notOk('Insert test error, file writing timeout');
      test.end();
    })
    .failure(err => {
      test.error(err, 'insert test failed');
      test.end();
    })
    .drain(() => {
      test.end();
    });

  for (let i = 0; i < 10; i++) {
    queue.add({ Num: i });
  }
});
