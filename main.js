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
  
  // Use whichever key exists: "salesLineItems" or "lineItems"
  const items = orderDetails.salesLineItems || orderDetails.lineItems;
  if (!items || items.length === 0) {
    console.log(`No subscription items for order ${orderDetails.id}. Skipping subscription update.`);
    return;
  }
  
  // Find the subscription line item (assuming lineItemType "PAYWALL_PRODUCT" indicates a subscription)
  const subscriptionItem = items.find(item => item.lineItemType === "PAYWALL_PRODUCT");
  if (!subscriptionItem) {
    console.log(`No subscription sales line item for order ${orderDetails.id}. Skipping subscription update.`);
    return;
  }
  
  // Extract the subscription amount from unitPricePaid.
  const paymentAmount = subscriptionItem.unitPricePaid.value;
  let subscriptionPlan = '';
  if (paymentAmount === '19.99') {
    subscriptionPlan = 'Monthly';
  } else if (paymentAmount === '159.00') {
    subscriptionPlan = 'Annual';
  } else {
    console.log(`Payment amount ${paymentAmount} not recognized for subscription.`);
    return;
  }
  
  // Use the order's fulfilledOn date if available, otherwise fall back to createdOn.
  const paymentDate = orderDetails.fulfilledOn || orderDetails.createdOn;
  const lastPaymentDate = format(parseISO(paymentDate), 'yyyyMMdd');
  
  // Compute the next due date based on the paymentDate.
  const nextDueDateObj = computeNextDueDate(paymentDate, subscriptionPlan);
  const nextDueDate = format(nextDueDateObj, 'yyyyMMdd');
  
  // Pull additional data from billingAddress.
  const billing = orderDetails.billingAddress || {};
  const firstName = billing.firstName || '';
  const lastName = billing.lastName || '';
  
  // Also capture the product name for confirmation.
  const productName = subscriptionItem.productName;
  
  // Create or update the subscription record.
  subscriptionsStore[email] = {
    customerEmail: email,
    lastPaymentDate,      // in YYYYMMDD format
    paymentAmount,
    subscriptionPlan,
    nextDueDate,          // in YYYYMMDD format
    orderId: orderDetails.id,
    firstName,
    lastName,
    productName           // new field for clarity
  };
  
  console.log(`Updated subscription record for ${email}: ${JSON.stringify(subscriptionsStore[email])}`);
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
    const remoteFilePath = `/subscriptions/${path.basename(filePath)}`;
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
    const filePath = `/subscriptions/${fileName}.json`;
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
    const filePath = `/subscriptions/${fileName}.json`;
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
  console.log("Raw POST data received:", JSON.stringify(req.body, null, 2));
  const event = req.body;
  if (!event || !event.data) {
    return res.status(400).send('Invalid webhook data');
  }
  
  let orderId = event.data.orderId;
  let createdOn = event.createdOn;
  const topic = event.topic;
  
  if (!orderId || !createdOn) {
    return res.status(400).send('Missing orderId or createdOn in webhook data');
  }
  
  // If the webhook is a test (orderId === "test-order-id"), select a random order.
  if (orderId === 'test-order-id') {
    const randomOrder = await getRandomOrder();
    if (randomOrder) {
      orderId = randomOrder.id;
      createdOn = randomOrder.createdOn;
      console.log(`Test webhook detected. Overriding with random order id: ${orderId}`);
    } else {
      return res.status(404).send("No orders available for test webhook.");
    }
  }
  
  // Retrieve order details using API_KEY.
  const orderDetails = await getOrderDetailsByOrderId(orderId);
  if (!orderDetails) {
    console.error(`Order with id ${orderId} not found.`);
    return res.status(404).send('Order not found');
  }
  
  // For creation or update to FULFILLED, update the subscription record.
  if (topic === 'order.create' || (topic === 'order.update' && event.data.update === 'FULFILLED')) {
    updateSubscriptionRecord(orderDetails);
    // (Optional: Continue to upload individual JSON if needed)
    await uploadSubscriptionData({ username: orderDetails.customerEmail }, orderDetails.id);
    res.status(200).send('Order processed and subscription record updated.');
  } else if (topic === 'order.update' && event.data.update === 'CANCELED') {
    removeSubscriptionRecord(orderDetails);
    await deleteSubscriptionFile(orderDetails.id);
    res.status(200).send('Order processed and subscription record removed.');
  } else {
    res.status(200).send('Webhook processed with no action.');
  }
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
  return (day <= 15) ? new Date(year, month, 1) : (month === 11 ? new Date(year + 1, 0, 1) : new Date(year, month + 1, 1));
}

function buildMemberLine(member) {
  const effectiveDateObj = toCareingtonEffectiveDate(member.effectiveDate);
  const effectiveDateStr = formatDateMMDDYYYY(effectiveDateObj);
  let dobStr = '';
  if (member.dob) {
    dobStr = formatDateMMDDYYYY(new Date(member.dob));
  }
  
  const fields = [
    member.title || '',
    member.firstName || '',
    member.lastName || '',
    member.uniqueId || '',
    member.sequenceNum || '',
    member.address1 || '',
    member.address2 || '',
    member.city || '',
    member.state || '',
    member.zip || '',
    member.phone || '',
    dobStr,
    member.gender || '',
    member.email || '',
    effectiveDateStr,
    member.groupCode || '',
    member.coverageType || ''
  ];
  
  return fields.join('|');
}

function generateEligibilityFile(membersArray, parentGroupCode, isFull = true) {
  const datePart = formatDateMMDDYYYY(new Date());
  const suffix = isFull ? 'full' : 'delta';
  const fileName = `${parentGroupCode}${datePart}_${suffix}.csv`;
  const lines = membersArray.map(buildMemberLine);
  const outputFilePath = path.join(__dirname, fileName);
  fs.writeFileSync(outputFilePath, lines.join('\n'), 'utf8');
  console.log(`Eligibility file created: ${outputFilePath}`);
  return outputFilePath;
}

async function uploadEligibilityFile(localFilePath) {
  const remoteFileName = path.basename(localFilePath);
  const remoteFilePath = `/eligibility/${remoteFileName}`;
  try {
    await sftp.connect(sftpConfig);
    await sftp.put(localFilePath, remoteFilePath);
    console.log(`Eligibility file uploaded to: ${remoteFilePath}`);
    await sftp.end();
  } catch (err) {
    console.error("SFTP Upload Error:", err);
  }
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
  // await uploadEligibilityFile(filePath);
  res.send(`Test eligibility file generated at: ${filePath}`);
});

// Start Express server
const PORT = process.env.PORT || 3050;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
