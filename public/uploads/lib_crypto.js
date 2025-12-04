// public/lib_crypto.js -- stub for client crypto functions used by UI
window.cryptoHelpers = {
  // stub functions (replace with real implementations if needed)
  generateSaltHex: () => '00',
  deriveKey: async () => new Uint8Array([0]),
  encryptToBase64: async (text) => btoa(text),
  decryptFromBase64: async (b64) => atob(b64),
  textToU8: (t) => new TextEncoder().encode(t),
  u8ToText: (u) => new TextDecoder().decode(u)
};