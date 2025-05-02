require('dotenv').config();
const express = require('express');
const axios = require('axios');
const SFTPClient = require('ssh2-sftp-client');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { format, addMonths, addYears, parseISO } = require('date-fns');

const app = express();
app.use(bodyParser.json());

// SFTP configuration
const sftpConfig = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT || 22,
  username: process.env.SFTP_USER,
  password: process.env.SFTP_PASS,
};

const sftp = new SFTPClient();

// Path for persistent subscription store
const subscriptionsFilePath = path.join(__dirname, 'subscriptions.json');
// In-memory subscriptions store (keyed by customerEmail)
let subscriptionsStore = {};

/**
 * Load subscriptions from persistent store (JSON file).
 */
function loadSubscriptions() {
  if (fs.existsSync(subscriptionsFilePath)) {
    const data = fs.readFileSync(subscriptionsFilePath, 'utf8');
    try {
      subscriptionsStore = JSON.parse(data);
      console.log("Loaded subscriptions from disk.");
    } catch (err) {
      console.error("Error parsing subscriptions file:", err);
      subscriptionsStore = {};
    }
  } else {
    subscriptionsStore = {};
  }
}

/**
 * Save the current subscriptions store to disk.
 */
function saveSubscriptions() {
  fs.writeFileSync(subscriptionsFilePath, JSON.stringify(subscriptionsStore, null, 2), 'utf8');
  console.log("Subscriptions saved to disk.");
}

// Load subscriptions on startup.
loadSubscriptions();

/**
 * Calculate the next due date based on lastPaymentDate and plan.
 * Assumes ISO string for lastPaymentDate.
 */
function computeNextDueDate(lastPaymentDate, subscriptionPlan) {
  const dateObj = parseISO(lastPaymentDate);
  if (subscriptionPlan === 'Monthly') {
    return addMonths(dateObj, 1);
  } else if (subscriptionPlan === 'Annual') {
    return addYears(dateObj, 1);
  }
  return dateObj;
}

/**
 * Determine if a subscription is active.
 * Active if the current date is before the nextDueDate.
 */
function isActiveSubscription(subscriptionRecord) {
  const now = new Date();
  // Convert "YYYYMMDD" to "YYYY-MM-DD" so that new Date can parse it reliably
  const nd = subscriptionRecord.nextDueDate;
  const isoDate = nd.substring(0, 4) + '-' + nd.substring(4, 6) + '-' + nd.substring(6, 8);
  const nextDue = new Date(isoDate);
  return now < nextDue;
}

/**
 * Update (or create) a subscription record from order details.
 * This function extracts the most recent payment data and additional fields.s
 */
function updateSubscriptionRecord(orderDetails) {
  const email = orderDetails.customerEmail;
  const billing = orderDetails.billingAddress || {};

  // … your existing plan / date logic …

  // ——— NEW: pull DOB from the “Date of Birth” customization ———
  let dateOfBirth = '';
  const subscriptionItem = items.find(item => item.lineItemType === "PAYWALL_PRODUCT");
    const dobField = subscriptionItem.customizations?.find(c =>
      c.label.toLowerCase().includes('date of birth')
    );
   if (dobField && dobField.value) {
      // input looks like "1/10/1982"
     const parsed = parse(dobField.value, 'M/d/yyyy', new Date());
     dateOfBirth = format(parsed, 'yyyy-MM-dd');
    }

  // — now stash everything into your store object —
  subscriptionsStore[email] = {
    title:           '',
    firstName:       billing.firstName  || '',
    middleName:      '',
    lastName:        billing.lastName   || '',
    postName:        '',
    uniqueId:        orderDetails.id,
    sequenceNum:     '00',
    filler:          '',
    address1:        billing.address1   || '',
    address2:        billing.address2   || '',
    city:            billing.city       || '',
    state:           billing.state      || '',
    zip:             billing.postalCode || '',
    plus4:           '',
    homePhone:       billing.phone      || '',
    workPhone:       '',
    coverage:        'MO',
    groupCode:       process.env.CAREINGTON_GROUP_CODE,
    terminationDate: '',
    effectiveDate:   effectiveDateIso,   // YYYY-MM-DD
    dateOfBirth,                        // <— with our new parsed DOB
    relation:        '',
    studentStatus:   '',
    filler2:         '',
    gender:          '',
    email,                               // customerEmail

    // extras...
    lastPaymentDate,
    paymentAmount,
    subscriptionPlan,
    nextDueDate,
    orderId: orderDetails.id,
    productName: subscriptionItem.productName
  };

  console.log(`Updated subscription record for ${email}`);
  saveSubscriptions();
}

/**
 * Remove a subscription record based on order cancellation.
 */
function removeSubscriptionRecord(orderDetails) {
  const email = orderDetails.customerEmail;
  if (subscriptionsStore[email]) {
    delete subscriptionsStore[email];
    console.log(`Removed subscription record for ${email}`);
    saveSubscriptions();
  }
}

/**
 * Upload subscription SDF file to SFTP.
 * Here, the file is generated in ASCII fixed‑width format.
 */
async function uploadSubscriptionSDF(filePath) {
  try {
    await sftp.connect(sftpConfig);
    // For example, place the file in /subscriptions on SFTP.
    const remoteFilePath = `${path.basename(filePath)}`;
    await sftp.put(filePath, remoteFilePath);
    console.log(`Uploaded subscription SDF file: ${remoteFilePath}`);
    await sftp.end();
  } catch (err) {
    console.error("SFTP Upload Error:", err);
  }
}

/**
 * Generate an ASCII SDF file (fixed field lengths) from active subscriptions.
 * Field layout (all fields are fixed width):
 *   Customer Email:     50 chars (left-justified)
 *   Subscription Plan:  10 chars (left-justified)
 *   Last Payment Date:   8 chars (YYYYMMDD)
 *   Next Due Date:       8 chars (YYYYMMDD)
 *   Payment Amount:      8 chars (right-justified, padded with spaces)
 *   First Name:         20 chars (left-justified)
 *   Last Name:          20 chars (left-justified)
 *   Order ID:           24 chars (left-justified)
 */
function generateSubscriptionSDF(subscriptions) {
  const lines = [];
  // Header (optional – if you need a header record, you can add one)
  // Iterate over active subscriptions only.
  Object.values(subscriptions).forEach(record => {
    if (isActiveSubscription(record)) {
      const email = record.customerEmail.padEnd(50, ' ');
      const plan = record.subscriptionPlan.padEnd(10, ' ');
      const lastPay = record.lastPaymentDate; // already 8 chars
      const nextDue = record.nextDueDate;     // already 8 chars
      // Payment amount: right-justify within 8 chars. Assume fixed two decimals.
      const amount = record.paymentAmount.padStart(8, ' ');
      const fName = record.firstName.padEnd(20, ' ');
      const lName = record.lastName.padEnd(20, ' ');
      const orderId = record.orderId.padEnd(24, ' ');
      const line = email + plan + lastPay + nextDue + amount + fName + lName + orderId;
      lines.push(line);
    }
  });
  // Define file name based on a group code (for example, use an env variable or a constant)
  const groupCode = process.env.SHAREINGTON_GROUP_CODE || 'SHAREING';
  const datePart = format(new Date(), 'MMddyy');
  const fileName = `${groupCode}${datePart}_full.txt`;
  const outputFilePath = path.join(__dirname, fileName);
  fs.writeFileSync(outputFilePath, lines.join('\n'), 'utf8');
  console.log(`Subscription SDF file created: ${outputFilePath}`);
  return outputFilePath;
}

/* ========= Existing functions for OAuth, token refresh, webhook management, etc. ========= */

// (The unchanged functions for OAuth, token refresh, webhook creation, etc. remain as in your original code.)

async function uploadSubscriptionData(userData, fileName) {
  try {
    await sftp.connect(sftpConfig);
    const filePath = `${fileName}.json`;
    await sftp.put(Buffer.from(JSON.stringify(userData, null, 2)), filePath);
    console.log(`Uploaded subscription data for ${userData.username}`);
    await sftp.end();
  } catch (err) {
    console.error("SFTP Upload Error:", err);
  }
}

async function deleteSubscriptionFile(fileName) {
  try {
    await sftp.connect(sftpConfig);
    const filePath = `${fileName}.json`;
    await sftp.delete(filePath);
    console.log(`Deleted subscription file for ${fileName}`);
    await sftp.end();
  } catch (err) {
    console.error("SFTP Deletion Error:", err);
  }
}

function updateEnvFile(newAccessToken, newRefreshToken) {
  const envPath = path.join(__dirname, '.env');
  let envContents = fs.readFileSync(envPath, 'utf8');

  envContents = envContents.replace(/^ACCESS_TOKEN=.*/m, `ACCESS_TOKEN=${newAccessToken}`);
  if (newRefreshToken) {
    if (/^REFRESH_TOKEN=.*/m.test(envContents)) {
      envContents = envContents.replace(/^REFRESH_TOKEN=.*/m, `REFRESH_TOKEN=${newRefreshToken}`);
    } else {
      envContents += `\nREFRESH_TOKEN=${newRefreshToken}\n`;
    }
  }
  fs.writeFileSync(envPath, envContents);
  console.log("Updated .env file with new tokens.");

  process.env.ACCESS_TOKEN = newAccessToken;
  if (newRefreshToken) process.env.REFRESH_TOKEN = newRefreshToken;
}

async function refreshAccessToken() {
  try {
    console.log("Refreshing access token...");
    const credentials = `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`;
    const encodedCredentials = Buffer.from(credentials).toString('base64');
    
    const response = await axios.post(
      'https://login.squarespace.com/api/1/login/oauth/provider/tokens',
      {
        grant_type: 'refresh_token',
        refresh_token: process.env.REFRESH_TOKEN
      },
      {
        headers: {
          'Authorization': `Basic ${encodedCredentials}`,
          'Content-Type': 'application/json',
          'User-Agent': process.env.USER_AGENT
        }
      }
    );
    
    const newAccessToken = response.data.access_token;
    const newRefreshToken = response.data.refresh_token;
    console.log('New Access Token:', newAccessToken);

    updateEnvFile(newAccessToken, newRefreshToken);
    console.log("Access token refreshed successfully.");
  } catch (error) {
    console.error("Error refreshing access token:", error.response ? error.response.data : error.message);
  }
}
setInterval(refreshAccessToken, 25 * 60 * 1000);

async function checkAndSetupWebhooks() {
  try {
    const response = await axios.get('https://api.squarespace.com/1.0/webhook_subscriptions', {
      headers: {
        'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`,
        'User-Agent': process.env.USER_AGENT
      }
    });
    const subscriptions = response.data.webhookSubscriptions || response.data.result || [];
    const topics = subscriptions.reduce((acc, sub) => {
      if (sub.topics && Array.isArray(sub.topics)) {
        return acc.concat(sub.topics);
      }
      return acc;
    }, []);
    if (!topics.includes('order.create')) {
      await createWebhook('order.create');
    }
    if (!topics.includes('order.update')) {
      await createWebhook('order.update');
    }
    console.log("Webhook check complete.");
  } catch (error) {
    console.error("Error checking webhooks:", error.response ? error.response.data : error.message);
  }
}
checkAndSetupWebhooks();
setInterval(checkAndSetupWebhooks, 30 * 60 * 1000);

app.get('/oauth/login', (req, res) => {
  const authUrl = `https://login.squarespace.com/api/1/login/oauth/provider/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&scope=website.orders,website.inventory&state=${process.env.STATE}`;
  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const authCode = req.query.code;
  const state = req.query.state;
  
  if (state !== process.env.STATE) {
    return res.status(400).send('Invalid state parameter.');
  }
  if (!authCode) {
    return res.status(400).send('Authorization code is missing.');
  }

  try {
    const credentials = `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`;
    const encodedCredentials = Buffer.from(credentials).toString('base64');
    
    const response = await axios.post(
      'https://login.squarespace.com/api/1/login/oauth/provider/tokens',
      {
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: process.env.REDIRECT_URI
      },
      {
        headers: {
          'Authorization': `Basic ${encodedCredentials}`,
          'Content-Type': 'application/json',
          'User-Agent': process.env.USER_AGENT
        }
      }
    );
    
    const accessToken = response.data.access_token;
    const refreshToken = response.data.refresh_token;
    console.log('Access Token:', accessToken);

    updateEnvFile(accessToken, refreshToken);
    res.send('OAuth successful! Access token updated.');
  } catch (error) {
    console.error('OAuth Error:', error.response ? error.response.data : error.message);
    res.status(500).send('OAuth failed.');
  }
});

async function createWebhook(eventType) {
  try {
    const response = await axios.post(
      'https://api.squarespace.com/1.0/webhook_subscriptions',
      {
        endpointUrl: 'https://services.patriotfrontline.com/webhook/squarespace',
        topics: [eventType]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': process.env.USER_AGENT
        }
      }
    );
    console.log(`Webhook for ${eventType} created:`, response.data);
  } catch (err) {
    console.error(`Error creating webhook for ${eventType}:`, err.response ? err.response.data : err.message);
  }
}

app.get('/setup-webhooks', async (req, res) => {
  await createWebhook('order.create');
  await createWebhook('order.update');
  res.send('Webhooks registered.');
});

app.get('/list-webhooks', async (req, res) => {
  try {
    const response = await axios.get('https://api.squarespace.com/1.0/webhook_subscriptions', {
      headers: {
        'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`,
        'User-Agent': process.env.USER_AGENT
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Error listing webhook subscriptions:", error.response ? error.response.data : error.message);
    res.status(500).send('Error retrieving webhook subscriptions.');
  }
});

app.get('/delete-webhook/:id', async (req, res) => {
  try {
    await axios.delete(`https://api.squarespace.com/1.0/webhook_subscriptions/${req.params.id}`, {
      headers: { 
        'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`,
        'User-Agent': process.env.USER_AGENT
      }
    });
    res.send('Webhook deleted.');
  } catch (error) {
    res.status(500).send('Error deleting webhook.');
  }
});

/**
 * Helper: Retrieve order details using API_KEY.
 * Uses a narrow date window based on createdOn.
 * Now prints out the search parameters and the results found.
 */
async function getOrderDetailsByOrderId(orderId) {
  try {
    const url = `https://api.squarespace.com/1.0/commerce/orders/${orderId}`;
    console.log(`GET ${url}`);
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${process.env.API_KEY}`,
        'User-Agent': process.env.USER_AGENT
      }
    });
    if (response.data) {
      console.log("Order details retrieved:", response.data);
      return response.data;
    }
    return null;
  } catch (error) {
    console.error("Error retrieving order details:", error.response ? error.response.data : error.message);
    return null;
  }
}


/**
 * Helper: Retrieve a random order from the orders endpoint.
 */
async function getRandomOrder() {
  try {
    const url = `https://api.squarespace.com/1.0/commerce/orders`;
    console.log("Fetching all orders for random selection from:", url);
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${process.env.API_KEY}`,
        'User-Agent': process.env.USER_AGENT
      }
    });
    if (response.data && Array.isArray(response.data.result)) {
      const orders = response.data.result;
      if (orders.length > 0) {
        const randomIndex = Math.floor(Math.random() * orders.length);
        const randomOrder = orders[randomIndex];
        console.log("Random order selected:", randomOrder.id);
        return randomOrder;
      }
    }
    console.error("No orders found for random selection.");
    return null;
  } catch (error) {
    console.error("Error retrieving random order:", error.response ? error.response.data : error.message);
    return null;
  }
}

/**
 * Updated webhook endpoint.
 * For order.create or order.update (FULFILLED), update the subscription record.
 * For cancellation events, remove the subscription record.
 * Also, if a test webhook is received with "test-order-id", a random order is chosen.
 */
app.post('/webhook/squarespace', async (req, res) => {
  console.log("Raw POST data:", JSON.stringify(req.body, null, 2));
  const { topic, data, createdOn } = req.body;
  if (!data || !data.orderId) return res.status(400).send('Invalid webhook');

  let orderId = data.orderId;

  // test mode → random order
  if (orderId === 'test-order-id') {
    const randomOrder = await getRandomOrder();
    if (!randomOrder) return res.status(404).send("No orders for test");
    orderId = randomOrder.id;
  }

  // fetch full order by API_KEY
  const orderDetails = await getOrderDetailsByOrderId(orderId);
  if (!orderDetails) return res.status(404).send('Order not found');

  // only care about create/fulfill vs cancel
  if (
    topic === 'order.create' ||
   (topic === 'order.update' && data.update === 'FULFILLED')
  ) {
    updateSubscriptionRecord(orderDetails);

  } else if (topic === 'order.update' && data.update === 'CANCELED') {
    removeSubscriptionRecord(orderDetails);

  } else {
    return res.status(200).send('No action for this event');
  }

  // rebuild & push **eligibility** file (pipe‑delimited per CI007)
  const membersArray = Object.values(subscriptionsStore);
  const filePath = generateEligibilityFile(
    membersArray,
    process.env.CAREINGTON_GROUP_CODE,
    true
  );
  await uploadEligibilityFile(filePath);

  res.status(200).send('Eligibility file updated');
});

/* ========= Daily Scheduled Job to Re-Generate SDF File ========= */

// This job runs once a day to recalc active subscriptions and generate/upload the SDF file.
setInterval(() => {
  console.log("Running daily subscription status check and SDF file generation...");
  // (Optional: Here you could re-validate each subscription’s active status if needed)
  const sdfFilePath = generateSubscriptionSDF(subscriptionsStore);
  uploadSubscriptionSDF(sdfFilePath);
}, 24 * 60 * 60 * 1000); // Every 24 hours

/* ========= Existing Eligibility File Generation Functions (unchanged) ========= */

function formatDateMMDDYYYY(dateObj) {
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  const yyyy = dateObj.getFullYear();
  return `${mm}${dd}${yyyy}`;
}

function toCareingtonEffectiveDate(dateString) {
  const dateObj = dateString ? new Date(dateString) : new Date();
  const year = dateObj.getFullYear();
  const month = dateObj.getMonth();
  const day = dateObj.getDate();
  if (day <= 15) return new Date(year, month, 1);
  return month === 11 ? new Date(year + 1, 0, 1) : new Date(year, month + 1, 1);
}

function buildMemberLine(member) {
  const formatMMDDYYYY = d => {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return mm + dd + yyyy;
  };

  // Careington wants effective date = 1st of month (with mid-month logic)
  const toCareingtonEffectiveDate = dateString => {
    const d = dateString ? new Date(dateString) : new Date();
    const day = d.getDate(), m = d.getMonth(), y = d.getFullYear();
    if (day <= 15) return new Date(y, m, 1);
    return m === 11 ? new Date(y + 1, 0, 1) : new Date(y, m + 1, 1);
  };

  const effDate = formatMMDDYYYY(toCareingtonEffectiveDate(member.effectiveDate));
  const dob     = member.dateOfBirth
                ? formatMMDDYYYY(new Date(member.dateOfBirth))
                : '';
  const term    = member.terminationDate || '';

  const fields = [
    member.title        || '', // Title (3)
    member.firstName    || '', // First Name (15)
    member.middleName   || '', // Middle Initial (1)
    member.lastName     || '', // Last Name (20)
    member.postName     || '', // Post Name (4)
    member.uniqueId     || '', // Unique ID (12)
    member.sequenceNum  || '', // Sequence Number (2)
    member.filler       || '', // Filler (9)
    member.address1     || '', // Address Line 1 (33)
    member.address2     || '', // Address Line 2 (33)
    member.city         || '', // City (21)
    member.state        || '', // State (2)
    member.zip          || '', // Zip (5)
    member.plus4        || '', // Plus 4 (4)
    member.homePhone    || '', // Home Phone (10)
    member.workPhone    || '', // Work Phone (10)
    member.coverage     || '', // Coverage (2)
    member.groupCode    || '', // Group Code (10)
    term,                       // Termination Date (8)
    effDate,                    // Effective Date (8)
    dob,                        // Date of Birth (8)
    member.relation     || '', // Relation (1)
    member.studentStatus|| '', // Student Status (1)
    member.filler2      || '', // Filler (4)
    member.gender       || '', // Gender (1)
    member.email        || ''  // Email (64)
  ];

  // this will produce exactly N pipes and no padding
  return fields.join('|');
}


function generateEligibilityFile(members, parentGroupCode, isFull = true) {
  const today    = new Date();
  const mmddyy   = formatDateMMDDYYYY(today).slice(0,6); // "MMDDYY"
  const suffix   = isFull ? 'full' : 'delta';
  const ext      = '.txt';  // or ".csv"
  const fileName = `${parentGroupCode}${mmddyy}_${suffix}${ext}`;
  const filePath = path.join(__dirname, fileName);

  const lines = members.map(buildMemberLine);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

  console.log(`Eligibility file created: ${filePath}`);
  return filePath;
}

async function uploadEligibilityFile(localFilePath) {
  const remote = `${path.basename(localFilePath)}`;
  await sftp.connect(sftpConfig);
  await sftp.put(localFilePath, remote);
  console.log(`Uploaded eligibility file to: ${remote}`);
  await sftp.end();
}

app.get('/test-generate-file', async (req, res) => {
  const testMember = {
    title: 'Mr',
    firstName: 'Test',
    lastName: 'User',
    uniqueId: 'test-order-id',
    sequenceNum: '00',
    address1: '123 Test St',
    address2: '',
    city: 'Testville',
    state: 'TS',
    zip: '12345',
    phone: '5551234567',
    dob: '1990-01-01',
    gender: 'M',
    email: 'test.user@example.com',
    effectiveDate: '2025-03-18',
    groupCode: 'TESTGRP',
    coverageType: 'MEMBER'
  };
  
  const testMembers = [testMember];
  const filePath = generateEligibilityFile(testMembers, 'TESTGRP', true);
  // Optionally, uncomment the following line to upload the file to SFTP:
await uploadEligibilityFile(filePath);
  res.send(`Test eligibility file generated at: ${filePath}`);
});

// Start Express server
const PORT = process.env.PORT || 3050;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
