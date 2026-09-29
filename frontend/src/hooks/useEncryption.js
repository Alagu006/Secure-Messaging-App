import { useState, useRef, useCallback } from "react";
import {
  generateIdentityKeyPair,
  saveKeysToStorage,
  loadKeysFromStorage,
  exportPublicKey,
  importPublicKey,
  deriveSharedSecret,
  encryptMessage,
  decryptMessage,
  encryptBuffer,
  decryptBuffer,
  signChallenge,
  getCachedPassphrase,
  clearSession,
  createGroupKeyBundle,
  unwrapGroupKeyBundle,
  importRawGroupKey,
  encryptGroupMessage,
  decryptGroupMessage,
  saveGroupKeyToStorage,
  loadGroupKeyFromStorage,
  arrayBufferToBase64,
} from "../utils/crypto";

export function useEncryption(initialKeyPair = null) {
  const [identity, setIdentity] = useState(initialKeyPair);
  const sharedKeysRef = useRef({}); // cache: { userId: sharedKey }
  const groupKeysRef = useRef({}); // cache: { groupId: groupSessionKey }
  const identityRef = useRef(initialKeyPair); // synchronous mirror of identity

  async function getIdentity() {
    if (identityRef.current) return identityRef.current;
    if (identity) return identity;
    const passphrase = getCachedPassphrase();
    if (passphrase) {
      try {
        const keyPair = await loadKeysFromStorage(passphrase);
        if (keyPair) {
          identityRef.current = keyPair;
          setIdentity(keyPair);
          return keyPair;
        }
      } catch {}
    }
    return null;
  }

  const generateAndStore = useCallback(async (passphrase) => {
    const keyPair = await generateIdentityKeyPair();
    await saveKeysToStorage(keyPair, passphrase);
    identityRef.current = keyPair;
    setIdentity(keyPair);
    return keyPair;
  }, []);

  const unlock = useCallback(async (passphrase) => {
    try {
      const keyPair = await loadKeysFromStorage(passphrase);
      if (keyPair) {
        identityRef.current = keyPair;
        setIdentity(keyPair);
      }
      return keyPair;
    } catch {
      return null;
    }
  }, []);

  const getSharedKey = useCallback(
    async (theirPublicKeyB64) => {
      const id = await getIdentity();
      if (!id) return null;
      const cacheKey = theirPublicKeyB64;
      if (sharedKeysRef.current[cacheKey]) return sharedKeysRef.current[cacheKey];

      const { publicKey } = await importPublicKey(theirPublicKeyB64);
      const sharedKey = await deriveSharedSecret(
        id.keyAgreement.privateKey,
        publicKey
      );
      sharedKeysRef.current[cacheKey] = sharedKey;
      return sharedKey;
    },
    [identity]
  );

  const encrypt = useCallback(
    async (theirPublicKeyB64, plaintext) => {
      const sharedKey = await getSharedKey(theirPublicKeyB64);
      if (!sharedKey) throw new Error("No shared key — unlock first");
      return encryptMessage(sharedKey, plaintext);
    },
    [getSharedKey]
  );

  const decrypt = useCallback(
    async (theirPublicKeyB64, iv, ciphertext) => {
      const sharedKey = await getSharedKey(theirPublicKeyB64);
      if (!sharedKey) throw new Error("No shared key — unlock first");
      return decryptMessage(sharedKey, iv, ciphertext);
    },
    [getSharedKey]
  );

  const encryptBufferData = useCallback(
    async (theirPublicKeyB64, data) => {
      const sharedKey = await getSharedKey(theirPublicKeyB64);
      if (!sharedKey) throw new Error("No shared key — unlock first");
      return encryptBuffer(sharedKey, data);
    },
    [getSharedKey]
  );

  const decryptBufferData = useCallback(
    async (theirPublicKeyB64, iv, ciphertext) => {
      const sharedKey = await getSharedKey(theirPublicKeyB64);
      if (!sharedKey) throw new Error("No shared key — unlock first");
      return decryptBuffer(sharedKey, iv, ciphertext);
    },
    [getSharedKey]
  );

  const sign = useCallback(
    async (nonce) => {
      const id = await getIdentity();
      if (!id) throw new Error("No identity — unlock first");
      return signChallenge(id.signing.privateKey, nonce);
    },
    [identity]
  );

  const exportKeys = useCallback(async () => {
    const id = await getIdentity();
    if (!id) return null;
    return exportPublicKey(
      id.keyAgreement.publicKey,
      id.signing.publicKey
    );
  }, [identity]);

  const sessionRestore = useCallback(async () => {
    const passphrase = getCachedPassphrase();
    if (!passphrase) return null;
    const keyPair = await loadKeysFromStorage(passphrase);
    if (keyPair) {
      identityRef.current = keyPair;
      setIdentity(keyPair);
    }
    return keyPair;
  }, []);

  const setKeyPair = useCallback((keyPair) => {
    if (keyPair) {
      identityRef.current = keyPair;
      setIdentity(keyPair);
    }
  }, []);

  const generateGroupBundle = useCallback(async (memberList) => {
    const id = await getIdentity();
    if (!id) throw new Error("No identity — unlock first");
    return createGroupKeyBundle(id.keyAgreement.privateKey, memberList);
  }, []);

  const setGroupKey = useCallback(async (groupId, key, rawKeyB64 = null) => {
    groupKeysRef.current[groupId] = key;
    if (rawKeyB64) {
      await saveGroupKeyToStorage(groupId, rawKeyB64);
    } else {
      try {
        const raw = await crypto.subtle.exportKey("raw", key);
        await saveGroupKeyToStorage(groupId, arrayBufferToBase64(raw));
      } catch {}
    }
  }, []);

  const getGroupKey = useCallback(async (groupId) => {
    if (groupKeysRef.current[groupId]) return groupKeysRef.current[groupId];
    const savedRaw = await loadGroupKeyFromStorage(groupId);
    if (savedRaw) {
      try {
        const key = await importRawGroupKey(savedRaw);
        groupKeysRef.current[groupId] = key;
        return key;
      } catch {}
    }
    return null;
  }, []);

  const unwrapAndStoreGroupKey = useCallback(async (groupId, creatorPublicKeyB64, bundleData, myUserId) => {
    const id = await getIdentity();
    if (!id) throw new Error("No identity — unlock first");
    const key = await unwrapGroupKeyBundle(
      id.keyAgreement.privateKey,
      creatorPublicKeyB64,
      bundleData,
      myUserId
    );
    groupKeysRef.current[groupId] = key;
    try {
      const raw = await crypto.subtle.exportKey("raw", key);
      await saveGroupKeyToStorage(groupId, arrayBufferToBase64(raw));
    } catch {}
    return key;
  }, []);

  const encryptGroup = useCallback(async (groupId, plaintext) => {
    let key = groupKeysRef.current[groupId] || (await getGroupKey(groupId));
    if (!key) throw new Error(`No group key found for group ${groupId}`);
    return encryptGroupMessage(key, plaintext);
  }, [getGroupKey]);

  const decryptGroup = useCallback(async (groupId, iv, ciphertext) => {
    let key = groupKeysRef.current[groupId] || (await getGroupKey(groupId));
    if (!key) throw new Error(`No group key found for group ${groupId}`);
    return decryptGroupMessage(key, iv, ciphertext);
  }, [getGroupKey]);

  const signOut = useCallback(() => {
    identityRef.current = null;
    setIdentity(null);
    sharedKeysRef.current = {};
    groupKeysRef.current = {};
    clearSession();
  }, []);

  return {
    identity,
    generateAndStore,
    unlock,
    sessionRestore,
    setKeyPair,
    encrypt,
    decrypt,
    getSharedKey,
    encryptBuffer: encryptBufferData,
    decryptBuffer: decryptBufferData,
    generateGroupBundle,
    setGroupKey,
    getGroupKey,
    unwrapAndStoreGroupKey,
    encryptGroup,
    decryptGroup,
    sign,
    exportKeys,
    signOut,
  };
}
