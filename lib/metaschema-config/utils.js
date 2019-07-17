'use strict';

const {
  errors: { SchemaValidationError },
  extractByPath,
  extractDecorator,
} = require('metaschema');

const dataTypes = ['domain', 'category', 'context'];
const getDefinition = (type, schema) =>
  type === 'category' ? schema.definition : schema;

const processFields = (ms, category, fields, source) => {
  const errors = [];
  for (const [key, field] of Object.entries(fields)) {
    if (typeof field === 'string') {
      const src = `${source}.${key}`;
      if (!category) {
        errors.push(
          new SchemaValidationError('illegalParamsResolving', src, {
            type: 'publicAction',
          })
        );
        continue;
      }
      try {
        Object.assign(field, extractByPath(category, field.field, ms, src));
      } catch (error) {
        errors.push(error);
      }
    } else {
      for (const type of dataTypes) {
        const value = field[type];
        if (value) {
          const path = type === 'domain' ? 'domains' : type;
          const def = ms[path].get(value);
          if (!def) {
            const info = { type, value };
            errors.push(
              new SchemaValidationError('unresolved', `${source}.${key}`, info)
            );
          } else {
            field.definition = getDefinition(type, def);
          }
        }
      }
    }
  }

  return errors;
};

const REFERENCE_TYPES = new Set(['Include', 'Many', 'Master', 'Other']);

// Determines type of a reference by its decorator
//   decorator - <string>
// Returns: <string>
const getReferenceType = decorator =>
  REFERENCE_TYPES.has(decorator) ? decorator : 'Other';

const getEntityPath = entity => `${entity.category}.${entity.name}`;

const typeToPlural = {
  form: 'forms',
  action: 'actions',
};

const HIERARCHICAL_RELATIONS = ['Catalog', 'Subsystem', 'Hierarchy', 'Master'];

// Extracts category decorator type, any undecorated category
// will be treated as Local.
//   category - <Object>
// Returns: <string>
const getCategoryType = category => {
  const type = extractDecorator(category);
  return type === 'Object' ? 'Local' : type;
};

module.exports = {
  processFields,
  getReferenceType,
  getEntityPath,
  getCategoryType,
  typeToPlural: type => typeToPlural[type],
  REFERENCE_TYPES,
  HIERARCHICAL_RELATIONS,
};
