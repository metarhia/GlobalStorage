'use strict';

const { SchemaValidationError } = require('metaschema').errors;

const addContext = (context, ms) => {
  const errors = [];
  const isDuplicated = ms.context.size > 0;
  if (isDuplicated) {
    errors.push(
      new SchemaValidationError('duplicate', context.name, {
        type: 'context',
        value: context.name,
      })
    );
  } else {
    Object.entries(context.definition).forEach(([name, field]) =>
      ms.context.set(name, field)
    );
  }
  return errors;
};

const postprocessContext = (context, ms) => {
  const errors = [];
  for (const [fieldName, field] of Object.entries(context.definition)) {
    const domain = ms.domains.get(field.domain);
    if (domain) {
      field.definition = domain;
    } else {
      errors.push(
        new SchemaValidationError(
          'unresolved',
          `${context.name}.${fieldName}`,
          { type: 'domain', value: field.domain }
        )
      );
    }
  }
  return errors;
};

const validateContext = (ms, schema, instance, options) => {
  const { domain } = schema;
  const error = ms.validate('domains', domain, instance, options);
  return error ? error.errors : [];
};

module.exports = {
  addContext,
  postprocessContext,
  validateContext,
};
