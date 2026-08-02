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
} from "../utils/crypto";

export function useEncryption() {
  const [identity, setIdentity] = useState(null);
  const sharedKeysRef = useRef({}); // cache: { userId: sharedKey }
  const identityRef = useRef(null); // synchronous mirror of identity

  function getIdentity() {
    return identityRef.current || identity;
  }

  const generateAndStore = useCallback(async (passphrase) => {
    const keyPair = await generateIdentityKeyPair();
    await saveKeysToStorage(keyPair, passphrase);
    identityRef.current = keyPair;
    setIdentity(keyPair);
    return keyPair;
  }, []);

  const unlock = useCallback(async (passphrase) => {
    const keyPair = await loadKeysFromStorage(passphrase);
    if (keyPair) {
      identityRef.current = keyPair;
      setIdentity(keyPair);
    }
    return keyPair;
  }, []);

  const getSharedKey = useCallback(
    async (theirPublicKeyB64) => {
      const id = getIdentity();
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
      const id = getIdentity();
      if (!id) throw new Error("No identity — unlock first");
      return signChallenge(id.signing.privateKey, nonce);
    },
    [identity]
  );

  const exportKeys = useCallback(async () => {
    const id = getIdentity();
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

  const signOut = useCallback(() => {
    identityRef.current = null;
    setIdentity(null);
    sharedKeysRef.current = {};
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
    sign,
    exportKeys,
    signOut,
  };
}
