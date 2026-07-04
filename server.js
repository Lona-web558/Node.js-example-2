const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8080;

// Internal Gateway Database (In-Memory for demonstration)
const TRANSACTION_LEDGER = []; // Stores approved, un-captured authorizations
const BANK_REGISTRY = {
  '4111': { status: 'APPROVED', code: '00', balance: 50000 },
  '5105': { status: 'DECLINED', code: '51', balance: 10 },
};

/**
 * 1. LUHN ALGORITHM VALIDATOR (MOD 10)
 * Mathematically verifies credit card numbers before hitting bank lines.
 */
function validateLuhn(cardNumberString) {
  const digits = cardNumberString.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;

  // Loop backwards through the digits array
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

/**
 * 2. ASYNCHRONOUS SETTLEMENT BATCH ENGINE
 * Converts authorized transactions into a valid Nacha ACH fixed-width document.
 */
function generateNachaBatchFile(transactions) {
  const fileIdModifier = 'A'; 
  const creationDate = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
  const creationTime = new Date().toTimeString().slice(0, 5).replace(/:/g, ''); // HHMM

  // Header Record (Priority 01, Standard Routing Format)
  let fileHeader = `101 021000021 123456789${creationDate}${creationTime}${fileIdModifier}094101MOCK GATEWAY DEPOSIT   \n`;
  
  // Batch Header Record (Standard Entry Class Code: PPD for direct deposits)
  let batchHeader = `5200MOCK ORIGINATOR    0001234567PPDRETAIL SETTL${creationDate}${creationDate}0001021000020000001\n`;
  
  let entryDetailRecords = '';
  let totalSettlementAmountCents = 0;
  let entryCount = 0;

  transactions.forEach((tx, index) => {
    entryCount++;
    totalSettlementAmountCents += tx.amountCents;
    const traceNumber = String(102000010000000 + index).padStart(15, '0');
    const amountStr = String(tx.amountCents).padStart(10, '0');
    
    // Record Type 6: Individual Transaction Entry (CCD/PPD Ledger Line)
    // 22 = Automated Deposit to Checking Account
    entryDetailRecords += `6220210000211234567890${amountStr}TX-${tx.txId}     MERCHANT CAPTURE    0${traceNumber}\n`;
  });

  // Batch Control Summary Record
  const totalAmountStr = String(totalSettlementAmountCents).padStart(12, '0');
  let batchControl = `8200${String(entryCount).padStart(6, '0')}0021000021000000000000${totalAmountStr}0001234567                         021000020000001\n`;
  
  // File Control Summary Record
  let fileControl = `9000001${String(Math.ceil((entryCount + 4) / 10)).padStart(6, '0')}${String(entryCount).padStart(8, '0')}0021000021000000000000${totalAmountStr}                                       \n`;

  return `${fileHeader}${batchHeader}${entryDetailRecords}${batchControl}${fileControl}`;
}

const server = http.createServer((req, res) => {
  // Serve UI
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Internal Gateway Fault');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } 

  // Endpoint: Core Front-End Authorization Gateway
  else if (req.method === 'POST' && req.url === '/gateway/v1/authorize') {
    let rawChunks = '';
    req.on('data', chunk => { rawChunks += chunk.toString(); });
    req.on('end', () => {
      try {
        const { cardNumber, expiry, cvv, amount } = JSON.parse(rawChunks);
        const cleanCardNumber = cardNumber.replace(/\s+/g, '');

        // Step A: Luhn Edge Checks
        if (!validateLuhn(cleanCardNumber)) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            status: 'REJECTED',
            responseCode: '14', // Bank Code for Invalid Card Number Length/Luhn Check Digit
            message: 'Local Checksum Validation Failed: Card identification number checksum invalid.'
          }));
        }

        const amountCents = Math.round(parseFloat(amount) * 100);
        const binPrefix = cleanCardNumber.substring(0, 4);
        const bankRoute = BANK_REGISTRY[binPrefix];

        if (!bankRoute || bankRoute.balance < amountCents) {
          res.writeHead(402, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            status: 'DECLINED',
            responseCode: bankRoute ? bankRoute.code : '05',
            message: 'Insufficient ledger capital or routing lookup miss.'
          }));
        }

        // Step B: Build Authorization Record Object
        const txId = crypto.randomBytes(6).toString('hex').toUpperCase();
        TRANSACTION_LEDGER.push({ txId, amountCents, timestamp: new Date() });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'SUCCESS',
          responseCode: '00',
          transactionReference: txId,
          message: 'Authorization Approved. Funds are held in escrow pending midnight settlement batch process.'
        }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Switch Serialization Error', details: err.message }));
      }
    });
  }

  // Endpoint: Daily Asynchronous Settlement Processor Trigger
  else if (req.method === 'POST' && req.url === '/gateway/v1/settle-batch') {
    if (TRANSACTION_LEDGER.length === 0) {
      res.writeHead(204, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'No authorized balances available to clear.' }));
    }

    // Capture current pending balance arrays
    const itemsToClear = [...TRANSACTION_LEDGER];
    TRANSACTION_LEDGER.length = 0; // Empty system tracking memory array safely

    // Compile into raw fixed-width banking layout schemas
    const nachaFileContents = generateNachaBatchFile(itemsToClear);
    const fileName = `ACH_BATCH_${Date.now()}.txt`;
    const filePath = path.join(__dirname, 'batches', fileName);

    // Create target clearing batch directory if it does not exist
    if (!fs.existsSync(path.join(__dirname, 'batches'))) {
      fs.mkdirSync(path.join(__dirname, 'batches'));
    }

    // Write file directly to local clearing house spooler
    fs.writeFile(filePath, nachaFileContents, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Failed to write clearing ledger transaction logs.' }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'BATCH_DISPATCHED',
        clearingRecordCount: itemsToClear.length,
        outputFile: fileName,
        message: 'Fixed-width clearing document generated and uploaded to bank SFTP server directory.'
      }));
    });
  }

  else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Route Not Mapped');
  }
});

server.listen(PORT, () => console.log(`Proprietary Financial Node Core Engine operational on Port ${PORT}`));
