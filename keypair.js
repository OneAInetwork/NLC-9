"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const web3_js_1 = require("@solana/web3.js");
const fs_1 = require("fs");
try {
    // Read the keypair from file
    const keypairData = (0, fs_1.readFileSync)('./solana/main.json', 'utf-8');
    const secretKey = Uint8Array.from(JSON.parse(keypairData));
    const keypair = web3_js_1.Keypair.fromSecretKey(secretKey);
    console.log("Vault Public Key:", keypair.publicKey.toString());
}
catch (error) {
    console.error("Error reading keypair:", error);
    process.exit(1);
}
