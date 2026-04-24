const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'storage', 'bearer.txt');

function saveToken(token) {
  fs.writeFileSync(FILE, token.trim());
}

function getToken() {
  if (process.env.SIMCLUSTER_BEARER) {
    return process.env.SIMCLUSTER_BEARER.trim();
  }

  if (fs.existsSync(FILE)) {
    return fs.readFileSync(FILE, 'utf-8').trim();
  }

  return null;
}

module.exports = { saveToken, getToken };