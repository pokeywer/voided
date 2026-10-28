// Backwards-compatible aliases. Linkvertise secrets now live in the shared
// gateway module so every provider uses the same encrypted storage format.
export { encryptGatewaySecret as encryptLinkvertiseToken, decryptGatewaySecret as decryptLinkvertiseToken } from './_gateway.js';
