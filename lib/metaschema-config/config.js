'use strict';

const {
  default: { config },
  errors: { SchemaValidationError },
  extractDecorator,
} = require('metaschema');

const { decorators, localDecorators } = require('./decorators');

const {
  preprocessCategoryData,
  addCategory,
  processRelations,
  validateCategory,
  categoryCreator,
} = require('./category');

const {
  preprocessForm,
  processForm,
  addForm,
  validateForm,
} = require('./form');

const {
  addAction,
  processAction,
  validateAction,
  actionCreator,
} = require('./action');

const {
  addContext,
  postprocessContext,
  validateContext,
} = require('./context');

const { preprocessResources, addResources } = require('./resource');
const { addApplication, processApplication } = require('./application');

const { typeToPlural } = require('./utils');

SchemaValidationError.serializers.unlinked = ({ source, info: { type } }) =>
  `Unlinked ${type} '${source}'`;

SchemaValidationError.serializers.illegalLink = ({
  source,
  info: { sourceType, destination, destinationType },
}) =>
  `Illegal link from ${sourceType} '${source}' ` +
  `to ${destinationType} '${destination}`;

SchemaValidationError.serializers.detailHierarchy = ({
  source,
  info: { type, master },
}) =>
  `Category '${source}' can not be divided by ${type} ` +
  `while being a detail of '${master}'`;

SchemaValidationError.serializers.illegalParamsResolving = ({
  source,
  info: { type },
}) => `Params resolving is forbidden for ${type}: '${source}'`;

SchemaValidationError.serializers.ownedPublic = ({ source, info: { type } }) =>
  `Public ${type}: '${source}' can not be defined on a category`;

SchemaValidationError.serializers.nonSerializable = ({ source }) =>
  `Non-serializable function: ${source}`;

const preprocessor = schemas => {
  const arr = [...schemas];

  for (const schema of schemas) {
    if (schema.type !== 'category') {
      continue;
    }
    Object.entries(schema.definition).forEach(([key, value]) => {
      const decorator = extractDecorator(value);
      if (decorator === 'Action') {
        delete schema.definition[key];
        arr.push({
          type: 'action',
          name: `${schema.name}.${key}`,
          module: schema.module,
          definition: value,
        });
      }
    });
  }

  return arr;
};

const validate = (schema, path) => {
  const errors = [];

  for (const [prop, value] of Object.entries(schema)) {
    if (!value) continue;

    const valueType = typeof value;
    if (valueType === 'object') {
      errors.push(...validate(value, `${path}.${prop}`));
    } else if (valueType === 'function') {
      const stringifyValue = value.toString();
      let err;
      try {
        // check serialization for function expression, arrow and regular funcs
        new Function(`(${stringifyValue})`);
      } catch (e) {
        err = e;
      }

      if (err && !value.prototype) {
        err = null;
        try {
          // check serialization for methods
          new Function(`({${stringifyValue}})`);
        } catch (e) {
          err = e;
        }
      }

      if (err) {
        errors.push(
          new SchemaValidationError('nonSerializable', `${path}.${prop}`)
        );
      }
    }
  }

  return errors;
};

const validateSchema = schema =>
  validate(
    schema.definition,
    schema.category ? `${schema.category}.${schema.name}` : schema.name
  );

module.exports = {
  options: {
    decorators,
    localDecorators,
    pathToType: {
      domains: 'domains',
      context: 'context',
      category: 'category',
      action: 'action',
      form: 'form',
      json: 'resource',
      application: 'application',
    },
    preprocessor,
  },
  config: {
    prepare: ms => {
      ms.categories = new Map();
      ms.domains = new Map();
      ms.context = new Map();
      ms.actions = new Map();
      ms.resources = {
        common: new Map(),
        domains: new Map(),
      };
      ms.applications = new Map();
      ms.createAndValidate = (type, schema, instance, options) => {
        let value;
        try {
          value = ms.create(type, schema, instance, options);
        } catch (err) {
          return [err];
        }
        const err = ms.validate(type, schema, value, options);
        return [err, value];
      };
    },
    resolve: (ms, type, name) => {
      if (type === 'domains') {
        return ms.domains.get(name);
      } else if (type === 'context') {
        return ms.context.get(name);
      } else if (type === 'category') {
        return ms.categories.get(name);
      } else {
        const [category, entity] = name.split('.');
        if (type === 'action' && !entity) {
          return ms.actions.get(name);
        }
        return ms.categories.get(category)[typeToPlural(type)].get(entity);
      }
    },
    processors: {
      domains: {
        ...config.processors.domains,
        validateSchema: [validateSchema],
      },
      context: {
        add: [addContext],
        postprocess: [postprocessContext],
        validateInstance: validateContext,
      },
      category: {
        add: [...config.processors.category.add, addCategory],
        postprocess: [
          ...config.processors.category.postprocess,
          processRelations,
        ],
        validateInstance: validateCategory,
        creator: categoryCreator,
        validateSchema: [validateSchema],
      },
      action: {
        preprocess: [preprocessCategoryData.bind(null, 'action')],
        add: [addAction],
        postprocess: [processAction],
        validateInstance: validateAction,
        creator: actionCreator,
        validateSchema: [validateSchema],
      },
      form: {
        preprocess: [preprocessCategoryData.bind(null, 'form'), preprocessForm],
        add: [addForm],
        postprocess: [processForm],
        validateInstance: validateForm,
      },
      resource: {
        preprocess: [preprocessResources],
        add: [addResources],
      },
      application: {
        add: [addApplication],
        postprocess: [processApplication],
      },
    },
    processOrder: {
      domains: 0,
      category: 1,
      context: 2,
      form: 3,
      action: 4,
      resource: 5,
      application: 6,
    },
  },
};
