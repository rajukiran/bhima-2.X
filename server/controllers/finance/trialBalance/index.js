/**
 * The trial balance provides a description of what the general
 * ledger would look like after posting data from the
 * posting journal to the general ledger.
 * It also submit errors back to the client.
 *
 */

var q = require('q'),
    db = require('../../../lib/db'),
    uuid = require('node-uuid'),
    util = require('../../../lib/util'),
    NotFound   = require('../../../lib/errors/NotFound'),
    BadRequest = require('../../../lib/errors/BadRequest');

// utility function to sum an array of objects on a particular property
function aggregate(property, array) {
  return array.reduce(function (s, row) {
    return s + row[property];
  }, 0);
}

// creates an error report for a given code
function createErrorReport(code, isFatal, rows) {
  return {
    code : code,
    fatal : isFatal,
    transactions : rows.map(function (row) { return row.trans_id; }),
    affectedRows : aggregate('count', rows)
  };
}

// Warning if the entity is null and entity_type is null also
function checkEntityIsAlwaysDefined(transactions) {

  var sql =
    `SELECT COUNT(pj.uuid) AS count, pj.trans_id, pj.entity_uuid, pj.entity_type FROM posting_journal AS pj
    WHERE pj.trans_id IN (?) AND pj.entity_type IS NULL
    GROUP BY trans_id HAVING pj.entity_uuid IS NULL;`;

  return db.exec(sql, [transactions])
    .then(function (rows) {

      // if nothing is returned, skip error report
      if (!rows.length) { return; }

      // returns a error report
      return createErrorReport('POSTING_JOURNAL.WARNINGS.MISSING_ENTITY', false, rows);
    });
}

// make sure that a entity_uuid exists for each deb_cred_type
function checkDescriptionExists(transactions) {

  var sql =
    `SELECT COUNT(pj.uuid) AS count, pj.trans_id, pj.description FROM posting_journal AS pj
    WHERE pj.trans_id IN (?) GROUP BY trans_id HAVING pj.description IS NULL;`;

  return db.exec(sql, [transactions])
  .then(function (rows) {

    // if nothing is returned, skip error report
    if (!rows.length) { return; }

    // returns a error report
    return createErrorReport('POSTING_JOURNAL.ERRORS.MISSING_DESCRIPTION', true, rows);
  });
}

// make sure that a entity_uuid exists for each deb_cred_type
function checkEntityExists(transactions) {

  var sql =
    `SELECT COUNT(pj.uuid) AS count, pj.trans_id, pj.entity_uuid FROM posting_journal AS pj
    WHERE pj.trans_id IN (?) AND (pj.entity_type = 'D' OR pj.entity_type = 'C')
    GROUP BY trans_id HAVING pj.entity_uuid IS NULL;`;

  return db.exec(sql, [transactions])
    .then(function (rows) {

      // if nothing is returned, skip error report
      if (!rows.length) { return; }

      // returns a error report
      return createErrorReport('POSTING_JOURNAL.ERRORS.MISSING_ENTITY', true, rows);
    });
}

// make sure that the record Id exist in each line of the transaction
function checkRecordUuidExists(transactions) {
  var sql =
    `SELECT COUNT(pj.uuid) AS count, pj.record_uuid, pj.trans_id FROM posting_journal AS pj
    WHERE pj.trans_id IN (?) GROUP BY pj.trans_id HAVING pj.record_uuid IS NULL;`;

  return db.exec(sql, [transactions])
  .then(function (rows) {

    // if nothing is returned, skip error report
    if (!rows.length) { return; }

    // returns a error report
    return createErrorReport('POSTING_JOURNAL.ERRORS.MISSING_DOCUMENT_ID', true, rows);
  });
}

// make sure dates are in their correct period
function checkDateInPeriod(transactions) {
  var sql =
    `SELECT COUNT(pj.uuid) AS count, pj.trans_id, pj.trans_date, p.start_date, p.end_date
    FROM posting_journal AS pj JOIN period as p ON pj.period_id = p.id
    WHERE DATE(pj.trans_date) NOT BETWEEN DATE(p.start_date) AND DATE(p.end_date) AND
      pj.trans_id IN (?)
    GROUP BY pj.trans_id;`;

  return db.exec(sql, [transactions])
    .then(function (rows) {
      // if nothing is returned, skip error report
      if (!rows.length) { return; }

      // returns a error report
      return createErrorReport('POSTING_JOURNAL.ERRORS.DATE_IN_WRONG_PERIOD', true, rows);
    });
}

// make sure fiscal years and periods exist for all transactions
function checkPeriodAndFiscalYearExists(transactions) {
  var sql =
    `SELECT COUNT(pj.uuid) AS count, pj.trans_id
    FROM posting_journal AS pj
    WHERE pj.trans_id IN (?) AND (pj.period_id IS NULL OR pj.fiscal_year_id IS NULL)
    GROUP BY pj.trans_id;`;

  return db.exec(sql, [transactions])
    .then(function (rows) {

      // if nothing is returned, skip error report
      if (!rows.length) { return; }

      // returns a error report
      return createErrorReport('POSTING_JOURNAL.ERRORS.MISSING_FISCAL_OR_PERIOD', true, rows);
    });
}

// make sure there are no missing accounts in the transactions
function checkMissingAccounts(transactions) {
  var sql =
    `SELECT COUNT(pj.uuid) AS count, pj.trans_id
    FROM posting_journal AS pj LEFT JOIN account ON
      pj.account_id = account.id
    WHERE pj.trans_id IN (?) AND account.id IS NULL
    GROUP BY pj.trans_id`;

  return db.exec(sql, [transactions])
    .then(function (rows) {

      // if nothing is returned, skip error report
      if (!rows.length) { return; }

      // returns a error report
      return createErrorReport('POSTING_JOURNAL.ERRORS.MISSING_ACCOUNTS', true, rows);
    });
}

// Ensure no accounts are locked in the transactions
function checkAccountsLocked(transactions) {
  var sql =
    `SELECT COUNT(pj.uuid) AS count, pj.trans_id
    FROM posting_journal AS pj LEFT JOIN account
      ON pj.account_id = account.id
    WHERE account.locked = 1 AND pj.trans_id IN (?)
    GROUP BY pj.trans_id;`;

  return db.exec(sql, [transactions])
    .then(function (rows) {

      // if nothing is returned, skip error report
      if (!rows.length) { return; }

      // returns a error report
      return createErrorReport('POSTING_JOURNAL.ERRORS.LOCKED_ACCOUNT', true, rows);
    });
}

// make sure the debit_equiv, credit_equiv are balanced
function checkTransactionsBalanced(transactions) {

  var sql =
    `SELECT COUNT(pj.uuid) AS count, pj.trans_id, SUM(pj.debit_equiv - pj.credit_equiv) AS balance
    FROM posting_journal AS pj
    WHERE pj.trans_id IN (?)
    GROUP BY trans_id HAVING balance <> 0;`;

  return db.exec(sql, [transactions])
    .then(function (rows) {

      // if nothing is returned, skip error report
      if (rows.length === 0) { return; }

      // returns a error report
      return createErrorReport('POSTING_JOURNAL.ERRORS.UNBALANCED_TRANSACTIONS', true, rows);
    });
}

//Check if there is no transaction with one line to avoid single line with ero in debit and credit which is valuable
function checkSingleLineTransaction (transactions){
  var sql =
    `SELECT COUNT(pj.uuid) AS count, pj.trans_id FROM posting_journal AS pj
    WHERE pj.trans_id IN (?)
    GROUP BY trans_id HAVING count = 1;`;

  return db.exec(sql, [transactions])
    .then(function (rows) {

      // if nothing is returned, skip error report
      if (rows.length === 0) { return; }

      // returns an error report
      return createErrorReport('POSTING_JOURNAL.ERRORS.SINGLE_LINE_TRANSACTION', true, rows);
    });
}

exports.getDataPerAccount = function (req, res, next) {
  var transactions = req.query.transactions;

  var requestString =
    `SELECT pt.debit_equiv, pt.credit_equiv,
      pt.account_id, pt.balance_before, account.number AS account_number
      FROM  account JOIN (
        SELECT SUM(debit_equiv) AS debit_equiv, SUM(credit_equiv) AS credit_equiv,
        posting_journal.account_id, IFNULL(SUM(period_total.debit - period_total.credit), 0) AS balance_before
        FROM posting_journal LEFT JOIN period_total
        ON posting_journal.account_id = period_total.account_id
        WHERE posting_journal.trans_id IN (?)
        GROUP BY posting_journal.account_id
        ) AS pt
      ON account.id = pt.account_id;`;

  if(!transactions){ return next(new BadRequest('The transaction list is null or undefined'));}

  db.exec(requestString, [req.query.transactions])
    .then(function (data) {
      data.forEach(function (item) {item.balance_final = item.balance_before + (item.debit_equiv - item.credit_equiv);});
      res.status(200).json(data);
    })
    .catch(function (error) {
      next(error);
    });
};

/**
 * @function checkTransactions
 * @descriptions
 * fires all check functions and return back an array of promisses containing the errors
 * here are the list of checks [type of error]:
 *
 * 1. A transaction should have at least one line [FATAL]
 * 2. A transaction must be balanced [FATAL]
 * 3. A transaction must contain unlocked account only [FATAL]
 * 4. A transaction must not miss a account [FATAL]
 * 5. A transaction must not miss a period or a fiscal year [FATAL]
 * 6. A transaction must have every date valid  [FATAL]
 * 7. A transaction must have a ID for every line [FATAL]
 * 8. A transaction must have an ID of an entity for every line which have a no null entity type [FATAL]
 * 9. A transaction should have an entity ID if not a warning must be printed, but it is not critical [WARNING]
 *
 *
 * Here is the format of error and warnings :
 *
 * exceptions : [{
 *     code : '',          // e.g 'MISSING_ACCOUNT'
 *     fatal : false,      // true for error (will block posting) and false for warning (will not block posting)
 *     transactions : ['HBB1'],   // affected transaction ids list
 *     affectedRows : 12          // number of affectedRows in the transaction
 *   }]
 **/
exports.checkTransactions = function (req, res, next) {
  var transactions =  req.body.transactions;

  if(!transactions){ return next(new BadRequest('The transaction list is null or undefined'));}

  if(!Array.isArray(transactions)){
    return next(new BadRequest('The query is bad formatted'));
  }

  return q.all([
    checkSingleLineTransaction(transactions), checkTransactionsBalanced(transactions), checkAccountsLocked(transactions),
    checkMissingAccounts(transactions), checkPeriodAndFiscalYearExists(transactions), checkDateInPeriod(transactions),
    checkRecordUuidExists(transactions), checkEntityExists(transactions), checkEntityIsAlwaysDefined(transactions),
    checkDescriptionExists(transactions)
  ])
  .then(function (errorReports){
    var errors = errorReports.filter(function (errorReport) {
      return errorReport;
    });
    res.status(201).json(errors);
  })
  .catch(function (error) {
     next(error);
  });
};

/**
 * @function postToGeneralLedger
 * @description
 * This function can be called only when there is no fatal error
 * It posts data to the general ledger.
 **/
exports.postToGeneralLedger = function (req, res, next) {
  var transaction =  db.transaction();

  var transactions = req.body.transactions;

  if(!transactions || !Array.isArray(transactions)){ return next(new BadRequest('The transaction list is null or undefined otherwise The query is bad formatted'));}

  //Just a workaround because mysql does not have a type for array
  var transactionString = transactions.map(function (trans_id) {
    return '"' + trans_id + '"';
  }).join(',');

  transaction.addQuery('CALL postToGeneralLedger(?)', [transactionString]);
  transaction.addQuery('CALL writePeriodTotals(?)', [transactionString]);
  transaction.addQuery('CALL removePostedTransactions(?)', [transactionString]);

  transaction.execute()
    .then(function () {
      res.status(201).json({});
    })
    .catch(function(err){
      next(err);
    })
    .done();
};
