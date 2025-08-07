const axios = require('axios');
const puppeteer = require('puppeteer-core');

const startProfile = async (profileId) => {
  const url = `http://local.adspower.net:50325/api/v1/browser/start?user_id=${profileId}`;
  const res = await axios.get(url);
  const wsEndpoint = res.data.data.ws.puppeteer; // ✅ This is the actual websocket URL

  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint }); // ✅ Fix here
  return browser;
};

module.exports = { startProfile };
