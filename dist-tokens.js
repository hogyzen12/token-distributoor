#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { program } = require('commander');
const web3 = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const bs58 = require('bs58');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// Default values
const DEFAULT_KEY_FOLDER = './keypairs';
const DEFAULT_RECIPIENT_FILE = './distri.txt';
const DEFAULT_TOKEN_MINT = '5LafQUrVco6o7KMz42eqVEJ9LW31StPyGjeeu5sKoMtA';
const DEFAULT_TIP_ACCOUNT = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const DEFAULT_TIP_AMOUNT = '100000';

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

const MIN_RETRY_DELAY = 30000; // 30 seconds in milliseconds

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

  let retryDelay = MIN_RETRY_DELAY;
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    try {
      const response = await axios.post(JITO_BUNDLE_API, bundleData, {
        headers: { 'Content-Type': 'application/json' },
      });
      return response.data.result;
    } catch (error) {
      if (error.response && error.response.status === 429) {
        attempts++;
        console.log(`Rate limit exceeded. Retrying in ${retryDelay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 300000); // Double the delay, max 5 minutes
      } else {
        console.error('Error sending bundle:', error.response?.data || error.message);
        throw new Error('Failed to send bundle.');
      }
    }
  }

  throw new Error('Max retry attempts reached. Failed to send bundle.');
}

// Function to check if a token account exists and create it if it doesn't
async function getOrCreateAssociatedTokenAccount(connection, payer, mint, owner) {
  const associatedTokenAddress = await splToken.getAssociatedTokenAddress(
    mint,
    owner
  );

  try {
    const tokenAccount = await splToken.getAccount(connection, associatedTokenAddress);
    console.log(`Existing token account found for ${owner.toBase58()}`);
    return tokenAccount.address;
  } catch (error) {
    if (error instanceof splToken.TokenAccountNotFoundError) {
      console.log(`Creating new token account for ${owner.toBase58()}`);
      const transaction = new web3.Transaction().add(
        splToken.createAssociatedTokenAccountInstruction(
          payer.publicKey,
          associatedTokenAddress,
          owner,
          mint
        )
      );
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = payer.publicKey;
      transaction.sign(payer);
      
      const txId = await connection.sendTransaction(transaction, [payer]);
      await connection.confirmTransaction(txId);
      
      console.log(`New token account created for ${owner.toBase58()}`);
      return associatedTokenAddress;
    } else {
      throw error;
    }
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
    const senderTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      tokenMintPubkey,
      wallet.publicKey
    );

    // Get or create the recipient's token account
    const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      tokenMintPubkey,
      recipientAddress
    );

    // Create transfer instruction
    const transferInstruction = createTransferInstruction(
      senderTokenAccount,
      recipientTokenAccount,
      wallet.publicKey,
      amount
    );

    // Create transaction
    const transaction = new web3.Transaction().add(transferInstruction);

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

    console.log(`Transaction created: Sending ${amount.toString()} tokens from ${wallet.publicKey.toBase58()} to ${recipientAddress.toBase58()}`);

    // If the bundle is full or it's the last recipient, add it to the bundles array
    if (currentBundle.length === 5 || i === recipients.length - 1) {
      bundles.push(currentBundle);
      console.log(`Bundle created with ${currentBundle.length} transactions`);
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
      const delayMs = MIN_RETRY_DELAY;
      console.log(`Waiting ${delayMs / 1000} seconds before sending the next bundle...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.log('Token distribution completed.');
}

// Set up CLI
program
  .version('1.0.0')
  .description('Distribute tokens using Jito bundles')
  .option('-k, --key-folder <path>', 'Path to the folder containing wallet key files', DEFAULT_KEY_FOLDER)
  .option('-r, --recipient-file <path>', 'Path to the file containing recipient addresses and amounts', DEFAULT_RECIPIENT_FILE)
  .option('-m, --token-mint <address>', 'Token mint address', DEFAULT_TOKEN_MINT)
  .option('-t, --tip-account <address>', 'Tip account address', DEFAULT_TIP_ACCOUNT)
  .option('-a, --tip-amount <amount>', 'Tip amount in lamports', DEFAULT_TIP_AMOUNT)
  .helpOption('-h, --help', 'Display help for command')
  .on('--help', () => {
    console.log('');
    console.log('Default values:');
    console.log(`  Key folder: ${DEFAULT_KEY_FOLDER}`);
    console.log(`  Recipient file: ${DEFAULT_RECIPIENT_FILE}`);
    console.log(`  Token mint: ${DEFAULT_TOKEN_MINT}`);
    console.log(`  Tip account: ${DEFAULT_TIP_ACCOUNT}`);
    console.log(`  Tip amount: ${DEFAULT_TIP_AMOUNT} lamports`);
  })
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