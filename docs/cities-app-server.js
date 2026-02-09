/**
 * Full server.js for the cities app (restore copy).
 * Fix: Wikipedia URL must have "?" before query string:
 *   BAD:  '...search/title' + new URLSearchParams(...).toString()
 *   GOOD: '...search/title?' + new URLSearchParams(...).toString()
 *
 * Copy this file to your project as server.js if the agent removed most of your code.
 */

const express = require('express');
const path = require('path');
const axios = require('axios');
const { URLSearchParams } = require('url');

const app = express();
const PORT = process.env.PORT || 4003;

const startServer = async () => {
  const portsToTry = [PORT, PORT + 1, PORT + 2];
  for (const attemptPort of portsToTry) {
    try {
      const server = await new Promise((resolve, reject) => {
        const s = app.listen(attemptPort, () => {
          console.log(`Server is running on http://localhost:${attemptPort}`);
          resolve(s);
        });
        s.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`Port ${attemptPort} is already in use`));
          } else {
            reject(err);
          }
        });
      });
      return server;
    } catch (err) {
      if (err.message?.includes('already in use')) {
        continue;
      }
      console.error('Server error:', err);
      throw err;
    }
  }
  throw new Error('All ports in range are in use. Please free up a port.');
};

app.use(express.static('public'));
app.use(express.json());

const cities = [
  { name: 'New York', country: 'USA', population: '8.4 million', description: 'The most populous city in the United States.' },
  { name: 'London', country: 'UK', population: '9.0 million', description: 'The capital of England and the United Kingdom.' },
  { name: 'Tokyo', country: 'Japan', population: '14.0 million', description: "Japan's capital and the world's most populous metropolitan area." },
  { name: 'Paris', country: 'France', population: '2.1 million', description: 'The capital of France.' },
  { name: 'Sydney', country: 'Australia', population: '5.3 million', description: "Australia's largest city." },
  { name: 'Dubai', country: 'UAE', population: '3.3 million', description: 'A city in the United Arab Emirates.' },
  { name: 'Rio de Janeiro', country: 'Brazil', population: '6.7 million', description: 'Famous for Copacabana and Christ the Redeemer.' },
  { name: 'Cape Town', country: 'South Africa', population: '4.6 million', description: "A port city on South Africa's southwest coast." },
];

async function fetchWikipediaSummary(cityName) {
  try {
    const titleRes = await axios.get('https://en.wikipedia.org/api/rest_v1/search/title', {
      params: { q: cityName, limit: 1 },
    });
    const first = Array.isArray(titleRes.data) ? titleRes.data[0] : titleRes.data?.pages?.[0] || titleRes.data?.results?.[0];
    const title = first?.title ?? cityName;

    const summaryRes = await axios.get(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
    );
    const summaryData = summaryRes.data || {};
    const thumbnail = summaryData.thumbnail?.source ?? null;
    const description = summaryData.extract || 'No description available';
    return { description, imageUrl: thumbnail };
  } catch (err) {
    console.error(`Failed to fetch Wikipedia data for ${cityName}:`, err.message);
    return { description: 'No information found', imageUrl: null };
  }
}

// FIX: URL must be "...search/title?" + query string (the "?" was missing)
app.get('/api/cities', async (req, res) => {
  const searchQuery = req.query.q?.toLowerCase?.();
  if (!searchQuery || typeof searchQuery !== 'string') {
    res.json([]);
    return;
  }

  try {
    const searchRes = await axios.get(
      'https://en.wikipedia.org/api/rest_v1/search/title?' +
        new URLSearchParams({ q: searchQuery, limit: 10 }).toString()
    );
    const data = searchRes.data;

    let titles = [];
    if (Array.isArray(data)) {
      titles = data.map((item) => item?.title).filter(Boolean);
    } else if (data && Array.isArray(data.pages)) {
      titles = data.pages.map((item) => item?.title).filter(Boolean);
    } else if (data && Array.isArray(data.results)) {
      titles = data.results.map((item) => item?.title).filter(Boolean);
    }

    if (titles.length === 0) {
      res.json([]);
      return;
    }

    const cityPromises = titles.map(async (title) => {
      try {
        const info = await fetchWikipediaSummary(title);
        return {
          name: title,
          country: 'N/A',
          population: 'unknown',
          description: info.description,
          imageUrl: info.imageUrl,
        };
      } catch (err) {
        console.error('Error fetching summary for', title, err.message);
        return {
          name: title,
          country: 'N/A',
          population: 'unknown',
          description: 'No description available',
          imageUrl: null,
        };
      }
    });

    const cityData = await Promise.all(cityPromises);
    res.json(cityData);
  } catch (err) {
    console.error('Error searching cities:', err.message);
    res.status(500).json({ error: 'Unable to retrieve city data' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function runTests() {
  let server;
  try {
    server = await startServer();
    const port = server.address().port;
    const baseUrl = `http://localhost:${port}`;

    const emptyRes = await axios.get(`${baseUrl}/api/cities`);
    if (!Array.isArray(emptyRes.data) || emptyRes.data.length !== 0) {
      throw new Error('Expected empty array for empty query');
    }
    console.log('Test 1 passed: empty query returns []');

    const londonRes = await axios.get(`${baseUrl}/api/cities?q=London`);
    if (!Array.isArray(londonRes.data) || londonRes.data.length === 0) {
      throw new Error('Expected at least one result for London');
    }
    const london = londonRes.data[0];
    if (london.name !== 'London' || !london.description) {
      throw new Error('Expected name and description for London');
    }
    console.log('Test 2 passed: London query returns correct structure');

    const rootRes = await axios.get(baseUrl);
    if (rootRes.status !== 200 || !rootRes.headers['content-type']?.includes('text/html')) {
      throw new Error('Expected status 200 and text/html for root');
    }
    console.log('Test 3 passed: root route returns HTML');

    console.log('All tests passed!');
  } catch (err) {
    console.error('Test failed:', err.message);
    process.exit(1);
  } finally {
    if (server) server.close();
  }
}

if (require.main === module) {
  if (process.argv.includes('--test')) {
    runTests();
  } else {
    startServer().catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
  }
}
