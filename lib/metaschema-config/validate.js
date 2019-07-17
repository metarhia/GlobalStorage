'use strict';

const {
  errors: { ValidationError },
  extractDecorator,
} = require('metaschema');

const checkLink = (value, path) => {
  const valueClass = value.constructor.name;
  return valueClass === 'Uint64' || valueClass === 'String'
    ? []
    : [
        new ValidationError('invalidClass', path, {
          expected: ['Uint64', 'String'],
          actual: valueClass,
        }),
      ];
};

const validateLink = (ms, property, instance, options) => {
  const { path } = options;
  const type = extractDecorator(property);

  if (type === 'Include') {
    const type = typeof instance;
    if (type !== 'object') {
      return [
        new ValidationError('invalidType', path, {
          expected: 'object',
          actual: type,
        }),
      ];
    }
    options.path += '.';
    const error = ms.validate('category', property, instance, options);
    return error ? error.errors : [];
  } else if (type !== 'Many') {
    return checkLink(instance, path);
  } else if (!Array.isArray(instance)) {
    return [
      new ValidationError('invalidType', `${path}`, {
        expected: 'Array',
        actual: typeof instance,
      }),
    ];
  } else {
    return instance.reduce(
      (acc, cur, idx) => acc.concat(checkLink(cur, `${path}[${idx}]`)),
      []
    );
  }
};

const validate = (ms, schema, instance, options = {}) => {
  const { path = '', patch = false } = options;
  const errors = [];
  const schemaProps = new Set(Object.keys(schema));
  const objectProps = new Set(Object.keys(instance));
  const props = new Set([...schemaProps, ...objectProps]);
  for (const prop of props) {
    const isSchemaProp = schemaProps.has(prop);
    const isObjectProp = objectProps.has(prop);
    if (isObjectProp && !isSchemaProp) {
      if (prop !== 'Id') {
        errors.push(
          new ValidationError('unresolvedProperty', `${path}${prop}`)
        );
      }
      continue;
    }

    const property = schema[prop];

    if (extractDecorator(property) === 'Validate' && !patch) {
      if (!property.validate(instance)) {
        errors.push(new ValidationError('validation', `${path}${prop}`));
      }
      continue;
    }

    if (property.readOnly && patch) {
      errors.push(new ValidationError('immutable', `${path}${prop}`));
      continue;
    }

    if (!isObjectProp) {
      if (property.required && !patch && property.default === undefined) {
        errors.push(new ValidationError('missingProperty', `${path}${prop}`));
      }
      continue;
    }

    const value = instance[prop];

    if (value === undefined || value === null) {
      if (property.required) {
        errors.push(new ValidationError('emptyValue', `${path}${prop}`));
      }
      continue;
    }

    const opts = { ...options };
    opts.path = `${path}${prop}`;

    if (property.domain) {
      const error = ms.validate('domains', property.domain, value, opts);
      if (error) errors.push(...error.errors);
    } else if (property.context) {
      const error = ms.validate('context', property.context, value, opts);
      if (error) errors.push(...error.errors);
    } else if (property.category) {
      errors.push(...validateLink(ms, property, value, opts));
    }

    if (property.validate && !property.validate(value)) {
      errors.push(new ValidationError('propValidation', `${path}${prop}`));
    }
  }

  return errors;
};

module.exports = validate;
