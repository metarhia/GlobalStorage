'use strict';

const common = require('@metarhia/common');
const { extractDecorator } = require('metaschema');
const metasync = require('metasync');
const pg = require('pg');

const { GSError, codes: errorCodes } = require('./errors');
const { StorageProvider } = require('./provider');
const {
  generateQueryParams,
  generateLinkQueryParams,
  escapeIdentifier,
  buildWhere,
  generateDeleteQuery,
  symbols: { recreateIdTrigger, uploadCategoriesAndActions },
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
  //   callback - <Function>
  //     err - <Error> | <null>
  //     provider - <this>
  open(options, callback) {
    super.open(options, err => {
      if (err) {
        callback(err, this);
        return;
      }
      this.pool = new pg.Pool(options);
      this.active = true;
      process.nextTick(callback, null, this);
    });
  }

  // Close PostgresProvider
  //   callback - <Function>
  //     err - <Error> | <null>
  close(callback) {
    if (!this.pool) {
      callback();
      return;
    }

    this.pool.end(() => {
      this.pool = null;
      this.active = false;
      callback();
    });
  }

  [recreateIdTrigger](maxIdCount, refillPercent, callback) {
    this.pool.query('DROP TRIGGER IF EXISTS idgen ON "Identifier"', err => {
      if (err) {
        callback(err);
      }

      this.pool.query(
        'SELECT trigger_creator($1, $2, $3, $4)',
        [maxIdCount, refillPercent, this.serverSuffix, this.serverBitmaskSize],
        err => {
          callback(err);
        }
      );
    });
  }

  [uploadCategoriesAndActions](callback) {
    const categories = common
      .iter(this.schema.categories)
      .filter(([, { definition: value }]) => !isIgnoredCategory(value))
      .map(([Name, { definition: value }]) => ({
        Name,
        Realm: getCategoryRealm(value),
        Family: getCategoryFamily(value),
        // TODO: remove Version when metaschema will be able to work with the
        // default values
        Version: 0,
      }))
      .toArray();
    const [Category] = categories.splice(
      categories.findIndex(c => c.Name === 'Category'),
      1
    );
    metasync.sequential(
      [
        (ctx, callback) => {
          this.create('Category', Category, (err, id) => {
            Category.Id = id;
            callback(err);
          });
        },
        (ctx, callback) => {
          this.update(
            'Identifier',
            {
              Id: Category.Id,
            },
            {
              Category: Category.Id,
            },
            err => {
              callback(err);
            }
          );
        },
        (ctx, callback) => {
          metasync.each(
            categories,
            (value, callback) => {
              this.create('Category', value, (err, id) => {
                value.Id = id;
                callback(err);
              });
            },
            err => {
              callback(err);
            }
          );
        },
        (ctx, callback) => {
          metasync.each(
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
              .toArray(),
            (value, callback) => {
              this.create('Action', value, err => {
                callback(err);
              });
            },
            err => {
              callback(err);
            }
          );
        },
      ],
      err => {
        callback(err);
      }
    );
  }

  // Generate globally unique id
  //   client - <pg.Pool> | <pg.Client>
  //   callback - <Function>
  //     err - <Error> | <null>
  //     id - <string>
  takeId(client, callback) {
    const takeIdQuery =
      'UPDATE "Identifier"' +
      ' SET "Status" = \'Init\', "Change" = CURRENT_TIMESTAMP' +
      ' WHERE "Id" = (SELECT "Id"' +
      ' FROM "Identifier"' +
      ' WHERE "Status" = \'Prealloc\' AND "StorageKind" = \'Master\'' +
      ' ORDER BY "Id" LIMIT 1' +
      ' FOR UPDATE SKIP LOCKED) RETURNING "Id"';
    client.query(takeIdQuery, (err, res) => {
      if (err) {
        callback(err);
        return;
      }

      if (res.rowCount === 0) {
        callback(
          new GSError(
            errorCodes.NOT_FOUND,
            'Cannot get Id to use for object creation'
          )
        );
        return;
      }

      callback(null, res.rows[0].Id);
    });
  }

  getCategoryById(id, callback) {
    const categoryQuery =
      'SELECT "Category"."Name"' +
      ' FROM "Identifier", "Category"' +
      ' WHERE "Identifier"."Category" = "Category"."Id" AND' +
      ' "Identifier"."Id" = $1';
    this.pool.query(categoryQuery, [id], (err, res) => {
      if (err) {
        callback(err);
        return;
      }
      if (res.rowCount === 0) {
        callback(
          new GSError(errorCodes.NOT_FOUND, `No object with Id ${id} available`)
        );
        return;
      }
      const { Name } = res.rows[0];
      callback(null, Name);
    });
  }

  // Get object from GlobalStorage
  //   id - <string>, globally unique object id
  //   callback - <Function>
  //     err - <Error> | <null>
  //     obj - <Object>
  get(id, callback) {
    this.getCategoryById(id, (err, category) => {
      if (err) {
        callback(err);
        return;
      }

      this.select(category, { [`${category}.Id`]: id }).fetch((err, rows) => {
        if (err) {
          callback(err);
          return;
        }

        if (rows.length === 0) {
          callback(
            new GSError(
              errorCodes.NOT_FOUND,
              `No object with Id ${id} available`
            )
          );
          return;
        }

        callback(null, rows[0]);
      });
    });
  }

  // Get details for many-to-many link from GlobalStorage
  //   id - <string>, globally unique object id
  //   fieldName - <string>, field with the Many decorator
  //   callback - <Function>
  //     err - <Error> | <null>
  //     details - <Object[]>
  getDetails(id, fieldName, callback) {
    this.getCategoryById(id, (err, leftCategory) => {
      if (err) {
        callback(err);
        return;
      }

      const categoryDefinition = this.schema.categories.get(leftCategory)
        .definition;
      const categoryField = categoryDefinition[fieldName];
      if (!categoryField || extractDecorator(categoryField) !== 'Many') {
        callback(
          new GSError(
            errorCodes.NOT_FOUND,
            `No 'Many' field ${fieldName} in object with Id ${id} available`
          )
        );
      }

      const rightCategory = categoryField.category;
      const escapedRightCategory = escapeIdentifier(rightCategory);
      const escapedManyTableName = escapeIdentifier(
        manyToManyTableName(leftCategory, rightCategory, fieldName)
      );

      this.pool.query(
        `SELECT ${escapedRightCategory}.* FROM ${escapedRightCategory} ` +
          `INNER JOIN ${escapedManyTableName} ON ${escapedRightCategory}."Id" =` +
          ` ${escapedManyTableName}.${escapeIdentifier(fieldName)}` +
          ` WHERE ${escapedManyTableName}` +
          `.${escapeIdentifier(leftCategory)} = $1`,
        [id],
        (err, res) => {
          callback(err, res && res.rows);
        }
      );
    });
  }

  // Set object in GlobalStorage
  //   obj - <Object>, to be stored
  //   callback - <Function>
  //     err - <Error> | <null>
  set(obj, callback) {
    if (!obj.Id) {
      throw new TypeError('Id is not provided');
    }

    const updateRecord = (category, obj, client, callback) => {
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

      client.query(setQuery, values, err => {
        callback(err);
      });
    };

    this.getCategoryById(obj.Id, (err, category) => {
      if (err) {
        callback(err);
        return;
      }
      const categoryDefinition = this.schema.categories.get(category)
        .definition;
      const error = this.schema.validate('category', category, obj);
      if (error) {
        callback(
          new GSError(
            errorCodes.INVALID_SCHEMA,
            `Invalid schema provided: ${error}`
          )
        );
        return;
      }

      this.pool.connect((err, client, done) => {
        if (err) {
          callback(err);
          return;
        }
        metasync.sequential(
          [
            cb => {
              client.query('BEGIN', err => {
                cb(err);
              });
            },
            (ctx, cb) => {
              metasync.series(
                extractIncludeCategoriesData(categoryDefinition, obj),
                (data, cb) => {
                  updateRecord(data.category, data.value, client, err => {
                    cb(err);
                  });
                },
                err => {
                  cb(err);
                }
              );
            },
            (ctx, cb) => {
              updateRecord(category, obj, client, err => {
                cb(err);
              });
            },
          ],
          (err, ctx) => {
            if (err) {
              client.query('ROLLBACK', rollbackError => {
                if (rollbackError) {
                  callback(rollbackError);
                } else {
                  callback(err);
                }
                done();
              });
              return;
            }

            client.query('COMMIT', err => {
              if (err) {
                callback(err);
              } else {
                callback(null, ctx.id);
              }
              done();
            });
          }
        );
      });
    });
  }

  // Create object in GlobalStorage
  //   category - <string>, category to store the object in
  //   obj - <Object>, to be stored
  //   callback - <Function>
  //     err - <Error> | <null>
  //     id - <string>
  create(category, obj, callback) {
    const error = this.schema.validate('category', category, obj);
    if (error) {
      process.nextTick(
        callback,
        new GSError(
          errorCodes.INVALID_SCHEMA,
          `Invalid schema provided: ${error}`
        )
      );
      return;
    }

    const categorySchema = this.schema.categories.get(category);
    const categoryDefinition = categorySchema.definition;
    if (isIgnoredCategory(categoryDefinition)) {
      process.nextTick(
        callback,
        new GSError(
          errorCodes.INVALID_CATEGORY_TYPE,
          `Record creation in ignored category: ${category}`
        )
      );
      return;
    }
    if (categorySchema.references.Include.length !== 0) {
      process.nextTick(
        callback,
        new GSError(
          errorCodes.INVALID_CREATION_OPERATION,
          `Cannot create instances of category ${category} individually, it is ` +
            'included in categories ' +
            categorySchema.references.Include.join(', ')
        )
      );
      return;
    }

    const createRecord = (category, obj, client, id, done) => {
      const categoryDefinition = this.schema.categories.get(category)
        .definition;
      let fields = Object.keys(obj).filter(key => {
        const decorator = extractDecorator(categoryDefinition[key]);
        return key !== 'Id' && decorator !== 'Include' && decorator !== 'Many';
      });
      const values = fields.map(key => obj[key]);
      if (id) {
        fields.push('Id');
        values.push(id.toString());
      }
      fields = fields.map(escapeIdentifier);
      const createQuery =
        `INSERT INTO ${escapeIdentifier(category)} ` +
        `(${fields.join(', ')})` +
        ` VALUES (${generateQueryParams(fields.length)})` +
        ' RETURNING "Id"';
      client.query(createQuery, values, (err, res) => {
        if (err) {
          done(err);
          return;
        }

        done(null, res.rows.length > 0 && res.rows[0].Id);
      });
    };

    if (isGlobalCategory(categoryDefinition)) {
      this.pool.connect((err, client, done) => {
        if (err) {
          callback(err);
          return;
        }
        metasync.sequential(
          [
            cb => {
              client.query('BEGIN', err => {
                cb(err);
              });
            },
            (ctx, cb) => {
              this.takeId(client, (err, id) => {
                ctx.id = id;
                cb(err);
              });
            },
            (ctx, cb) => {
              metasync.series(
                extractIncludeCategoriesData(categoryDefinition, obj),
                (data, cb) => {
                  createRecord(
                    data.category,
                    data.value,
                    client,
                    ctx.id,
                    err => {
                      cb(err);
                    }
                  );
                },
                err => {
                  cb(err);
                }
              );
            },
            (ctx, cb) => {
              createRecord(category, obj, client, ctx.id, err => {
                cb(err);
              });
            },
            (ctx, cb) => {
              client.query(
                'UPDATE "Identifier"' +
                  ' SET "Status" = \'Actual\', "Change" = CURRENT_TIMESTAMP,' +
                  ' "Category" = (SELECT "Id" FROM "Category" WHERE "Name" = $1),' +
                  ' "Checksum" = (SELECT get_checksum($1, $2, \'sha512\'))' +
                  ' WHERE "Id" = $2',
                [category, ctx.id],
                err => {
                  cb(err);
                }
              );
            },
          ],
          (err, ctx) => {
            if (err) {
              client.query('ROLLBACK', rollbackError => {
                if (rollbackError) {
                  callback(rollbackError);
                } else {
                  callback(err);
                }
                done();
              });
              return;
            }

            client.query('COMMIT', err => {
              if (err) {
                callback(err);
              } else {
                callback(null, ctx.id);
              }
              done();
            });
          }
        );
      });
    } else {
      createRecord(category, obj, this.pool, null, callback);
    }
  }

  // Update object in GlobalStorage
  //   category - <string>, category to update the records in
  //   query - <Object>, example: { Id }
  //   patch - <Object>, fields to update
  //   callback - <Function>
  //     err - <Error> | <null>
  //     count - <number>
  update(category, query, patch, callback) {
    const error = this.schema.validate('category', category, patch, {
      patch: true,
    });
    if (error) {
      process.nextTick(
        callback,
        new GSError(
          errorCodes.INVALID_SCHEMA,
          `Invalid schema provided: ${error}`
        )
      );
      return;
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
    this.pool.query(updateQuery, whereParams.concat(values), (err, res) => {
      callback(err, res && res.rowCount);
    });
  }

  // Delete object in GlobalStorage
  //   category - <string>, category to delete the records from
  //   query - <Object>, example: { Id }
  //   callback - <Function>
  //     err - <Error> | <null>
  //     count - <number>
  delete(category, query, callback) {
    const categorySchema = this.schema.categories.get(category);
    const categoryDefinition = categorySchema.definition;
    if (categorySchema.references.Include.length !== 0) {
      process.nextTick(
        callback,
        new GSError(
          errorCodes.INVALID_DELETION_OPERATION,
          `Cannot delete instances of category ${category}, it is included` +
            ` in categories ${categorySchema.references.Include.join(', ')}`
        )
      );
      return;
    }
    const includedCategories = extractIncludeCategories(categoryDefinition);
    const [deleteQuery, queryParams] = generateDeleteQuery(
      category,
      includedCategories,
      query
    );
    this.pool.query(deleteQuery, queryParams, (err, res) => {
      callback(err, res && res.rowCount);
    });
  }

  // Link records with Many relation between them
  //   category - <string>, category with field having the Many decorator
  //   field - <string>, field with the Many decorator
  //   fromId - <Uint64>, Id of the record in category specified in the first
  //       argument
  //   toIds - <Uint64> | <Uint64[]>, Id(s) of the record(s) in category
  //       specified in the Many decorator of the specified field
  //   callback - <Function>
  //     err - <Error> | <null>
  linkDetails(category, field, fromId, toIds, callback) {
    const categoryDefinition = this.schema.categories.get(category).definition;
    const tableName = manyToManyTableName(
      category,
      categoryDefinition[field].category,
      field
    );
    if (!Array.isArray(toIds)) {
      toIds = [toIds];
    }
    // TODO: add support for linking the records placed on different servers
    const query =
      `INSERT INTO ${escapeIdentifier(tableName)}` +
      ` VALUES ${generateLinkQueryParams(toIds.length)}`;
    this.pool.query(query, [fromId, ...toIds], err => {
      callback(err);
    });
  }

  // Unlink records with Many relation between them
  //   category - <string>, category with field having the Many decorator
  //   field - <string>, field with the Many decorator
  //   fromId - <Uint64>, Id of the record in category specified in the first
  //       argument
  //   toIds - <Uint64> | <Uint64[]>, Id(s) of the record(s) in category
  //       specified in the Many decorator of the specified field
  //   callback - <Function>
  //     err - <Error> | <null>
  unlinkDetails(category, field, fromId, toIds, callback) {
    const categoryDefinition = this.schema.categories.get(category).definition;
    const tableName = manyToManyTableName(
      category,
      categoryDefinition[field].category,
      field
    );
    if (!Array.isArray(toIds)) {
      toIds = [toIds];
    }
    // TODO: add support for unlinking the records placed on different servers
    const query =
      `DELETE FROM ${escapeIdentifier(tableName)}` +
      ` WHERE ${escapeIdentifier(category)} = $1 AND` +
      ` ${escapeIdentifier(field)} = ANY ($2)`;
    this.pool.query(query, [fromId, toIds], err => {
      callback(err);
    });
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
