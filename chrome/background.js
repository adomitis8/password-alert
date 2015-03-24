/**
 * @license
 * Copyright 2011 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Receives potential passwords from content_script.js and checks
 * to see if they're the user's password. Populates localStorage with partial
 * hashes of the user's password.
 * @author adhintz@google.com (Drew Hintz)
 */

'use strict';

goog.provide('passwordcatcher.background');

goog.require('goog.crypt');
goog.require('goog.crypt.Sha1');


/**
 * Key for localStorage to store salt value.
 * @type {string}
 * @private
 * @const
 */
passwordcatcher.background.SALT_KEY_ = 'salt';


/**
 * Number of bits of the hash to use.
 * @type {number}
 * @private
 * @const
 */
passwordcatcher.background.HASH_BITS_ = 37;


/**
 * Where password use reports are sent.
 * @type {string}
 * @private
 */
passwordcatcher.background.report_url_;


/**
 * Whether the user should be prompted to initialize their password.
 * @type {boolean}
 * @private
 */
passwordcatcher.background.shouldInitializePassword_;


/**
 * Minimum length of passwords.
 * @type {number}
 * @private
 */
passwordcatcher.background.minimum_password_ = 8;


/**
 * Maximum character typing rate to protect against abuse.
 * Calculated for 60 wpm at 5 cpm for one hour.
 * @type {number}
 * @private
 * @const
 */
passwordcatcher.background.MAX_RATE_PER_HOUR_ = 18000;


/**
 * How many passwords have been checked in the past hour.
 * @type {number}
 * @private
 */
passwordcatcher.background.rateLimitCount_ = 0;


/**
 * The time when the rateLimitCount_ will be reset.
 * @type {Date}
 * @private
 */
passwordcatcher.background.rateLimitResetDate_;


/**
 * Associative array of possible passwords. Keyed by tab id.
 * @type {Object.<number, Object.<string, string|boolean>>}
 * @private
 */
passwordcatcher.background.possiblePassword_ = {};


/**
 * Associative array of tab state. Keyed by tab id.
 * @type {Object.<number, {hash: string, time: Date}>}
 * @private
 */
passwordcatcher.background.tabState_ = {};


/**
 * Password lengths for passwords that are being watched.
 * If an array offset is true, then that password length is watched.
 * @type {Array.<boolean>}
 * @private
 */
passwordcatcher.background.passwordLengths_;


/**
 * Request from content_script. action is always defined. Other properties are
 * only defined for certain actions.
 * @typedef {{action: string, password: (string|undefined),
 *            url: (string|undefined), looksLikeGoogle: (string|undefined)}}
 * @private
 */
passwordcatcher.background.Request_;


/**
 * Namespace for chrome's managed storage.
 * @type {string}
 * @private
 * @const
 */
passwordcatcher.background.MANAGED_STORAGE_NAMESPACE_ = 'managed';


/**
 * Is password catcher used in enterprise environment.  If false, then it's
 * used by individual consumer.
 * @type {boolean}
 * @private
 */
passwordcatcher.background.isEnterpriseUse_ = false;


/**
 * The id of the chrome notification that prompts the user to initialize
 * their password.
 * @type {string}
 * @private
 * @const
 */
passwordcatcher.background.NOTIFICATION_ID_ =
    'initialize_password_notification';


/**
 * Whether the extension was newly installed.
 * @type {boolean}
 * @private
 */
passwordcatcher.background.isNewInstall_ = false;


/**
 * This sets the state of new install that can be used later.
 * @param {!Object} details Details of the onInstall event.
 * @private
 */
passwordcatcher.background.handleNewInstall_ = function(details) {
  if (details['reason'] == 'install') {
    console.log('New install detected.');
    passwordcatcher.background.isNewInstall_ = true;
  }
};


/**
 * Set the managed policy values into the configurable variables.
 * @param {function()} callback Executed after policy values have been set.
 * @private
 */
passwordcatcher.background.setManagedPolicyValuesIntoConfigurableVariables_ =
    function(callback) {
  chrome.storage.managed.get(function(managedPolicy) {
    if (Object.keys(managedPolicy).length == 0) {
      console.log('Consumer use.');
    } else {
      console.log('Enterprise use.');
      passwordcatcher.background.isEnterpriseUse_ = true;
      passwordcatcher.background.report_url_ = managedPolicy['report_url'];
      passwordcatcher.background.shouldInitializePassword_ =
          managedPolicy['should_initialize_password'];
    }
    callback();
  });
};


/**
 * Handle managed policy changes by updating the configurable variables.
 * @param {!Object} changedPolicies Object mapping each policy to its
 *     new values.  Policies that have not changed will not be present.
 *     For example:
 *     {
 *      report_url: {
 *        newValue: "https://passwordcatcher222.example.com/report/"
 *        oldValue: "https://passwordcatcher111.example.com/report/"
 *        }
 *     }
 * @param {!string} storageNamespace The name of the storage area
 *     ("sync", "local" or "managed") the changes are for.
 * @private
 */
passwordcatcher.background.handleManagedPolicyChanges_ =
    function(changedPolicies, storageNamespace) {
  if (storageNamespace ==
      passwordcatcher.background.MANAGED_STORAGE_NAMESPACE_) {
    console.log('Handling changed policies.');
    var changedPolicy;
    for (changedPolicy in changedPolicies) {
      var newPolicyValue = changedPolicies[changedPolicy]['newValue'];
      switch (changedPolicy) {
        case 'report_url':
          passwordcatcher.background.report_url_ = newPolicyValue;
          break;
        case 'should_initialize_password':
          passwordcatcher.background.shouldInitializePassword_ = newPolicyValue;
          break;
      }
    }
  }
};


/**
 * Prompts the user to initialize their password.
 * @private
 */
passwordcatcher.background.initializePassword_ = function() {
  var options = {
    type: 'basic',
    title: chrome.i18n.getMessage('extension_name'),
    message: chrome.i18n.getMessage('initialization_message'),
    iconUrl: chrome.extension.getURL('logo_password_catcher.svg'),
    buttons: [{
      title: chrome.i18n.getMessage('sign_in')
    }]
  };
  chrome.notifications.create(
      passwordcatcher.background.NOTIFICATION_ID_, options, function() {});

  chrome.notifications.onButtonClicked.addListener(
      function(notificationId, buttonIndex) {
        if (notificationId === passwordcatcher.background.NOTIFICATION_ID_) {
          chrome.tabs.create({'url':
            'https://accounts.google.com/ServiceLogin?' +
            'continue=https://www.google.com'});
        }
      });
};


/**
 * Complete page initialization.  This is executed after managed policy values
 * have been set.
 * @private
 */
passwordcatcher.background.completePageInitialization_ = function() {
  passwordcatcher.background.refreshPasswordLengths_();
  chrome.runtime.onMessage.addListener(
      passwordcatcher.background.handleRequest_);
  chrome.storage.onChanged.addListener(
      passwordcatcher.background.handleManagedPolicyChanges_);

  // The conditions to prompt the user to initialize the password are:
  // consumer: extension has been newly installed
  // enterprise: extension has been newly installed and policy allows it
  if (passwordcatcher.background.isNewInstall_ &&
      (!passwordcatcher.background.isEnterpriseUse_ ||
          (passwordcatcher.background.isEnterpriseUse_ &&
              passwordcatcher.background.shouldInitializePassword_))) {
    console.log('start initializing passowrd');
    passwordcatcher.background.initializePassword_();
  }
  console.log('Completed page initialization.');
};


/**
 * Called when the extension loads.
 * @private
 */
passwordcatcher.background.initializePage_ = function() {
  passwordcatcher.background.setManagedPolicyValuesIntoConfigurableVariables_(
      passwordcatcher.background.completePageInitialization_);
};


/**
 * Receives requests from content_script.js and calls the appropriate function.
 * @param {passwordcatcher.background.Request_} request Request message from the
 *     content_script.
 * @param {{tab: {id: number}}} sender Who sent this message.
 * @param {function(*)} sendResponse Callback with a response.
 * @private
 */
passwordcatcher.background.handleRequest_ = function(
    request, sender, sendResponse) {
  switch (request.action) {
    case 'statusRequest':
      passwordcatcher.background.pushToTab_(sender.tab.id);
      break;
    case 'looksLikeGoogle':
      passwordcatcher.background.sendReportPhishing_(request);
      break;
    case 'deletePossiblePassword':
      delete passwordcatcher.background.possiblePassword_[sender.tab.id];
      break;
    case 'setPossiblePassword':
      passwordcatcher.background.setPossiblePassword_(sender.tab.id, request);
      break;
    case 'savePossiblePassword':
      passwordcatcher.background.savePossiblePassword_(sender.tab.id);
      break;
    case 'checkPassword':
      var isCorrect = passwordcatcher.background.checkPassword_(sender.tab.id,
                                                                request, false);
      sendResponse(isCorrect);
      break;
    case 'otpAlert':
      passwordcatcher.background.checkPassword_(sender.tab.id, request, true);
      break;
    case 'clearOtpMode':
      delete passwordcatcher.background.tabState_[sender.tab.id];
      break;
  }
};


/**
 * When password entered into a login page, temporarily save it here.
 * We do not yet know if the password is correct.
 * @param {number} tabId The tab that was used to log in.
 * @param {passwordcatcher.background.Request_} request Request object
 *     containing email address and password.
 * @private
 */
passwordcatcher.background.setPossiblePassword_ = function(tabId, request) {
  console.log('Start setting possible password: ' + request);
  if (!request.email ||
      !request.password ||
      request.password.length < passwordcatcher.background.minimum_password_) {
    return;
  }
  console.log('Setting possible password: ' + request);
  passwordcatcher.background.possiblePassword_[tabId] = {
    'email': request.email,
    'password': passwordcatcher.background.hashPassword_(request.password),
    'length': request.password.length
  };
};


/**
 *
 * @param {number} index Index in to the localStorage array.
 * @return {*} The item.
 * @private
 */
passwordcatcher.background.getLocalStorageItem_ = function(index) {
  var item;
  if (localStorage.key(index) == passwordcatcher.background.SALT_KEY_) {
    item = null;
  } else {
    item = JSON.parse(localStorage[localStorage.key(index)]);
  }
  return item;
};


/**
 * The login was successful, so write the possible password to localStorage.
 * @param {number} tabId The tab that was used to log in.
 * @private
 */
passwordcatcher.background.savePossiblePassword_ = function(tabId) {
  console.log('Saving possible password.');
  var possiblePassword_ = passwordcatcher.background.possiblePassword_[tabId];
  if (!possiblePassword_) {
    console.log('No possible password.');
    return;
  }
  var email = possiblePassword_['email'];
  var password = possiblePassword_['password'];
  var length = possiblePassword_['length'];

  // Delete old email entries.
  for (var i = 0; i < localStorage.length; i++) {
    var item = passwordcatcher.background.getLocalStorageItem_(i);
    if (item && item['email'] == email) {
      delete item['email'];
      delete item['date'];
      localStorage[localStorage.key(i)] = JSON.stringify(item);
    }
  }

  // Delete any entries that now have no emails.
  var keysToDelete = [];
  for (var i = 0; i < localStorage.length; i++) {
    var item = passwordcatcher.background.getLocalStorageItem_(i);
    if (item && !('email' in item)) {
      // Delete the item later.
      // We avoid modifying localStorage while iterating over it.
      keysToDelete.push(localStorage.key(i));
    }
  }
  for (var i = 0; i < keysToDelete.length; i++) {
    localStorage.removeItem(keysToDelete[i]);
  }

  console.log('Saving password for: ' + email);
  var item;
  if (password in localStorage) {
    item = JSON.parse(localStorage[password]);
  } else {
    item = {'length': length};
  }
  item['email'] = email;
  item['date'] = new Date();

  if (passwordcatcher.background.isNewInstall_) {
    var options = {
      type: 'basic',
      title: chrome.i18n.getMessage('extension_name'),
      message: chrome.i18n.getMessage('initialization_thank_you_message'),
      iconUrl: chrome.extension.getURL('logo_password_catcher.svg')
    };
    chrome.notifications.create('thank_you_notification',
        options, function() {
          passwordcatcher.background.isNewInstall_ = false;
        });
  }

  localStorage[password] = JSON.stringify(item);
  delete passwordcatcher.background.possiblePassword_[tabId];
  passwordcatcher.background.refreshPasswordLengths_();
};


/**
 * Updates the value of passwordcatcher.background.passwordLengths_ and pushes
 * new value to all content_script tabs.
 * @private
 */
passwordcatcher.background.refreshPasswordLengths_ = function() {
  passwordcatcher.background.passwordLengths_ = [];
  for (var i = 0; i < localStorage.length; i++) {
    var item = passwordcatcher.background.getLocalStorageItem_(i);
    if (item) {
      passwordcatcher.background.passwordLengths_[item['length']] = true;
    }
  }
  passwordcatcher.background.pushToAllTabs_();
};


/**
 * If function is called too quickly, returns false.
 * @return {boolean} Whether we are below the maximum rate.
 * @private
 */
passwordcatcher.background.checkRateLimit_ = function() {
  var now = new Date();
  if (!passwordcatcher.background.rateLimitResetDate_ ||  // initialization case
      now >= passwordcatcher.background.rateLimitResetDate_) {
    // setHours() handles wrapping correctly.
    passwordcatcher.background.rateLimitResetDate_ =
        now.setHours(now.getHours() + 1);
    passwordcatcher.background.rateLimitCount_ = 0;
  }

  passwordcatcher.background.rateLimitCount_++;

  if (passwordcatcher.background.rateLimitCount_ <=
      passwordcatcher.background.MAX_RATE_PER_HOUR_) {
    return true;
  } else {
    return false;  // rate exceeded
  }
};


/**
 * Determines if a password has been typed and if so creates alert. Also used
 * for sending OTP alerts.
 * @param {number} tabId The tab that sent this message.
 * @param {passwordcatcher.background.Request_} request Request object from
 *     content_script.
 * @param {boolean} otp If this is for an OTP alert.
 * @return {boolean} If password is a match.
 * @private
 */
passwordcatcher.background.checkPassword_ = function(tabId, request, otp) {
  if (!passwordcatcher.background.checkRateLimit_()) {
    return false;  // This limits content_script brute-forcing the password.
  }

  if (otp) {
    var hash = passwordcatcher.background.tabState_[tabId].hash;
  } else if (request.password) {
    var hash = passwordcatcher.background.hashPassword_(request.password);
  } else {
    return false; // Should never happen.
  }

  if (localStorage[hash]) {
    var date = new Date();
    var formattedTime = date.getHours() + ':' + date.getMinutes() + ':' +
        date.getSeconds();
    console.log('PASSWORD and/or OTP TYPED! ' + formattedTime + '\n' +
        request.url);
    passwordcatcher.background.tabState_[tabId] = {hash: hash,
      time: new Date()};

    if (passwordcatcher.background.isEnterpriseUse_) {
      chrome.identity.getAuthToken({'interactive': false},
          function(oauthToken) {
            console.log('Successfully retrieved oauth token.');
            var item = JSON.parse(localStorage[hash]);
            passwordcatcher.background.sendReport_(
            request, item['email'], item['date'], otp, oauthToken);
          });
    }
    return true;
  }
  return false;
};


/**
 * Sends a password typed alert to the server.
 * @param {passwordcatcher.background.Request_} request Request object from
 *     content_script. Contains url and referer.
 * @param {string} email The email to report.
 * @param {string} date The date when the correct password hash was saved.
 *                      It is a string from JavaScript's Date().
 * @param {boolean} otp True if this is for an OTP alert.
 * @param {string} oauthToken The user's oauth token from chrome.identity.
 * @private
 */
passwordcatcher.background.sendReport_ = function(request, email, date, otp,
                                                  oauthToken) {
  console.log('Sending password typed alert to the server.');
  var xhr = new XMLHttpRequest();
  xhr.open('POST', passwordcatcher.background.report_url_ + 'password/', true);
  xhr.onreadystatechange = function() {};
  xhr.setRequestHeader('X-Same-Domain', 'true');
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  var data = (
      'email=' + encodeURIComponent(email) +
      // password_date is in seconds. Date.parse() returns milliseconds.
      '&password_date=' + Math.floor(Date.parse(date) / 1000) +
      '&referer=' + encodeURIComponent(request.referer || '') +
      '&url=' + encodeURIComponent(request.url || '') +
      '&oauth_token=' + encodeURIComponent(oauthToken));
  if (otp) {
    data += '&otp=true';
  }
  if (request.looksLikeGoogle) {
    data += '&looksLikeGoogle=true';
  }
  xhr.send(data);
};


/**
 * Sends a phishing page alert to the server.
 * @param {passwordcatcher.background.Request_} request Request object from
 *     content_script. Contains url and referer.
 * @private
 */
passwordcatcher.background.sendReportPhishing_ = function(request) {
  console.log('Sending phishing page alert to the server.');
  var xhr = new XMLHttpRequest();
  xhr.open('POST', passwordcatcher.background.report_url_ + 'page/', true);
  xhr.onreadystatechange = function() {};
  xhr.setRequestHeader('X-Same-Domain', 'true');
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  var data = (
      'referer=' + encodeURIComponent(request.referer || '') +
      '&url=' + encodeURIComponent(request.url || '') +
      '&version=' + chrome.runtime.getManifest().version +
      '&email=' + encodeURIComponent(passwordcatcher.background.guessUser_())
      );
  xhr.send(data);
};


/**
 * Guesses the email address for the current user.
 * @return {string} email address for this user. '' if none found.
 * @private
 */
passwordcatcher.background.guessUser_ = function() {
  for (var i = 0; i < localStorage.length; i++) {
    var item = passwordcatcher.background.getLocalStorageItem_(i);
    if (item && item['email']) {
      return item['email'];
    }
  }
  return '';
};


/**
 * Calculates salted, partial hash of the password.
 * Throws an error if none is passed in.
 * @param {string} password The password to hash.
 * @return {string} Hash as a string of hex characters.
 * @private
 */
passwordcatcher.background.hashPassword_ = function(password) {
  var sha1 = new goog.crypt.Sha1();
  sha1.update(passwordcatcher.background.getHashSalt_());
  sha1.update(goog.crypt.stringToUtf8ByteArray(password));
  var hash = sha1.digest();

  // Only keep HASH_BITS_ number of bits of the hash.
  var bits = passwordcatcher.background.HASH_BITS_;
  for (var i = 0; i < hash.length; i++) {
    if (bits >= 8) {
      bits -= 8;
    } else if (bits == 0) {
      hash[i] = 0;
    } else { // 1 to 7 bits
      var mask = 0xffffff00; // Used to shift in 1s into the low byte.
      mask = mask >> bits;
      hash[i] = hash[i] & mask; // hash[i] is only 8 bits.
      bits = 0;
    }
  }

  // Do not return zeros at the end that were bit-masked out.
  return goog.crypt.byteArrayToHex(hash).substr(0,
      Math.ceil(passwordcatcher.background.HASH_BITS_ / 4));
};


/**
 * Generates and saves a salt if needed.
 * @return {string} Salt for the hash.
 * @private
 */
passwordcatcher.background.getHashSalt_ = function() {
  if (!(passwordcatcher.background.SALT_KEY_ in localStorage)) {
    // Generate a salt and save it.
    var salt = new Uint32Array(1);
    window.crypto.getRandomValues(salt);
    localStorage[passwordcatcher.background.SALT_KEY_] = salt[0].toString();
  }

  return localStorage[passwordcatcher.background.SALT_KEY_];
};


/**
 * Posts status message to all tabs.
 * @private
 */
passwordcatcher.background.pushToAllTabs_ = function() {
  chrome.tabs.query({}, function(tabs) {
    for (var i = 0; i < tabs.length; i++) {
      passwordcatcher.background.pushToTab_(tabs[i].id);
    }
  });
};


/**
 * Sends a message with the tab's state to the content_script on a tab.
 * @param {number} tabId Tab to receive the message.
 * @private
 */
passwordcatcher.background.pushToTab_ = function(tabId) {
  var otpMode = Boolean(passwordcatcher.background.tabState_[tabId]);
  var otpTime;
  if (otpMode) {
    otpTime = passwordcatcher.background.tabState_[tabId].time;
  }
  var state = {
    passwordLengths: passwordcatcher.background.passwordLengths_,
    otpMode: otpMode,
    otpTime: otpTime
  };
  chrome.tabs.sendMessage(tabId, JSON.stringify(state));
};


// Set this early, or else the install event will not be picked up.
chrome.runtime.onInstalled.addListener(
    passwordcatcher.background.handleNewInstall_);

passwordcatcher.background.initializePage_();
