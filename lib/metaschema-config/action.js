'use strict';

const { iter } = require('@metarhia/common');

const {
  errors: { SchemaValidationError },
} = require('metaschema');

const { addCategoryData } = require('./category');
const { getEntityPath, processFields } = require('./utils');
const validate = require('./validate');

const addAction = (entity, ms) => {
  const errors = [];
  if (entity.definition.Public) {
    entity.category = null;
    if (ms.actions.has(entity.name)) {
      errors.push(
        new SchemaValidationError('duplicate', entity.name, { type: 'action' })
      );
    } else {
      ms.actions.set(entity.name, entity);
    }
  } else {
    errors.push(...addCategoryData('action', entity, ms));
  }

  return errors;
};

const processAction = (action, ms) => {
  const errors = [];
  const def = action.definition;

  const category = ms.categories.get(action.category);
  if (!category) {
    return [];
  }

  errors.push(
    ...processFields(
      ms,
      category.definition,
      def.Args,
      `${getEntityPath(action)}.Args`
    )
  );
  errors.push(
    ...processFields(
      ms,
      category.definition,
      def.Returns,
      `${getEntityPath(action)}.Returns`
    )
  );

  const formName = def.Form || action.name;
  const form = category.forms.get(formName);

  if (form) {
    iter(Object.keys(def.Args))
      .filter(arg => !!form.definition.Fields[arg])
      .each(arg =>
        errors.push(
          new SchemaValidationError(
            'duplicate',
            `${getEntityPath(action)}.Args`,
            {
              type: 'property',
              value: arg,
            }
          )
        )
      );

    action.form = form.definition;
  }

  return errors;
};

const validateAction = (ms, action, instance, options) =>
  validate(ms, action.definition.Args, instance, options);

module.exports = {
  processAction,
  addAction,
  validateAction,
};
