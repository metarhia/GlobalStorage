'use strict';

const metaschema = require('metaschema');
const metatests = require('metatests');

const { options, config } = require('../lib/metaschema-config/config');

const {
  MetaschemaError,
  SchemaValidationError,
  ValidationError,
} = metaschema.errors;

metatests.test('metaschema correct context usage', async test => {
  const schema = await metaschema.fs.load(
    'test/fixtures/context/valid',
    options,
    config
  );

  test.assertNot(
    schema.validate('action', 'PublicAction', { valueFromContext: 'value' })
  );

  test.isError(
    schema.validate('action', 'PublicAction', { valueFromContext: 10 }),
    new MetaschemaError([
      new ValidationError('invalidType', 'valueFromContext', {
        expected: 'string',
        actual: 'number',
      }),
    ])
  );
});

metatests.test('metaschema context error on duplicated domains', async test => {
  await test.rejects(
    metaschema.fs.load('test/fixtures/context/duplicate', options, config),
    new MetaschemaError([
      new SchemaValidationError('duplicate', 'duplicateDomain', {
        type: 'context',
        value: 'duplicateDomain',
      }),
    ])
  );
});

metatests.test('metaschema context error on unresolved domain', async test => {
  await test.rejects(
    metaschema.fs.load('test/fixtures/context/unresolved', options, config),
    new MetaschemaError([
      new SchemaValidationError('unresolved', 'context.Nomen', {
        type: 'domain',
        value: 'Nomen',
      }),
    ])
  );
});
