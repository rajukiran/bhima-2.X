/* global element, by, browser */

const chai = require('chai');

const helpers = require('../shared/helpers');
helpers.configure(chai);

const JournalCorePage = require('./journal.page.js');
const JournalConfiguration = require('./journal.config.js');
const TrialBalanceTest = require('./trial_balance/trialBalance.config.js');

describe('Posting Journal Core', function () {
  'use strict';

  const path = '#/journal';
  const initialTransactionRows = 14;
  const journal = new JournalCorePage();

  // this will be run before every single test ('it') - navigating the browser
  // to the correct page.
  before(() => helpers.navigate(path));

  it('loads initial transactions from the database', function () {
    journal.expectRowCountAbove(initialTransactionRows);
  });

  describe('Configuration Modal', JournalConfiguration);
  describe('Trial balance Process', TrialBalanceTest);
});
