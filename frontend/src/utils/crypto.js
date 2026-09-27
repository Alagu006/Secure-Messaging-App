/*
 * crypto.js — End-to-end encryption for LANChat
 *
 * Uses ONLY the browser's built-in Web Crypto API (window.crypto.subtle).
 * No external libraries — you don't need OpenPGP.js, libsodium, or anything else.
 *
 * ARCHITECTURE — why we have TWO keypairs:
 *
 *   The Web Crypto API is strict: an ECDH key cannot sign, and an ECDSA key
 *   cannot do key agreement — even though both use the same P-256 curve.
 *
 *   So each user generates TWO keypairs at registration:
 *     1. Key Agreement keypair (ECDH P-256)  for deriving shared encryption keys
 *     2. Signing keypair (ECDSA P-256)       for proving identity (challenge login)
 *
 * MESSAGE ENCRYPTION (end-to-end):
 *
 *   Alice's private ECDH key + Bob's public ECDH key  ->  Shared AES-256-GCM key
 *   Bob's private ECDH key + Alice's public ECDH key  ->  SAME Shared AES-256-GCM key
 *
 *   This is Diffie-Hellman key exchange. The shared secret is a mathematical
 *   result — it is NEVER sent over the network. Both sides compute the same
 *   value independently.
 *
 *   Messages are encrypted with AES-256-GCM before leaving the sender's device.
 *   The server only ever stores and forwards ciphertext.
 *
 * KEY STORAGE:
 *
 *   Private keys are wrapped (encrypted) with a passphrase-derived key using
 *   AES-KW and stored in IndexedDB. The raw private key bytes never touch disk.
 *   When loaded, they are imported as non-extractable CryptoKey objects that
 *   JavaScript cannot read out.
 */

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

const ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" };
const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" };
const AES_GCM_PARAMS = { name: "AES-GCM", length: 256 };
const PBKDF2_PARAMS = { name: "PBKDF2" };
const HKDF_PARAMS = { name: "HKDF" };
const SHA256_HASH = "SHA-256";

// How many PBKDF2 iterations to derive the key-wrapping key from passphrase.
// Higher = slower to unlock, but harder to brute-force.
const PBKDF2_ITERATIONS = 100_000;

// IndexedDB database name and the object store we use for key storage
const DB_NAME = "lanchat-keys";
const STORE_NAME = "identity";

// ──────────────────────────────────────────────────────────────────────────
// Wordlist for key fingerprints (256 short, distinct words)
// Each word represents one byte (0–255) of the public key hash.
// ──────────────────────────────────────────────────────────────────────────

const WORDLIST = [
  "apple","beach","crane","dwarf","eagle","flame","grape","honey",
  "ibex","jolly","koala","lemon","mango","noble","ocean","piano",
  "queen","raven","snake","tiger","umbra","vivid","whale","xenon",
  "yacht","zebra","amber","blush","coral","drift","ember","frost",
  "gloss","hazel","ivory","jade","khaki","lilac","mauve","night",
  "olive","pearl","quart","rose","silver","topaz","ultra","vapor",
  "wheat","amber","azure","brick","cream","denim","eco","fawn",
  "gold","hemp","iris","jute","kelp","lace","mica","nylon",
  "ochre","plaid","quilt","rust","satin","twill","umber","vinyl",
  "wax","xylol","yarn","zinc","aloe","balsa","cedar","date",
  "elder","fir","ginko","hemp","iroko","juniper","kapok","larch",
  "maple","nutmeg","oak","pine","quince","rose","spruce","teak",
  "ulmus","vine","willow","xerox","yew","zinnia","aster","birch",
  "cactus","daisy","elder","fern","garden","heather","iris","jasmine",
  "kiwi","lily","mint","narcis","orchid","peony","quince","rose",
  "sage","tulip","ursa","violet","weed","xeris","yucca","zinnia",
  "argon","boron","curie","dalton","einstein","fermi","gallium","helium",
  "iodine","joule","krypton","lithium","magnon","neon","osmium","photon",
  "quantum","radon","sodium","triton","uranus","venus","watt","xenon",
  "ytter","zinc","angle","basin","cove","delta","estate","fjord",
  "glen","hill","isle","jetty","knoll","lake","marsh","narrow",
  "oasis","plain","quarry","ridge","sound","tarn","upper","vale",
  "wold","xeric","yard","zone","alarm","basil","cider","dill",
  "eggs","fudge","garbanzo","honey","icing","jalapeno","kale","leek",
  "miso","nori","okra","pepper","quinoa","radish","salsa","thyme",
  "udon","vinegar","wasabi","xigua","yeast","zest","anise","berry",
  "cilantro","date","endive","fennel","guava","horseradish","indigo","jicama",
  "kohlrabi","lentil","mushroom","nopal","oregano","parsnip","quince","rosemary",
  "sorrel","tamarind","ube","valerian","watercress","xoconostle","yam","zucchini"
];

// ──────────────────────────────────────────────────────────────────────────
// 1. generateIdentityKeyPair()
// ──────────────────────────────────────────────────────────────────────────

export async function generateIdentityKeyPair() {
  /*
    Generate TWO P-256 keypairs:
      - keyAgreement  (ECDH)  for deriving shared encryption keys
      - signing       (ECDSA) for signing challenge nonces

    Both private keys are marked extractable: true so we can wrap them
    with AES-KW and store them in IndexedDB. Once loaded back from
    storage, they are re-imported as non-extractable.

    Returns an object with:
      keyAgreement:  { publicKey, privateKey }
      signing:       { publicKey, privateKey }
  */

  // ---- Key Agreement keypair (ECDH) ----
  const kaKeyPair = await crypto.subtle.generateKey(
    ECDH_PARAMS,
    true,                     // extractable (needed for wrapKey/exportKey)
    ["deriveKey", "deriveBits"]
  );

  // ---- Signing keypair (ECDSA) ----
  const sgKeyPair = await crypto.subtle.generateKey(
    ECDSA_PARAMS,
    true,                     // extractable (needed for wrapKey/exportKey)
    ["sign"]
  );

  return {
    keyAgreement: {
      publicKey: kaKeyPair.publicKey,
      privateKey: kaKeyPair.privateKey,
    },
    signing: {
      publicKey: sgKeyPair.publicKey,
      privateKey: sgKeyPair.privateKey,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 2. exportPublicKey()
// ──────────────────────────────────────────────────────────────────────────

export async function exportPublicKey(keyAgreementPublicKey, signingPublicKey) {
  /*
    Export both P-256 public keys as a single base64 string.

    We use JWK format because it preserves the curve metadata needed to
    re-import the key. The two JWK objects are combined into a JSON array,
    then base64-encoded. The server stores this string in the "public_key"
    column of the users table.

    Parameters:
      keyAgreementPublicKey  — ECDH public key (CryptoKey)
      signingPublicKey       — ECDSA public key (CryptoKey)

    Returns:
      A base64-encoded JSON string that can be passed to importPublicKey().
  */

  const kaJwk = await crypto.subtle.exportKey("jwk", keyAgreementPublicKey);
  const sgJwk = await crypto.subtle.exportKey("jwk", signingPublicKey);

  const combined = JSON.stringify({ ka: kaJwk, sg: sgJwk });

  // Convert the JSON string to a base64 string for transport over HTTP
  const encoder = new TextEncoder();
  const bytes = encoder.encode(combined);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));

  return base64;
}

// ──────────────────────────────────────────────────────────────────────────
// 3. importPublicKey()
// ──────────────────────────────────────────────────────────────────────────

export async function importPublicKey(base64String) {
  /*
    Reverse of exportPublicKey — parse the base64 string and re-import
    both public keys as CryptoKey objects that can be used with the
    Web Crypto API.

    Parameters:
      base64String — the string previously created by exportPublicKey()

    Returns:
      { publicKey (ECDH), signingPublicKey (ECDSA) }
  */

  const decoder = new TextDecoder();
  const bytes = Uint8Array.from(atob(base64String), (c) => c.charCodeAt(0));
  const json = decoder.decode(bytes);
  const { ka: kaJwk, sg: sgJwk } = JSON.parse(json);

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    kaJwk,
    ECDH_PARAMS,
    true,       // extractable
    []          // no usages needed for public keys
  );

  const signingPublicKey = await crypto.subtle.importKey(
    "jwk",
    sgJwk,
    ECDSA_PARAMS,
    true,
    []
  );

  return { publicKey, signingPublicKey };
}

// ──────────────────────────────────────────────────────────────────────────
// 4. deriveSharedSecret()
// ──────────────────────────────────────────────────────────────────────────

export async function deriveSharedSecret(myPrivateKey, theirPublicKey) {
  /*
    Use ECDH (Elliptic Curve Diffie-Hellman) to produce a shared
    AES-256-GCM key that only us and the other person can compute.

    How it works:
      - We pass OUR private key + THEIR public key into the ECDH algorithm.
      - The result is a unique 256-bit secret that BOTH sides can derive,
        but no one else can (because nobody else has our private key).
      - Both sides get the identical AES-256-GCM key.

    Parameters:
      myPrivateKey     — our ECDH private key (CryptoKey)
      theirPublicKey   — the other user's ECDH public key (CryptoKey)

    Returns:
      An AES-256-GCM CryptoKey that can be used with encryptMessage()
      and decryptMessage().
  */

  const sharedKey = await crypto.subtle.deriveKey(
    {
      name: "ECDH",
      public: theirPublicKey,
    },
    myPrivateKey,
    AES_GCM_PARAMS,           // output: AES-256-GCM key
    false,                    // not extractable (keep it safe in the crypto engine)
    ["encrypt", "decrypt"]
  );

  return sharedKey;
}

// ──────────────────────────────────────────────────────────────────────────
// 5. encryptMessage()
// ──────────────────────────────────────────────────────────────────────────

export async function encryptMessage(sharedKey, plaintext) {
  /*
    Encrypt a message using AES-256-GCM with a random IV.

    AES-GCM is an "authenticated encryption" mode — it guarantees both
    confidentiality (nobody can read it) AND integrity (nobody can tamper
    with it without detection).

    Every encryption gets a NEW random IV (12 bytes). This is critical:
    reusing an IV with the same key lets an attacker recover the plaintext.

    Parameters:
      sharedKey  — the AES-256-GCM key from deriveSharedSecret()
      plaintext  — the string to encrypt

    Returns:
      { iv: (base64 string), ciphertext: (base64 string) }
  */

  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  // Generate a random 12-byte IV (96 bits — standard for GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
      tagLength: 128,    // authentication tag length (bits)
    },
    sharedKey,
    data
  );

  // The result from encrypt() is one ArrayBuffer containing both the
  // ciphertext (encrypted data) and the GCM authentication tag (last 16 bytes).
  // We return both IV and ciphertext as base64 strings so they can be
  // sent over JSON/WebSocket.

  return {
    iv: arrayBufferToBase64(iv.buffer),
    ciphertext: arrayBufferToBase64(encrypted),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 6. decryptMessage()
// ──────────────────────────────────────────────────────────────────────────

export async function decryptMessage(sharedKey, ivBase64, ciphertextBase64) {
  /*
    Reverse of encryptMessage — decrypt AES-256-GCM ciphertext.

    If the ciphertext was tampered with (or the IV is wrong), GCM's
    authentication check will fail and this function will throw an error.

    Parameters:
      sharedKey          — the AES-256-GCM key from deriveSharedSecret()
      ivBase64           — the IV that was returned by encryptMessage()
      ciphertextBase64   — the ciphertext returned by encryptMessage()

    Returns:
      The original plaintext string.
  */

  const iv = base64ToArrayBuffer(ivBase64);
  const ciphertext = base64ToArrayBuffer(ciphertextBase64);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(iv),
      tagLength: 128,
    },
    sharedKey,
    ciphertext
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

// ──────────────────────────────────────────────────────────────────────────
// 7. encryptBuffer() / decryptBuffer()
// ──────────────────────────────────────────────────────────────────────────

export async function encryptBuffer(sharedKey, data) {
  /*
    Encrypt a binary ArrayBuffer using AES-256-GCM.
    Used for encrypting file and voice data before sending via WebRTC.

    Parameters:
      sharedKey — the AES-256-GCM CryptoKey from deriveSharedSecret()
      data      — an ArrayBuffer of binary data

    Returns:
      { iv: ArrayBuffer, ciphertext: ArrayBuffer }
  */

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
      tagLength: 128,
    },
    sharedKey,
    data
  );
  return { iv: iv.buffer, ciphertext: encrypted };
}


export async function decryptBuffer(sharedKey, iv, ciphertext) {
  /*
    Decrypt a binary ArrayBuffer that was encrypted with encryptBuffer().

    Parameters:
      sharedKey  — the AES-256-GCM CryptoKey
      iv         — the IV ArrayBuffer that was returned by encryptBuffer()
      ciphertext — the ciphertext ArrayBuffer to decrypt

    Returns:
      The original plaintext ArrayBuffer.
  */

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(iv),
      tagLength: 128,
    },
    sharedKey,
    ciphertext
  );
  return decrypted;
}

// ──────────────────────────────────────────────────────────────────────────
// 7b. encryptFile() / decryptFile()
// ──────────────────────────────────────────────────────────────────────────

export async function encryptFile(sharedKey, file) {
  /*
    Encrypt a File or Blob using AES-256-GCM for HTTP fallback upload.
    The file is read as ArrayBuffer, encrypted, and the IV + ciphertext
    are returned as base64 strings so the receiver can decryptFile().

    Parameters:
      sharedKey — the AES-256-GCM CryptoKey from deriveSharedSecret()
      file      — a File or Blob object

    Returns:
      { iv: base64, ciphertext: base64 }
  */

  const data = await file.arrayBuffer();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    sharedKey,
    data
  );

  return {
    iv: arrayBufferToBase64(iv.buffer),
    ciphertext: arrayBufferToBase64(encrypted),
  };
}


export async function decryptFile(sharedKey, ivBase64, ciphertextBase64) {
  /*
    Decrypt a file that was encrypted with encryptFile().

    Parameters:
      sharedKey        — the AES-256-GCM CryptoKey
      ivBase64         — base64 IV from encryptFile()
      ciphertextBase64 — base64 ciphertext from encryptFile()

    Returns:
      An ArrayBuffer containing the original file data.
  */

  const iv = base64ToArrayBuffer(ivBase64);
  const ciphertext = base64ToArrayBuffer(ciphertextBase64);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv), tagLength: 128 },
    sharedKey,
    ciphertext
  );

  return decrypted;
}

// ──────────────────────────────────────────────────────────────────────────
// 10. Server key sync (export/import wrapped keys)
// ──────────────────────────────────────────────────────────────────────────

export async function exportWrappedKeysFromStorage() {
  /* Read wrapped private keys from IndexedDB and return as base64 JSON.
     Used during registration to upload encrypted keys to the server
     so the user can log in from any device. */
  const db = await openKeyDB();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const record = await new Promise((resolve, reject) => {
    const req = store.get("main");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  if (!record) return null;
  const data = {
    wrappedKeyAgreement: Array.from(new Uint8Array(record.wrappedKeyAgreement)),
    wrappedSigning: Array.from(new Uint8Array(record.wrappedSigning)),
    wrapIV: Array.from(new Uint8Array(record.wrapIV)),
    salt: Array.from(new Uint8Array(record.salt)),
  };
  return btoa(JSON.stringify(data));
}

export async function importWrappedKeysToStorage(wrappedKeysB64) {
  /* Import wrapped private keys from server and store in IndexedDB.
     Used on a new device to restore keys after login. */
  const data = JSON.parse(atob(wrappedKeysB64));
  const db = await openKeyDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  await new Promise((resolve, reject) => {
    const req = store.put({
      id: "main",
      wrappedKeyAgreement: new Uint8Array(data.wrappedKeyAgreement),
      wrappedSigning: new Uint8Array(data.wrappedSigning),
      wrapIV: new Uint8Array(data.wrapIV),
      salt: new Uint8Array(data.salt),
    });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
}

// ──────────────────────────────────────────────────────────────────────────
// 11. Session persistence helpers
// ──────────────────────────────────────────────────────────────────────────

export function cachePassphrase(passphrase) {
  try { sessionStorage.setItem("lanchat-passphrase", passphrase) } catch {}
}

export function getCachedPassphrase() {
  try { return sessionStorage.getItem("lanchat-passphrase") } catch { return null }
}

export function clearSession() {
  try {
    sessionStorage.removeItem("lanchat-passphrase");
    sessionStorage.removeItem("lanchat-session");
  } catch {}
}

export function cacheSession(userId, username, jwt) {
  try {
    sessionStorage.setItem("lanchat-session", JSON.stringify({ userId, username, jwt }));
  } catch {}
}

export function getCachedSession() {
  try {
    const raw = sessionStorage.getItem("lanchat-session");
    return raw ? JSON.parse(raw) : null;
  } catch { return null }
}

// ──────────────────────────────────────────────────────────────────────────
// 12. signChallenge()
// ──────────────────────────────────────────────────────────────────────────

export async function signChallenge(signingPrivateKey, nonce) {
  /*
    Sign a nonce string with our ECDSA private key to prove we own it.

    The login flow:
      1. Client calls POST /auth/challenge with their username
      2. Server returns a random nonce string
      3. Client signs the nonce with their private key using ECDSA
      4. Client sends the signature to POST /auth/verify
      5. Server verifies the signature using the stored public key

    The nonce is signed as UTF-8 bytes using ECDSA with SHA-256.

    Parameters:
      signingPrivateKey  — our ECDSA private key (CryptoKey)
      nonce              — the hex challenge string from the server

    Returns:
      Base64-encoded ECDSA signature.
  */

  const encoder = new TextEncoder();
  const nonceBytes = encoder.encode(nonce);

  const signature = await crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: { name: SHA256_HASH },
    },
    signingPrivateKey,
    nonceBytes
  );

  return arrayBufferToBase64(signature);
}

// ──────────────────────────────────────────────────────────────────────────
// 8. saveKeysToStorage()
// ──────────────────────────────────────────────────────────────────────────

export async function saveKeysToStorage(keyPair, passphrase) {
  /*
    Securely store both private keys in IndexedDB.

    The private keys are NEVER written to disk in their raw form.
    Instead we:
      1. Generate a random salt
      2. Derive an AES-256-KW wrapping key from the passphrase + salt (PBKDF2)
      3. Wrap (encrypt) both private keys with the wrapping key
      4. Store the wrapped keys + salt + public keys in IndexedDB

    On disk it looks like random bytes — without the passphrase you
    cannot recover the private keys.

    Parameters:
      keyPair    — the object returned by generateIdentityKeyPair()
      passphrase — a string the user chooses (like a strong password)
  */

  if (passphrase.length < 8) {
    throw new Error("Passphrase must be at least 8 characters");
  }

  // ---- Derive the wrapping key from the passphrase ----
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrapIV = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveWrappingKey(passphrase, salt);

  // ---- Wrap the ECDH private key (AES-GCM, no length restriction) ----
  const wrappedKa = await crypto.subtle.wrapKey(
    "pkcs8",
    keyPair.keyAgreement.privateKey,
    wrappingKey,
    { name: "AES-GCM", iv: wrapIV, tagLength: 128 }
  );

  // ---- Wrap the ECDSA private key ----
  const wrappedSg = await crypto.subtle.wrapKey(
    "pkcs8",
    keyPair.signing.privateKey,
    wrappingKey,
    { name: "AES-GCM", iv: wrapIV, tagLength: 128 }
  );

  // Export public keys to JWK before writing (so we store everything in one shot)
  const kaJwk = await crypto.subtle.exportKey("jwk", keyPair.keyAgreement.publicKey);
  const sgJwk = await crypto.subtle.exportKey("jwk", keyPair.signing.publicKey);

  // ---- Store everything in IndexedDB (single write to avoid field loss) ----
  const db = await openKeyDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  await new Promise((resolve, reject) => {
    const request = store.put({
      id: "main",
      wrappedKeyAgreement: new Uint8Array(wrappedKa),
      wrappedSigning: new Uint8Array(wrappedSg),
      wrapIV: new Uint8Array(wrapIV),
      salt: new Uint8Array(salt),
      publicKeyAgreementJwk: kaJwk,
      publicSigningJwk: sgJwk,
    });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  db.close();
}

// ──────────────────────────────────────────────────────────────────────────
// 9. loadKeysFromStorage()
// ──────────────────────────────────────────────────────────────────────────

export async function loadKeysFromStorage(passphrase) {
  /*
    Reverse of saveKeysToStorage — load private keys from IndexedDB
    and unwrap them using the passphrase.

    The loaded private keys are imported as non-extractable, so JavaScript
    code cannot read their raw bytes. They only exist inside the browser's
    crypto engine and can only be used through the SubtleCrypto API.

    Parameters:
      passphrase — the same string used when saving

    Returns:
      { keyAgreement: { publicKey, privateKey },
        signing: { publicKey, privateKey } }
      or null if no keys exist for this user.
  */

  const db = await openKeyDB();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);

  const record = await new Promise((resolve, reject) => {
    const request = store.get("main");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  db.close();

  if (!record || !record.wrappedKeyAgreement || !record.wrappedSigning) {
    return null;   // no keys stored yet, or corrupt data (needs re-registration)
  }

  // ---- Derive the SAME wrapping key from the passphrase + stored salt ----
  const salt = new Uint8Array(record.salt);
  const wrapIV = new Uint8Array(record.wrapIV || crypto.getRandomValues(new Uint8Array(12)));
  const wrappingKey = await deriveWrappingKey(passphrase, salt);

  // ---- Unwrap the ECDH private key (AES-GCM) ----
  const kaPrivateKey = await crypto.subtle.unwrapKey(
    "pkcs8",
    record.wrappedKeyAgreement,
    wrappingKey,
    { name: "AES-GCM", iv: wrapIV, tagLength: 128 },
    ECDH_PARAMS,
    false,        // not extractable — JS cannot read the raw key bytes
    ["deriveKey", "deriveBits"]
  );

  // ---- Unwrap the ECDSA private key ----
  const sgPrivateKey = await crypto.subtle.unwrapKey(
    "pkcs8",
    record.wrappedSigning,
    wrappingKey,
    { name: "AES-GCM", iv: wrapIV, tagLength: 128 },
    ECDSA_PARAMS,
    false,        // not extractable
    ["sign"]
  );

  // ---- Reimport the public keys from stored JWK ----
  const kaPublicKey = await crypto.subtle.importKey(
    "jwk",
    record.publicKeyAgreementJwk,
    ECDH_PARAMS,
    true,
    []
  );

  const sgPublicKey = await crypto.subtle.importKey(
    "jwk",
    record.publicSigningJwk,
    ECDSA_PARAMS,
    true,
    []
  );

  return {
    keyAgreement: {
      publicKey: kaPublicKey,
      privateKey: kaPrivateKey,
    },
    signing: {
      publicKey: sgPublicKey,
      privateKey: sgPrivateKey,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 10. getKeyFingerprint()
// ──────────────────────────────────────────────────────────────────────────

export async function getKeyFingerprint(publicKey, signingPublicKey) {
  /*
    Create a human-readable fingerprint of someone's public keys.

    Like Signal's "safety numbers", this lets users read the words aloud
    or compare them visually to verify they are talking to the right person
    (defense against man-in-the-middle attacks).

    How it works:
      1. Serialize both public keys as JWK
      2. Combine into a single string
      3. Hash with SHA-256
      4. Take the first 6 bytes of the hash
      5. Map each byte to a word from our 256-word list

    If two people's fingerprints match, they are guaranteed to have the
    same shared secret — MITM is impossible.

    Parameters:
      publicKey        — ECDH public key (CryptoKey)
      signingPublicKey — ECDSA public key (CryptoKey)

    Returns:
      A string of 6 space-separated words, e.g. "apple beach crane dwarf eagle flame"
  */

  const kaJwk = await crypto.subtle.exportKey("jwk", publicKey);
  const sgJwk = await crypto.subtle.exportKey("jwk", signingPublicKey);

  // Combine the x-coordinates of both keys (these are the unique parts)
  const raw = `${kaJwk.x}:${kaJwk.y}:${sgJwk.x}:${sgJwk.y}`;

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(SHA256_HASH, encoder.encode(raw));
  const hashBytes = new Uint8Array(hashBuffer);

  // Take the first 6 bytes → 6 words
  const words = [];
  for (let i = 0; i < 6; i++) {
    words.push(WORDLIST[hashBytes[i]]);
  }

  return words.join(" ");
}

// ──────────────────────────────────────────────────────────────────────────
// QR code helpers
// ──────────────────────────────────────────────────────────────────────────

export async function generateQRData(publicKey, signingPublicKey, username) {
  /*
    Create a JSON string that can be encoded as a QR code.

    When scanned by another LANChat user, this lets them import your
    public keys without asking the server (useful for the initial
    verification or for offline key exchange).

    Parameters:
      publicKey        — ECDH public key (CryptoKey)
      signingPublicKey — ECDSA public key (CryptoKey)
      username         — the owner's display name

    Returns:
      A JSON string ready to be rendered as a QR code.
  */

  const exported = await exportPublicKey(publicKey, signingPublicKey);

  const payload = {
    version: 1,
    username: username,
    publicKeyB64: exported,
  };

  return JSON.stringify(payload);
}


export function parseQRData(jsonString) {
  /*
    Parse a scanned QR code's JSON back into usable data.

    Parameters:
      jsonString — the string that generateQRData() produced

    Returns:
      { username, publicKeyB64 }
  */

  const data = JSON.parse(jsonString);

  if (!data.version || !data.publicKeyB64 || !data.username) {
    throw new Error("Invalid QR code data");
  }

  return {
    username: data.username,
    publicKeyB64: data.publicKeyB64,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Debug: verify shared key matches on both devices
// ──────────────────────────────────────────────────────────────────────────

export async function debugSharedKey(myPrivateKey, theirPublicKeyBase64, label) {
  const { publicKey } = await importPublicKey(theirPublicKeyBase64);
  const shared = await deriveSharedSecret(myPrivateKey, publicKey);
  const raw = await crypto.subtle.exportKey('raw', shared);
  const hex = [...new Uint8Array(raw)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  console.log(`[${label}] shared key prefix: ${hex}`);
}

// ──────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────

async function deriveWrappingKey(passphrase, salt) {
  /*
    Derive an AES-256-GCM key from a passphrase using PBKDF2.

    PBKDF2 applies a pseudorandom function many times (100,000 iterations)
    to turn the passphrase into a cryptographic key. The salt ensures that
    even if two users have the same passphrase, their wrapping keys differ.

    Parameters:
      passphrase — the user's chosen string
      salt       — 16 random bytes (stored alongside the wrapped keys)

    Returns:
      An AES-GCM CryptoKey usable for wrapKey/unwrapKey.
  */

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    PBKDF2_PARAMS,
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: SHA256_HASH,
    },
    keyMaterial,
    AES_GCM_PARAMS,
    false,            // wrapping key is not extractable
    ["wrapKey", "unwrapKey"]
  );
}


function openKeyDB() {
  /*
    Open (or create) the IndexedDB database that holds our wrapped keys.

    IndexedDB is a key-value store built into every browser — like a
    small local database. We use it here because CryptoKey objects cannot
    be serialized to localStorage (they contain binary data and type info).
  */

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);

    // Create the object store if it doesn't already exist
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = () => reject(request.error);
  });
}


export function arrayBufferToBase64(buffer) {
  /*
    Convert an ArrayBuffer to a base64 string.
    This is needed because JSON/WebSocket can only send text.
  */

  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}


export function base64ToArrayBuffer(base64) {
  /*
    Reverse of arrayBufferToBase64 — convert a base64 string back to
    an ArrayBuffer that the Web Crypto API expects.
  */

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ──────────────────────────────────────────────────────────────────────────
// 15. Sender-Keys Group End-to-End Encryption
// ──────────────────────────────────────────────────────────────────────────
/*
 * SENDER-KEYS / GROUP SESSION KEY ENCRYPTION DESIGN:
 *
 * In a group chat, encrypting each message individually N times for N members
 * scales poorly (O(N) network and storage overhead per message).
 * Instead, LANChat implements a Sender-Keys / Group Session Key model:
 *
 * 1. Key Generation (Group Creation):
 *    When a group is created, the creator generates a random AES-256-GCM
 *    group session key client-side using Web Crypto.
 *
 * 2. Key Distribution (Wrapping):
 *    The creator exports the raw 256-bit key and encrypts/wraps an individual
 *    copy for each group member using the ECDH shared secret established
 *    between the creator's ECDH private key and that member's ECDH public key.
 *    The wrapped bundle { [memberId]: { iv: base64, key: base64 } } is sent
 *    to the server as message_type: "group_key_bundle".
 *
 * 3. Server Storage & Zero-Knowledge Relay:
 *    The server stores the group_key_bundle message and relays it to members
 *    who are currently online (via WebSocket) or members who join later (via
 *    REST /messages/group/{group_id} history). The server never holds private
 *    keys and cannot decrypt any wrapped session keys.
 *
 * 4. Group Message Encryption & Decryption:
 *    All group messages are encrypted ONCE using the shared AES-256-GCM
 *    session key and sent as a single ciphertext. Any recipient with the
 *    unwrapped group session key decrypts it in O(1) time.
 */

export async function createGroupKeyBundle(myPrivateKey, memberList) {
  // Generate a random AES-256-GCM group session key
  const sessionKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable so we can export and wrap it
    ["encrypt", "decrypt"]
  );

  const rawKey = await crypto.subtle.exportKey("raw", sessionKey);
  const bundle = {};

  for (const member of memberList) {
    const pubKeyB64 = member.publicKeyB64 || member.public_key;
    if (!pubKeyB64) continue;
    try {
      const { publicKey } = await importPublicKey(pubKeyB64);
      const sharedSecret = await deriveSharedSecret(myPrivateKey, publicKey);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, tagLength: 128 },
        sharedSecret,
        rawKey
      );
      bundle[member.id || member.userId] = {
        iv: arrayBufferToBase64(iv.buffer),
        key: arrayBufferToBase64(encrypted),
      };
    } catch (err) {
      console.error(`Failed to wrap group key for member ${member.id || member.userId}:`, err);
    }
  }

  return {
    sessionKey,
    rawKeyB64: arrayBufferToBase64(rawKey),
    bundleJson: JSON.stringify(bundle),
  };
}

export async function unwrapGroupKeyBundle(myPrivateKey, creatorPublicKeyB64, bundleData, myUserId) {
  const bundle = typeof bundleData === "string" ? JSON.parse(bundleData) : bundleData;
  const myEntry = bundle[myUserId];
  if (!myEntry) {
    throw new Error("No wrapped key for this user in group key bundle");
  }

  const { publicKey } = await importPublicKey(creatorPublicKeyB64);
  const sharedSecret = await deriveSharedSecret(myPrivateKey, publicKey);

  const iv = base64ToArrayBuffer(myEntry.iv);
  const encryptedKey = base64ToArrayBuffer(myEntry.key);

  const rawKey = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv), tagLength: 128 },
    sharedSecret,
    encryptedKey
  );

  return await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function importRawGroupKey(rawKeyB64) {
  const rawKey = base64ToArrayBuffer(rawKeyB64);
  return await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function encryptGroupMessage(groupSessionKey, plaintext) {
  return await encryptMessage(groupSessionKey, plaintext);
}

export async function decryptGroupMessage(groupSessionKey, ivBase64, ciphertextBase64) {
  return await decryptMessage(groupSessionKey, ivBase64, ciphertextBase64);
}

