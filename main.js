require('dotenv').config();
const express = require('express');
const axios = require('axios');
const SFTPClient = require('ssh2-sftp-client');
const bodyParser = require('body-parser');

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

// OAuth Step 1: Redirect user to SquareSpace for authentication
app.get('/oauth/login', (req, res) => {
  const authUrl = `https://login.squarespace.com/api/1/login/oauth/provider/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${process.env.REDIRECT_URI}&scope=website.orders,website.inventory&state=${process.env.STATE}`;
  res.redirect(authUrl);
});

// OAuth Step 2: Handle OAuth callback
app.get('/oauth/callback', async (req, res) => {
    // Capture the code and state from the query parameters
    const authCode = req.query.code;
    const state = req.query.state;
    
    // Optional: Validate the state parameter to prevent CSRF attacks
    if (state !== process.env.STATE) {
     return res.status(400).send('Invalid state parameter.');
     }
    
    if (!authCode) {
      return res.status(400).send('Authorization code is missing.');
    }
  
    try {
      // Build the Basic Auth header using client_id and client_secret
      const credentials = `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`;
      const encodedCredentials = Buffer.from(credentials).toString('base64');
      
      // Make the POST request to the correct token endpoint
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
            'User-Agent': 'YourAppName/1.0' // Ensure you set a User-Agent header as required
          }
        }
      );
      
      const accessToken = response.data.access_token;
      console.log('Access Token:', accessToken);
      res.send('OAuth successful! Store the access token securely.');
    } catch (error) {
      console.error('OAuth Error:', error.response ? error.response.data : error.message);
      res.status(500).send('OAuth failed.');
    }
  });

// Function to create a SquareSpace webhook
async function createWebhook(eventType) {
  try {
    const response = await axios.post(
      'https://api.squarespace.com/1.0/webhooks',
      {
        event: eventType,
        callbackUrl: 'https://lowpriceparadise.com/webhook/squarespace',
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
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
    const response = await axios.get('https://api.squarespace.com/1.0/webhooks', {
      headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` },
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).send('Error retrieving webhooks.');
  }
});

// Delete a webhook
app.get('/delete-webhook/:id', async (req, res) => {
  try {
    await axios.delete(`https://api.squarespace.com/1.0/webhooks/${req.params.id}`, {
      headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` },
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
    // Create subscription file
    const userData = {
      username: email,
      subscriptionStatus: status,
      orderId: id,
      createdAt: new Date().toISOString(),
    };
    await uploadSubscriptionData(userData, fileName);
  } else if (status === "CANCELED") {
    // Delete subscription file
    await deleteSubscriptionFile(fileName);
  }

  res.status(200).send('Webhook processed');
});

// Start Express server
const PORT = process.env.PORT || 3050;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
