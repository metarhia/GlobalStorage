'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const metaschema = require('metaschema');
const metatests = require('metatests');
const { Pool } = require('pg');
const { Uint64 } = require('@metarhia/common');
const { options, config } = require('../lib/metaschema-config/config');

const getPathFromCurrentDir = path.join.bind(path, __dirname);

const gs = require('..');
const { codes: errorCodes, GSError } = require('../lib/errors');
const { generateDDL } = require('../lib/pg.ddl');
const { pgOptions } = require('./utils');
const {
  symbols: { recreateIdTrigger, uploadMetadata },
} = require('../lib/pg.utils');

const pool = new Pool(pgOptions);
const provider = gs('pg', {
  serverSuffix: new Uint64(0x4000000),
  serverBitmask: new Uint64(0x7ffffff),
});

metatests.test(
  'PostgresProvider',
  async test => {
    try {
      const initSql = await util.promisify(fs.readFile)(
        getPathFromCurrentDir('..', 'sql', 'id.sql'),
        'utf8'
      );
      await pool.query(initSql);

      const schema = await metaschema.fs.load(
        [
          getPathFromCurrentDir('..', 'schemas', 'system'),
          getPathFromCurrentDir('fixtures', 'pg-test-schemas'),
        ],
        options,
        config
      );
      await provider.open({ schema, ...pgOptions });

      await pool.query(generateDDL(provider.schema));
      await provider[recreateIdTrigger](1000, 30);
      await provider[uploadMetadata]();
    } catch (err) {
      if (process.env.CI) {
        test.fail('PostgreSQL setup failed');
      } else {
        console.error(
          'Cannot setup PostgreSQL, skipping PostgresProvider tests'
        );
      }
      console.error(err);
      test.end();
      return;
    }

    test.endAfterSubtests();

    test.test(
      'PostgresProvider test',
      test => {
        test.endAfterSubtests();

        const record = {
          category: 'Person',
          value: {
            DOB: new Date('2000-01-01'),
            Name: 'Jason',
          },
        };

        test.test('create on local category', async test => {
          const id = await provider.create('LocalCategory', {
            SomeData: 'test data',
            RequiredData: 'required test data',
          });
          test.assert(id);
          test.end();
        });

        test.test('invalid create on local category', async test => {
          try {
            await provider.create('LocalCategory', {
              SomeData: 'test data',
            });
            test.fail('must have thrown an error');
          } catch (err) {
            test.isError(err, new GSError());
            test.strictSame(err.code, errorCodes.INVALID_SCHEMA);
          } finally {
            test.end();
          }
        });

        test.test('empty create on local category', async test => {
          const id = await provider.create('Local', {});
          test.assert(id);
          test.end();
        });

        test.test('create on global category', async test => {
          const { category, value } = record;
          const id = await provider.create(category, value);
          test.assert(id);
          record.value.Id = id;
          test.end();
        });

        test.test('invalid create on global category', async test => {
          try {
            await provider.create('Person', {
              DOB: new Date('1999-01-01'),
            });
            test.fail('must have thrown an error');
          } catch (err) {
            test.isError(err, new GSError());
            test.strictSame(err.code, errorCodes.INVALID_SCHEMA);
          } finally {
            test.end();
          }
        });

        test.test('empty create on global category', async test => {
          const id = await provider.create('OptionalRegistry', {});
          test.assert(id);
          test.end();
        });

        test.test('create on ignored category', async test => {
          try {
            await provider.create('TestMemory', {
              Service: 'gs',
            });
            test.fail('must have thrown an error');
          } catch (err) {
            test.isError(err, new GSError());
            test.strictSame(err.code, errorCodes.INVALID_CATEGORY_TYPE);
          } finally {
            test.end();
          }
        });

        test.test('gs.set', async test => {
          record.value.Name = 'John';
          await provider.set(record.value);
          test.end();
        });

        test.test('gs.get', async test => {
          const res = await provider.get(record.value.Id);
          test.strictSame(res, record.value);
          test.end();
        });

        test.test('gs.update', async test => {
          const newName = 'Peter';
          const count = await provider.update(
            record.category,
            {
              Name: record.value.Name,
            },
            {
              Name: newName,
            }
          );
          test.strictSame(count, 1);
          record.value.Name = newName;
          test.end();
        });

        test.test('gs.delete', async test => {
          const count = await provider.delete(record.category, {
            Name: record.value.Name,
          });
          test.strictSame(count, 1);
          test.end();
        });

        const includeObj = {
          Name: 'Metarhia',
          Address: {
            Country: 'Ukraine',
            City: 'Kiev',
          },
        };

        test.test('gs.create with Include categories', async test => {
          const id = await provider.create('Company', includeObj);
          test.assert(id);
          includeObj.Id = id;
          test.end();
        });

        test.test('gs.set with Include categories', async test => {
          includeObj.Name = 'iBusiness';
          includeObj.Address = {
            Id: includeObj.Id,
            Country: 'USA',
            City: 'San Francisco',
          };
          await provider.set(includeObj);
          test.end();
        });

        test.test('gs.get with Include categories', async test => {
          const obj = await provider.get(includeObj.Id);
          test.strictSame(obj, includeObj);
          test.end();
        });

        test.test('gs.delete with Include categories', async test => {
          const count = await provider.delete('Company', {
            'Address.Country': includeObj.Address.Country,
          });
          test.strictSame(count, 1);
          try {
            await provider.get(includeObj.Id);
            test.fail('must have thrown an error');
          } catch (err) {
            test.isError(err, new GSError());
            test.strictSame(err.code, errorCodes.NOT_FOUND);
          } finally {
            test.end();
          }
        });

        test.test('invalid gs.delete with Include categories', async test => {
          try {
            await provider.delete('Address', {
              Country: includeObj.Address.Country,
            });
            test.fail('must have thrown an error');
          } catch (err) {
            test.isError(err, new GSError());
            test.strictSame(err.code, errorCodes.INVALID_DELETION_OPERATION);
          } finally {
            test.end();
          }
        });

        test.test('invalid gs.create with Include categories', async test => {
          try {
            await provider.create('Address', {
              Country: 'France',
              City: 'Paris',
            });
            test.fail('must have thrown an error');
          } catch (err) {
            test.isError(err, new GSError());
            test.strictSame(err.code, errorCodes.INVALID_CREATION_OPERATION);
          } finally {
            test.end();
          }
        });
      },
      { dependentSubtests: true }
    );

    test.test('PostgresProvider test', test => {
      test.endAfterSubtests();

      test.test('gs.select from category with Include', async test => {
        const company = {
          Name: 'CompanyName',
          Address: {
            Country: 'Country',
            City: 'City',
          },
        };

        const id = await provider.create('Company', company);
        test.assert(id);
        company.Id = id;
        company.Address.Id = id;

        const result = await provider
          .select('Company', { Name: company.Name })
          .fetch();
        test.strictEqual(result.length, 1);
        const [selectedCompany] = result;
        test.strictSame(selectedCompany, company);
        test.end();
      });
    });

    test.test('PostgresProvider Many-to-many test', async test => {
      const writer = {
        FullName: 'Douglas Adams',
        Works: [
          {
            Name: "The Hitchhiker's Guide to the Galaxy",
            PublicationYear: 1979,
          },
          {
            Name: 'The Restaurant at the End of the Universe',
            PublicationYear: 1980,
          },
          {
            Name: 'Life, the Universe and Everything',
            PublicationYear: 1982,
          },
        ],
      };

      writer.Id = await provider.create('Writer', {
        FullName: writer.FullName,
      });

      await Promise.all(
        writer.Works.map(async work => {
          work.Id = await provider.create('Work', work);
        })
      );

      test.endAfterSubtests();

      const workId = writer.Works[0].Id;

      test.test('gs.linkDetails with one item', async test => {
        await provider.linkDetails('Writer', 'Works', writer.Id, workId);
        const works = await provider.getDetails('Writer', writer.Id, 'Works');
        test.strictSame(works.length, 1);
        test.strictSame(works[0], writer.Works[0]);
        test.end();
      });

      test.test('gs.unlinkDetails with one item', async test => {
        await provider.unlinkDetails('Writer', 'Works', writer.Id, workId);
        const works = await provider.getDetails('Writer', writer.Id, 'Works');
        test.strictSame(works.length, 0);
        test.end();
      });

      const worksIds = writer.Works.map(work => work.Id);

      test.test('gs.linkDetails with multiple items', async test => {
        await provider.linkDetails('Writer', 'Works', writer.Id, worksIds);
        const works = await provider.getDetails('Writer', writer.Id, 'Works');
        const sortFn = (a, b) => {
          if (a.Id > b.Id) {
            return 1;
          }
          if (a.Id < b.Id) {
            return -1;
          }
          return 0;
        };
        test.strictSame(works.sort(sortFn), writer.Works.sort(sortFn));
        test.end();
      });

      test.test('gs.unlinkDetails with multiple items', async test => {
        await provider.unlinkDetails('Writer', 'Works', writer.Id, worksIds);
        const works = await provider.getDetails('Writer', writer.Id, 'Works');
        test.strictSame(works.length, 0);
        test.end();
      });
    });
  },
  { parallelSubtests: true }
);
