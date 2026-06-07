declare module 'libsodium-wrappers' {
  const sodium: {
    ready: Promise<void>;
    crypto_secretbox_easy: (message: Uint8Array, nonce: Uint8Array, key: Uint8Array) => Uint8Array;
    crypto_secretbox_open_easy: (ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array) => Uint8Array;
    crypto_sign_detached: (message: Uint8Array, secretKey: Uint8Array) => Uint8Array;
    crypto_sign_verify_detached: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean;
  };
  export default sodium;
}
