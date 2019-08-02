'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const common = require('@metarhia/common');
const { extractDecorator } = require('metaschema');
const pg = require('pg');

const { generateDDL } = require('./pg.ddl');
const { GSError, codes: errorCodes } = require('./errors');
const { StorageProvider } = require('./provider');
const {
  generateQueryParams,
  generateLinkQueryParams,
  escapeIdentifier,
  buildWhere,
  generateDeleteQuery,
  symbols: { recreateIdTrigger, uploadMetadata },
} = require('./pg.utils');
const { PostgresCursor } = require('./pg.cursor');
const {
  isGlobalCategory,
  isIgnoredCategory,
  getCategoryRealm,
  getCategoryFamily,
  constructActions,
  extractIncludeCategoriesData,
  extractIncludeCategories,
} = require('./schema.utils');
const { manyToManyTableName } = require('./ddl.utils');

const rollback = Symbol('rollback');

const availableTxIsolationMethods = {
  committed: 'READ COMMITTED',
  repeatable: 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

const nonTxMethods = new Set([
  'open',
  'close',
  'setup',
  uploadMetadata,
  recreateIdTrigger,
]);

const getTxStmts = (client, op) => {
  const stmts = {};
  if (!client.release) {
    stmts.begin = 'BEGIN';
    stmts.commit = 'COMMIT';
    stmts.rollback = 'ROLLBACK';
  } else {
    stmts.begin = `SAVEPOINT gs${op}`;
    stmts.commit = `RELEASE SAVEPOINT gs${op}`;
    stmts.rollback = `ROLLBACK TO SAVEPOINT gs${op}`;
  }
  return stmts;
};

const isPool = client => !client.release;

class PostgresProvider extends StorageProvider {
  // Create PostgresProvider
  constructor(options) {
    super(options);

    this.pool = null;
    this.cursorFactory = (provider, category, jsql) =>
      new PostgresCursor(provider, { category, jsql });
  }

  // Open PostgresProvider
  //   options - <Object>, to be passed to pg
  // Returns: <Promise>
  async open(options) {
    await super.open(options);
    this.pool = new pg.Pool(options);
    this.active = true;
    return this;
  }

  // Close PostgresProvider
  // Returns: <Promise>
  async close() {
    if (!this.pool) {
      return;
    }

    await this.pool.end();
    this.pool = null;
    this.active = false;
  }

  // Setup StorageProvider
  //   options - <Object>
  //     maxIdCount - <number>
  //     refillPercent - <number>
  // Returns: <Promise>
  async setup(options) {
    const { maxIdCount = 1000, refillPercent = 30 } = options || {};
    const readFile = util.promisify(fs.readFile);
    try {
      const initSql = await readFile(
        path.join(__dirname, '..', 'sql', 'id.sql'),
        'utf8'
      );
      await this.pool.query(initSql);
      await this.pool.query(generateDDL(this.schema));
      await this[recreateIdTrigger](maxIdCount, refillPercent);
      await this[uploadMetadata]();
    } catch (err) {
      if (err instanceof GSError) {
        throw err;
      }
      this.systemLogger(err);
      throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
    }
  }

  async [recreateIdTrigger](maxIdCount, refillPercent) {
    try {
      await this.pool.query('DROP TRIGGER IF EXISTS idgen ON "Identifier"');
      await this.pool.query('SELECT trigger_creator($1, $2, $3, $4)', [
        maxIdCount,
        refillPercent,
        this.serverSuffix,
        this.serverBitmaskSize,
      ]);
    } catch (err) {
      this.systemLogger(err);
      throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
    }
  }

  async [uploadMetadata]() {
    const categories = common
      .iter(this.schema.categories.values())
      .filter(({ definition: value }) => !isIgnoredCategory(value))
      .map(({ name: Name, definition: value }) => ({
        Name,
        Realm: getCategoryRealm(value),
        Family: getCategoryFamily(value),
      }))
      .toArray();
    const applications = common
      .iter(this.schema.applications.values())
      .map(({ name: Name, definition: value }) => ({
        Name,
        Categories: value.Categories.map(name =>
          categories.find(c => c.Name === name)
        ),
      }));
    const [Category] = categories.splice(
      categories.findIndex(c => c.Name === 'Category'),
      1
    );

    try {
      Category.Id = await this.create('Category', Category);

      await this.update(
        'Identifier',
        {
          Id: Category.Id,
        },
        {
          Category: Category.Id,
        }
      );

      await Promise.all(
        categories.map(async value => {
          value.Id = await this.create('Category', value);
        })
      );

      await Promise.all(
        common
          .iter(categories)
          .flatMap(c =>
            constructActions(
              this.schema.categories.get(c.Name).actions,
              false,
              c.Id
            )
          )
          .chain(constructActions(this.schema.actions, true))
          .map(value => this.create('Action', value))
      );

      await Promise.all(
        applications.map(async app => {
          const id = await this.create('Application', {
            Name: app.Name,
          });
          return this.linkDetails(
            'Application',
            'Categories',
            id,
            app.Categories.map(c => c.Id)
          );
        })
      );
    } catch (err) {
      this.systemLogger(err);
      throw err;
    }
  }

  async [rollback](client, stmt, err) {
    this.systemLogger(err);
    return client.query(stmt).then(
      () => {
        throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
      },
      rollbackError => {
        this.systemLogger(rollbackError);
        throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, rollbackError);
      }
    );
  }

  // Generate globally unique id
  //   client - <pg.Pool> | <pg.Client>
  // Returns: <Promise>
  async takeId(client) {
    const takeIdQuery =
      'UPDATE "Identifier"' +
      ' SET "Status" = \'Init\', "Change" = CURRENT_TIMESTAMP' +
      ' WHERE "Id" = (SELECT "Id"' +
      ' FROM "Identifier"' +
      ' WHERE "Status" = \'Prealloc\' AND "StorageKind" = \'Master\'' +
      ' ORDER BY "Id" LIMIT 1' +
      ' FOR UPDATE SKIP LOCKED) RETURNING "Id"';
    const res = await client.query(takeIdQuery);

    if (res.rowCount === 0) {
      throw new GSError(
        errorCodes.NOT_FOUND,
        'Cannot get Id to use for object creation'
      );
    }

    return res.rows[0].Id;
  }

  async getCategoryById(id) {
    const categoryQuery =
      'SELECT "Category"."Name"' +
      ' FROM "Identifier", "Category"' +
      ' WHERE "Identifier"."Category" = "Category"."Id" AND' +
      ' "Identifier"."Id" = $1';
    let res;
    try {
      res = await this.pool.query(categoryQuery, [id]);
    } catch (err) {
      this.systemLogger(err);
      throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
    }
    if (res.rowCount === 0) {
      throw new GSError(
        errorCodes.NOT_FOUND,
        `No object with Id ${id} available`
      );
    }
    return res.rows[0].Name;
  }

  // Begin transaction, returns a Promise that resolves in an object containing
  // some of the methods of the current provider and also the methods
  // `commit()`, `rollback()`, and `release()`.
  // For more detailed description of the options see
  // https://www.postgresql.org/docs/current/sql-set-transaction.html
  // Signature: [options]
  //   options - <Object>, transaction options
  //     isolationLevel - <string>, 'committed', 'repeatable', or 'serializable'
  //     readOnly - <boolean>
  //     deferrable - <boolean>
  // Returns: <Promise>
  async beginTx(options = {}) {
    const { isolationLevel, readOnly, deferrable } = options;
    let beginStmt = 'BEGIN';
    if (isolationLevel) {
      const sql = availableTxIsolationMethods[isolationLevel];
      if (!sql) {
        throw new TypeError(
          `Unknown transaction isolation level: ${isolationLevel}`
        );
      } else {
        beginStmt += sql;
      }
    }
    if (readOnly) {
      beginStmt += ' READ ONLY';
    }
    if (deferrable) {
      beginStmt += ' DEFERRABLE';
    }
    const client = await this.pool.connect();
    await client.query(beginStmt);
    const commit = async () => {
      await client.query('COMMIT');
    };
    const rb = this[rollback].bind(this, client, 'ROLLBACK');
    const release = () => client.release();
    return new Proxy(this, {
      get(provider, prop, proxy) {
        if (prop === 'pool') return client;
        if (prop === 'commit') return commit;
        if (prop === 'rollback') return rb;
        if (prop === 'release') return release;
        if (nonTxMethods.has(prop)) return undefined;
        return Reflect.get(provider, prop, proxy);
      },
    });
  }

  // Get object from GlobalStorage
  // Signature: id[, permissionChecker]
  //   id - <string>, globally unique object id
  //   permissionChecker - <Function>, optional
  //     category - <string>
  //     options - <Object>
  //   Returns: <Promise>
  // Returns: <Promise>
  async get(id, permissionChecker) {
    const category = await this.getCategoryById(id);

    const rows = await this.select(category, {
      [`${category}.Id`]: id,
    }).fetch();

    if (rows.length === 0) {
      throw new GSError(
        errorCodes.NOT_FOUND,
        `No object with Id ${id} available`
      );
    }
    const result = rows[0];
    if (permissionChecker) {
      await permissionChecker(category, { record: result });
    }
    return result;
  }

  // Get details for many-to-many link from GlobalStorage
  // Signature: category, id, fieldName[, permissionChecker]
  //   category - <string>, category to get details in
  //   id - <string>, object id
  //   fieldName - <string>, field with the Many decorator
  //   permissionChecker - <Function>, optional
  //     category - <string>
  //     options - <Object>
  //   Returns: <Promise>
  // Returns: <Promise>
  async getDetails(category, id, fieldName, permissionChecker) {
    const categorySchema = this.schema.categories.get(category);
    if (!categorySchema) {
      throw new GSError(
        errorCodes.NOT_FOUND,
        `No category ${category} available`
      );
    }
    const categoryDefinition = categorySchema.definition;
    const categoryField = categoryDefinition[fieldName];
    if (!categoryField || extractDecorator(categoryField) !== 'Many') {
      throw new GSError(
        errorCodes.NOT_FOUND,
        `No 'Many' field ${fieldName} in object with Id ${id} available`
      );
    }

    const rightCategory = categoryField.category;
    const rightCategorySchema = this.schema.categories.get(rightCategory);
    let requiresFiltering = false;
    if (permissionChecker) {
      const args = [[category, { id }]];
      if (!rightCategorySchema.catalog && !rightCategorySchema.subsystem) {
        args.push([rightCategory, null]);
      } else {
        requiresFiltering = true;
      }
      await Promise.all(args.map(args => permissionChecker(...args)));
    }

    const escapedRightCategory = escapeIdentifier(rightCategory);
    const escapedManyTableName = escapeIdentifier(
      manyToManyTableName(category, rightCategory, fieldName)
    );

    let res;
    try {
      res = await this.pool.query(
        `SELECT ${escapedRightCategory}.* FROM ${escapedRightCategory} ` +
          `INNER JOIN ${escapedManyTableName} ON ${escapedRightCategory}."Id" =` +
          ` ${escapedManyTableName}.${escapeIdentifier(fieldName)}` +
          ` WHERE ${escapedManyTableName}` +
          `.${escapeIdentifier(category)} = $1`,
        [id]
      );
    } catch (err) {
      this.systemLogger(err);
      throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
    }

    if (!requiresFiltering) {
      return res.rows;
    }
    const toFilter = await Promise.all(
      res.rows.map(async record => {
        try {
          await permissionChecker(rightCategory, { record });
          return record;
        } catch (err) {
          if (err.code === errorCodes.INSUFFICIENT_PERMISSIONS) {
            return null;
          }
          throw err;
        }
      })
    );
    return toFilter.filter(r => r);
  }

  // Set object in GlobalStorage
  // Signature: obj[, permissionChecker]
  //   obj - <Object>, to be stored
  //   permissionChecker - <Function>, optional
  //     category - <string>
  //     options - <Object>
  //   Returns: <Promise>
  // Returns: <Promise>
  async set(obj, permissionChecker) {
    if (!obj.Id) {
      throw new TypeError('Id is not provided');
    }

    const updateRecord = async (category, obj, client) => {
      const categoryDefinition = this.schema.categories.get(category)
        .definition;
      let fields = Object.keys(obj).filter(
        key =>
          key !== 'Id' &&
          extractDecorator(categoryDefinition[key]) !== 'Include'
      );
      const values = fields.map(key => obj[key]);
      values.unshift(obj.Id);
      fields = fields.map(escapeIdentifier);
      const setQuery =
        `UPDATE ${escapeIdentifier(category)}` +
        ` SET (${fields.join(', ')}) =` +
        ` ROW (${generateQueryParams(fields.length, 2)})` +
        ' WHERE "Id" = $1';

      return client.query(setQuery, values);
    };

    const category = await this.getCategoryById(obj.Id);
    const categoryDefinition = this.schema.categories.get(category).definition;
    let error;
    [error, obj] = this.schema.createAndValidate('category', category, obj);
    if (error) {
      throw new GSError(
        errorCodes.INVALID_SCHEMA,
        `Invalid schema provided: ${error}`
      );
    }

    if (permissionChecker) {
      await Promise.all([
        permissionChecker(category, { id: obj.Id }),
        permissionChecker(category, { record: obj }),
      ]);
    }

    const txStmts = getTxStmts(this.pool, 'set');
    let client;
    if (isPool(this.pool)) {
      try {
        client = await this.pool.connect();
      } catch (err) {
        this.systemLogger(err);
        throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
      }
    } else {
      client = this.pool;
    }

    try {
      await client.query(txStmts.begin);

      for (const data of extractIncludeCategoriesData(
        categoryDefinition,
        obj
      )) {
        await updateRecord(data.category, data.value, client);
      }
      await updateRecord(category, obj, client);
      await client.query(txStmts.commit);
    } catch (err) {
      await this[rollback](client, txStmts.rollback, err);
    } finally {
      client.release();
    }
  }

  // Create object in GlobalStorage
  // Signature: category, obj[, permissionChecker]
  //   category - <string>, category to store the object in
  //   obj - <Object>, to be stored
  //   permissionChecker - <Function>, optional
  //     category - <string>
  //     options - <Object>
  //   Returns: <Promise>
  // Returns: <Promise>
  async create(category, obj, permissionChecker) {
    let error;
    [error, obj] = this.schema.createAndValidate('category', category, obj);
    if (error) {
      throw new GSError(
        errorCodes.INVALID_SCHEMA,
        `Invalid schema provided: ${error}`
      );
    }

    const categorySchema = this.schema.categories.get(category);
    const categoryDefinition = categorySchema.definition;
    if (isIgnoredCategory(categoryDefinition)) {
      throw new GSError(
        errorCodes.INVALID_CATEGORY_TYPE,
        `Record creation in ignored category: ${category}`
      );
    }
    if (categorySchema.references.Include.length !== 0) {
      throw new GSError(
        errorCodes.INVALID_CREATION_OPERATION,
        `Cannot create instances of category ${category} individually, it is ` +
          'included in categories ' +
          categorySchema.references.Include.join(', ')
      );
    }

    const createRecord = async (category, obj, client, id) => {
      const categoryDefinition = this.schema.categories.get(category)
        .definition;
      let fields = Object.keys(obj).filter(key => {
        if (key === 'Id') return false;
        const decorator = extractDecorator(categoryDefinition[key]);
        return decorator !== 'Include' && decorator !== 'Many';
      });
      const values = fields.map(key => obj[key]);
      if (id) {
        fields.push('Id');
        values.push(id.toString());
      }
      fields = fields.map(escapeIdentifier);

      let createQuery = `INSERT INTO ${escapeIdentifier(category)} `;
      if (fields.length !== 0) {
        createQuery +=
          `(${fields.join(', ')})` +
          ` VALUES (${generateQueryParams(fields.length)})`;
      } else {
        createQuery += 'DEFAULT VALUES';
      }
      createQuery += ' RETURNING "Id"';

      const res = await client.query(createQuery, values);
      return res.rows[0].Id;
    };

    if (permissionChecker) {
      await permissionChecker(category, { record: obj });
    }

    if (!isGlobalCategory(categoryDefinition)) {
      try {
        return await createRecord(category, obj, this.pool, null);
      } catch (err) {
        this.systemLogger(err);
        throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
      }
    }

    const txStmts = getTxStmts(this.pool, 'create');
    let client;
    if (isPool(this.pool)) {
      try {
        client = await this.pool.connect();
      } catch (err) {
        this.systemLogger(err);
        throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
      }
    } else {
      client = this.pool;
    }

    try {
      await client.query(txStmts.begin);
      const id = await this.takeId(client);
      await Promise.all(
        extractIncludeCategoriesData(categoryDefinition, obj).map(data =>
          createRecord(data.category, data.value, client, id)
        )
      );
      await createRecord(category, obj, client, id);
      await client.query(
        'UPDATE "Identifier"' +
          ' SET "Status" = \'Actual\', "Change" = CURRENT_TIMESTAMP,' +
          ' "Category" = (SELECT "Id" FROM "Category" WHERE "Name" = $1),' +
          ' "Checksum" = (SELECT get_checksum($1, $2, \'sha512\'))' +
          ' WHERE "Id" = $2',
        [category, id]
      );
      await client.query(txStmts.commit);
      return id;
    } catch (err) {
      return this[rollback](client, txStmts.rollback, err);
    } finally {
      client.release();
    }
  }

  // Update object in GlobalStorage
  // Signature: category, query, patch[, permissionChecker]
  //   category - <string>, category to update the records in
  //   query - <Object>, example: `{ Id }`
  //   patch - <Object>, fields to update
  //   permissionChecker - <Function>, optional
  //     category - <string>
  //     options - <Object>
  //   Returns: <Promise>
  // Returns: <Promise>
  async update(category, query, patch, permissionChecker) {
    let error;
    [error, patch] = this.schema.createAndValidate(
      'category',
      category,
      patch,
      {
        patch: true,
      }
    );
    if (error) {
      throw new GSError(
        errorCodes.INVALID_SCHEMA,
        `Invalid schema provided: ${error}`
      );
    }

    if (permissionChecker) {
      await permissionChecker(category, { record: query, isQuery: true });
      await permissionChecker(category, { record: patch, isPatch: true });
    }

    let fields = Object.keys(patch);
    const values = fields.map(key => patch[key]);
    fields = fields.map(escapeIdentifier);
    const [where, whereParams] = buildWhere(query);
    const updateQuery =
      `UPDATE ${escapeIdentifier(category)} SET ` +
      `(${fields.join(', ')}) = ` +
      `ROW (${generateQueryParams(fields.length, whereParams.length + 1)})` +
      where;

    try {
      const res = await this.pool.query(
        updateQuery,
        whereParams.concat(values)
      );
      return res.rowCount;
    } catch (err) {
      this.systemLogger(err);
      throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
    }
  }

  // Delete object in GlobalStorage
  // Signature: category, query[, permissionChecker]
  //   category - <string>, category to delete the records from
  //   query - <Object>, example: `{ Id }`
  //   permissionChecker - <Function>, optional
  //     category - <string>
  //     options - <Object>
  //   Returns: <Promise>
  // Returns: <Promise>
  async delete(category, query, permissionChecker) {
    const categorySchema = this.schema.categories.get(category);
    const categoryDefinition = categorySchema.definition;
    if (categorySchema.references.Include.length !== 0) {
      throw new GSError(
        errorCodes.INVALID_DELETION_OPERATION,
        `Cannot delete instances of category ${category}, it is included` +
          ` in categories ${categorySchema.references.Include.join(', ')}`
      );
    }

    if (permissionChecker) {
      await permissionChecker(category, { record: query, isQuery: true });
    }
    const includedCategories = extractIncludeCategories(categoryDefinition);
    const [deleteQuery, queryParams] = generateDeleteQuery(
      category,
      includedCategories,
      query
    );
    try {
      const res = await this.pool.query(deleteQuery, queryParams);
      return res.rowCount;
    } catch (err) {
      this.systemLogger(err);
      throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
    }
  }

  // Link records with Many relation between them
  // Signature: category, field, fromId, toIds[, permissionChecker]
  //   category - <string>, category with field having the Many decorator
  //   field - <string>, field with the Many decorator
  //   fromId - <Uint64>, Id of the record in category specified in the first
  //       argument
  //   toIds - <Uint64> | <Uint64[]>, Id(s) of the record(s) in category
  //       specified in the Many decorator of the specified field
  //   permissionChecker - <Function>, optional
  //     category - <string>
  //     options - <Object>
  //   Returns: <Promise>
  // Returns: <Promise>
  async linkDetails(category, field, fromId, toIds, permissionChecker) {
    const categorySchema = this.schema.categories.get(category);
    const categoryDefinition = categorySchema.definition;
    const toCategory = categorySchema.definition[field].category;
    const tableName = manyToManyTableName(
      category,
      categoryDefinition[field].category,
      field
    );
    if (!Array.isArray(toIds)) {
      toIds = [toIds];
    }
    if (toIds.length === 0) {
      return;
    }
    if (permissionChecker) {
      await Promise.all(
        [
          [category, { id: fromId }],
          ...toIds.map(id => [toCategory, { id, accessType: 'read' }]),
        ].map(args => permissionChecker(...args))
      );
    }
    // TODO: add support for linking the records placed on different servers
    const query =
      `INSERT INTO ${escapeIdentifier(tableName)}` +
      ` VALUES ${generateLinkQueryParams(toIds.length)}`;
    try {
      await this.pool.query(query, [fromId, ...toIds]);
    } catch (err) {
      this.systemLogger(err);
      throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
    }
  }

  // Unlink records with Many relation between them
  // Signature: category, field, fromId, toIds[, permissionChecker]
  //   category - <string>, category with field having the Many decorator
  //   field - <string>, field with the Many decorator
  //   fromId - <Uint64>, Id of the record in category specified in the first
  //       argument
  //   toIds - <Uint64> | <Uint64[]>, Id(s) of the record(s) in category
  //       specified in the Many decorator of the specified field
  //   permissionChecker - <Function>, optional
  //     category - <string>
  //     options - <Object>
  //   Returns: <Promise>
  // Returns: <Promise>
  async unlinkDetails(category, field, fromId, toIds, permissionChecker) {
    const categorySchema = this.schema.categories.get(category);
    const toCategory = categorySchema.definition[field].category;
    const tableName = manyToManyTableName(category, toCategory, field);
    if (!Array.isArray(toIds)) {
      toIds = [toIds];
    }
    if (toIds.length === 0) {
      return;
    }
    if (permissionChecker) {
      await Promise.all(
        [
          [category, { id: fromId }],
          ...toIds.map(id => [toCategory, { id, accessType: 'read' }]),
        ].map(args => permissionChecker(...args))
      );
    }
    // TODO: add support for unlinking the records placed on different servers
    const query =
      `DELETE FROM ${escapeIdentifier(tableName)}` +
      ` WHERE ${escapeIdentifier(category)} = $1 AND` +
      ` ${escapeIdentifier(field)} = ANY ($2)`;
    try {
      await this.pool.query(query, [fromId, toIds]);
    } catch (err) {
      this.systemLogger(err);
      throw new GSError(errorCodes.INTERNAL_PROVIDER_ERROR, err);
    }
  }

  // Select objects from GlobalStorage
  //   category - <string>, category to select the records from
  //   query - <Object>, fields conditions
  //
  // Returns: <Cursor>
  select(category, query) {
    return new PostgresCursor(this, { category }).select(query);
  }
}

module.exports = {
  PostgresProvider,
};
