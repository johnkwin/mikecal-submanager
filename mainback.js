require('dotenv').config();
const express = require('express');
const axios = require('axios');
const SFTPClient = require('ssh2-sftp-client');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { format } = require('date-fns'); // For improved date formatting if desired

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

/**
 * Upload subscription data as JSON to SFTP.
 */
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

/**
 * Delete a subscription file from SFTP.
 */
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

/**
 * Update the .env file with new token values and update process.env.
 */
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

/**
 * Automatically refresh the access token using the refresh token.
 */
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

// Schedule token refresh every 25 minutes (access tokens are valid for 30 minutes)
setInterval(refreshAccessToken, 25 * 60 * 1000);

/**
 * Check and (re)create webhooks if needed.
 */
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

/**
 * OAuth Step 1: Redirect user to SquareSpace for authentication.
 */
app.get('/oauth/login', (req, res) => {
  const authUrl = `https://login.squarespace.com/api/1/login/oauth/provider/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&scope=website.orders,website.inventory&state=${process.env.STATE}`;
  res.redirect(authUrl);
});

/**
 * OAuth Step 2: Handle OAuth callback.
 */
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

/**
 * Create a SquareSpace webhook subscription.
 */
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

/**
 * Endpoint to manually set up webhooks.
 */
app.get('/setup-webhooks', async (req, res) => {
  await createWebhook('order.create');
  await createWebhook('order.update');
  res.send('Webhooks registered.');
});

/**
 * Endpoint to list existing webhooks.
 */
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

/**
 * Endpoint to delete a webhook subscription.
 */
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
 * Helper: Retrieve order details using the API_KEY from Squarespace.
 * We use the webhook's createdOn timestamp to form a narrow date range.
 */
async function getOrderDetailsByOrderId(orderId, createdOn) {
  try {
    const orderDate = new Date(createdOn);
    // Define a 1-minute window around the order's createdOn timestamp
    const modifiedAfter = new Date(orderDate.getTime() - 60000).toISOString();
    const modifiedBefore = new Date(orderDate.getTime() + 60000).toISOString();
    const url = `https://api.squarespace.com/1.0/commerce/orders?modifiedAfter=${encodeURIComponent(modifiedAfter)}&modifiedBefore=${encodeURIComponent(modifiedBefore)}`;
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${process.env.API_KEY}`,
        'User-Agent': process.env.USER_AGENT
      }
    });
    if (response.data && Array.isArray(response.data.result)) {
      const order = response.data.result.find(o => o.id === orderId);
      return order;
    }
    return null;
  } catch (error) {
    console.error("Error retrieving order details:", error.response ? error.response.data : error.message);
    return null;
  }
}

/**
 * Production webhook endpoint.
 * This endpoint now uses the order-id from the webhook to look up customer details
 * via the Orders API (using API_KEY), then uses that data to drive the SFTP file operations.
 */
app.post('/webhook/squarespace', async (req, res) => {
  console.log("Raw POST data received:", JSON.stringify(req.body, null, 2));
  const event = req.body;
  if (!event || !event.data) {
    return res.status(400).send('Invalid webhook data');
  }
  
  const orderId = event.data.orderId;
  const createdOn = event.createdOn; // The webhook's createdOn timestamp
  const topic = event.topic;
  
  if (!orderId || !createdOn) {
    return res.status(400).send('Missing orderId or createdOn in webhook data');
  }
  
  // Retrieve order details using API_KEY
  const orderDetails = await getOrderDetailsByOrderId(orderId, createdOn);
  if (!orderDetails) {
    console.error(`Order with id ${orderId} not found.`);
    return res.status(404).send('Order not found');
  }
  
  // Process based on topic/update
  if (topic === 'order.create' || (topic === 'order.update' && event.data.update === 'FULFILLED')) {
    // Build customer data from orderDetails
    const userData = {
      username: orderDetails.customerEmail,
      subscriptionStatus: orderDetails.fulfillmentStatus,
      orderId: orderDetails.id,
      createdAt: orderDetails.createdOn,
      // Additional customer fields from orderDetails (e.g., billingAddress) can be added here
    };
    await uploadSubscriptionData(userData, orderDetails.id);
    res.status(200).send('Order processed and subscription data uploaded.');
  } else if (topic === 'order.update' && event.data.update === 'CANCELED') {
    await deleteSubscriptionFile(orderDetails.id);
    res.status(200).send('Order processed and subscription file deleted.');
  } else {
    res.status(200).send('Webhook processed with no action.');
  }
});

/* ========= Eligibility File Generation Functions ========= */

/**
 * Format a Date object as MMDDYYYY.
 */
function formatDateMMDDYYYY(dateObj) {
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  const yyyy = dateObj.getFullYear();
  return `${mm}${dd}${yyyy}`;
}

/**
 * Convert a date string to an effective date per Careington's logic.
 */
function toCareingtonEffectiveDate(dateString) {
  const dateObj = dateString ? new Date(dateString) : new Date();
  const year = dateObj.getFullYear();
  const month = dateObj.getMonth(); // 0-based
  const day = dateObj.getDate();
  return (day <= 15) ? new Date(year, month, 1) : (month === 11 ? new Date(year + 1, 0, 1) : new Date(year, month + 1, 1));
}

/**
 * Build a single pipe-delimited line from a member record.
 */
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

/**
 * Generate a pipe-delimited eligibility file.
 * File name format: PARENTGROUPCODEMMDDYY_full.csv or _delta.csv.
 */
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

/**
 * Upload the eligibility file to SFTP.
 */
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

/* ========= End Eligibility Functions ========= */

/**
 * TEST MODE: Generate a pipe-delimited eligibility file using fake data
 * based on the webhook test examples.
 */
app.get('/test-generate-file', async (req, res) => {
  const testMember = {
    title: 'Mr',
    firstName: 'Test',
    lastName: 'User',
    uniqueId: 'test-order-id',
    sequenceNum: '00', // Primary member
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
