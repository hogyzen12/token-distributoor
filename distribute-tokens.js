#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { program } = require('commander');
const web3 = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const bs58 = require('bs58');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// Jito bundle API endpoint
const JITO_BUNDLE_API = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

// Solana connection
const connection = new web3.Connection(
  'https://damp-fabled-panorama.solana-mainnet.quiknode.pro/186133957d30cece76e7cd8b04bce0c5795c164e/',
  'confirmed'
);

// Function to read wallet files from a directory
async function readWallets(keyFolder) {
  const files = await fs.readdir(keyFolder);
  const wallets = [];

  for (const file of files) {
    if (path.extname(file) === '.json') {
      const filePath = path.join(keyFolder, file);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const secretKey = Uint8Array.from(JSON.parse(fileContent));
      wallets.push(web3.Keypair.fromSecretKey(secretKey));
    }
  }

  return wallets;
}

// Function to read recipient addresses and amounts from a text file
async function readRecipients(filePath) {
  const fileContent = await fs.readFile(filePath, 'utf-8');
  const lines = fileContent.split('\n');
  const recipients = [];

  for (const line of lines) {
    const [address, amount] = line.trim().split(',');
    if (address && amount) {
      recipients.push({
        address: new web3.PublicKey(address),
        amount: BigInt(amount),
      });
    }
  }

  return recipients;
}

// Function to create a token transfer instruction
function createTransferInstruction(source, destination, owner, amount) {
  return splToken.createTransferInstruction(
    source,
    destination,
    owner,
    amount,
    [],
    splToken.TOKEN_PROGRAM_ID
  );
}

// Function to create a memo instruction
function createMemoInstruction(message) {
  return new web3.TransactionInstruction({
    keys: [],
    programId: new web3.PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    data: Buffer.from(message, 'utf-8'),
  });
}

// Function to send a bundle of transactions
async function sendBundle(transactions) {
  const encodedTransactions = transactions.map((tx) =>
    bs58.encode(tx.serialize())
  );

  const bundleData = {
    jsonrpc: '2.0',
    id: uuidv4(),
    method: 'sendBundle',
    params: [encodedTransactions],
  };

  try {
    const response = await axios.post(JITO_BUNDLE_API, bundleData, {
      headers: { 'Content-Type': 'application/json' },
    });
    return response.data.result;
  } catch (error) {
    console.error('Error sending bundle:', error.response?.data || error.message);
    throw new Error('Failed to send bundle.');
  }
}

// Main function to distribute tokens
async function distributeTokens(keyFolder, recipientFile, tokenMint, tipAccount, tipAmount) {
  const wallets = await readWallets(keyFolder);
  const recipients = await readRecipients(recipientFile);

  console.log(`Loaded ${wallets.length} wallets and ${recipients.length} recipients.`);

  const tokenMintPubkey = new web3.PublicKey(tokenMint);
  const tipAccountPubkey = new web3.PublicKey(tipAccount);

  let currentWalletIndex = 0;
  const bundles = [];
  let currentBundle = [];

  for (let i = 0; i < recipients.length; i++) {
    const { address: recipientAddress, amount } = recipients[i];

    // Get the current wallet and its token account
    const wallet = wallets[currentWalletIndex];
    const tokenAccount = await splToken.getAssociatedTokenAddress(
      tokenMintPubkey,
      wallet.publicKey
    );

    // Create transfer instruction
    const transferInstruction = createTransferInstruction(
      tokenAccount,
      recipientAddress,
      wallet.publicKey,
      amount
    );

    // Create memo instruction
    const memoInstruction = createMemoInstruction(`Token transfer ${i + 1}`);

    // Create transaction
    const transaction = new web3.Transaction().add(memoInstruction, transferInstruction);

    // Add tip to the last transaction in the bundle
    if (currentBundle.length === 4 || i === recipients.length - 1) {
      const tipInstruction = web3.SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: tipAccountPubkey,
        lamports: tipAmount,
      });
      transaction.add(tipInstruction);
    }

    // Set recent blockhash and sign transaction
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet);

    currentBundle.push(transaction);

    // If the bundle is full or it's the last recipient, add it to the bundles array
    if (currentBundle.length === 5 || i === recipients.length - 1) {
      bundles.push(currentBundle);
      currentBundle = [];
      currentWalletIndex = (currentWalletIndex + 1) % wallets.length;
    }
  }

  // Send bundles
  for (let i = 0; i < bundles.length; i++) {
    console.log(`Sending bundle ${i + 1} of ${bundles.length}...`);
    try {
      const bundleId = await sendBundle(bundles[i]);
      console.log(`Bundle ${i + 1} sent successfully. Bundle ID: ${bundleId}`);
    } catch (error) {
      console.error(`Failed to send bundle ${i + 1}:`, error.message);
    }

    // Add a delay between bundles to avoid rate limiting
    if (i < bundles.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log('Token distribution completed.');
}

// Set up CLI
program
  .version('1.0.0')
  .description('Distribute tokens using Jito bundles')
  .requiredOption('-k, --key-folder <path>', 'Path to the folder containing wallet key files')
  .requiredOption('-r, --recipient-file <path>', 'Path to the file containing recipient addresses and amounts')
  .requiredOption('-m, --token-mint <address>', 'Token mint address')
  .requiredOption('-t, --tip-account <address>', 'Tip account address')
  .option('-a, --tip-amount <amount>', 'Tip amount in lamports', '100000')
  .parse(process.argv);

const options = program.opts();

// Run the token distribution
distributeTokens(
  options.keyFolder,
  options.recipientFile,
  options.tokenMint,
  options.tipAccount,
  BigInt(options.tipAmount)
).catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});