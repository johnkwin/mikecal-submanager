require('dotenv').config();
const express = require('express');
const axios = require('axios');
const SFTPClient = require('ssh2-sftp-client');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const sftpConfig = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT || 22,
  username: process.env.SFTP_USER,
  password: process.env.SFTP_PASS,
};

const sftp = new SFTPClient();

// Function to upload subscription data to SFTP
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

// Function to delete a subscription file from SFTP
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
 * Update the .env file with new token values and update process.env accordingly.
 */
function updateEnvFile(newAccessToken, newRefreshToken) {
  const envPath = path.join(__dirname, '.env');
  let envContents = fs.readFileSync(envPath, 'utf8');

  envContents = envContents.replace(/^ACCESS_TOKEN=.*/m, `ACCESS_TOKEN=${newAccessToken}`);
  if (newRefreshToken) {
    // Either update existing or append if not found
    if (/^REFRESH_TOKEN=.*/m.test(envContents)) {
      envContents = envContents.replace(/^REFRESH_TOKEN=.*/m, `REFRESH_TOKEN=${newRefreshToken}`);
    } else {
      envContents += `\nREFRESH_TOKEN=${newRefreshToken}\n`;
    }
  }
  fs.writeFileSync(envPath, envContents);
  console.log("Updated .env file with new tokens.");

  // Update in-memory process.env variables as well
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
          'User-Agent': process.env.USER_AGENT // Ensure you set this in your .env
        }
      }
    );
    
    const newAccessToken = response.data.access_token;
    const newRefreshToken = response.data.refresh_token; // may be provided
    console.log('New Access Token:', newAccessToken);

    // Update tokens both in the file and process.env
    updateEnvFile(newAccessToken, newRefreshToken);
    console.log("Access token refreshed successfully.");
  } catch (error) {
    console.error("Error refreshing access token:", error.response ? error.response.data : error.message);
  }
}

// Schedule token refresh every 25 minutes (tokens are valid for 30 minutes)
setInterval(refreshAccessToken, 25 * 60 * 1000);

// OAuth Step 1: Redirect user to SquareSpace for authentication
app.get('/oauth/login', (req, res) => {
  const authUrl = `https://login.squarespace.com/api/1/login/oauth/provider/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&scope=website.orders,website.inventory&state=${process.env.STATE}`;
  res.redirect(authUrl);
});

// OAuth Step 2: Handle OAuth callback
app.get('/oauth/callback', async (req, res) => {
  const authCode = req.query.code;
  const state = req.query.state;
  
  // Validate the state parameter to prevent CSRF attacks
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
    const refreshToken = response.data.refresh_token; // if provided
    console.log('Access Token:', accessToken);

    // Update the .env file and in-memory tokens
    updateEnvFile(accessToken, refreshToken);

    res.send('OAuth successful! Access token updated.');
  } catch (error) {
    console.error('OAuth Error:', error.response ? error.response.data : error.message);
    res.status(500).send('OAuth failed.');
  }
});

// Function to create a SquareSpace webhook subscription
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

// Endpoint to set up webhooks
app.get('/setup-webhooks', async (req, res) => {
  await createWebhook('order.create');
  await createWebhook('order.update');
  res.send('Webhooks registered.');
});

// List existing webhooks
app.get('/list-webhooks', async (req, res) => {
  try {
    const response = await axios.get('https://api.squarespace.com/1.0/webhook_subscriptions', {
      headers: {
        'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`,
        'User-Agent': process.env.USER_AGENT
      }
    });
    // Return the JSON response from Squarespace
    res.json(response.data);
  } catch (error) {
    console.error("Error listing webhook subscriptions:", error.response ? error.response.data : error.message);
    res.status(500).send('Error retrieving webhook subscriptions.');
  }
});

// Delete a webhook (note: adjust the endpoint if necessary)
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

// Handle incoming SquareSpace webhooks
app.post('/webhook/squarespace', async (req, res) => {
  const event = req.body;

  console.log('Received SquareSpace Webhook:', event);

  if (!event || !event.data) {
    return res.status(400).send('Invalid webhook data');
  }

  const { email, id } = event.data.customer;
  const status = event.data.fulfillmentStatus;
  const fileName = id; // Using order ID as file identifier

  if (status === "FULFILLED") {
    const userData = {
      username: email,
      subscriptionStatus: status,
      orderId: id,
      createdAt: new Date().toISOString(),
    };
    await uploadSubscriptionData(userData, fileName);
  } else if (status === "CANCELED") {
    await deleteSubscriptionFile(fileName);
  }

  res.status(200).send('Webhook processed');
});

// Start Express server
const PORT = process.env.PORT || 3050;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
