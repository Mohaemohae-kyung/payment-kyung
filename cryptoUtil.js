const forge = require('node-forge');

// 서버 시작 시 메모리에 1회 생성 (실무에서는 KMS나 안전한 저장소 사용)
const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
const publicKeyPem = forge.pki.publicKeyToPem(keypair.publicKey);
const privateKey = keypair.privateKey;

console.log('[Crypto] RSA-2048 비대칭키 쌍이 성공적으로 생성되었습니다.');

/**
 * 프론트엔드에 노출할 공개키 반환
 */
function getPublicKey() {
  return publicKeyPem;
}

/**
 * 클라이언트로부터 받은 하이브리드 암호문(RSA + AES)을 복호화
 * @param {Object} payload { encryptedAesKey, iv, cipherText }
 * @returns {Object} { plainData(JSON), aesKey, iv }
 */
function decryptHybrid(payload) {
  try {
    const { encryptedAesKey, iv, cipherText } = payload;

    // 1. RSA로 AES Key 복호화 (PKCS#1 v1.5)
    const encryptedAesKeyBytes = forge.util.decode64(encryptedAesKey);
    const decryptedBase64Str = privateKey.decrypt(encryptedAesKeyBytes);
    const aesKeyBytes = forge.util.decode64(decryptedBase64Str);

    // 2. AES-CBC 복호화
    const ivBytes = forge.util.decode64(iv);
    const cipherTextBytes = forge.util.decode64(cipherText);

    const decipher = forge.cipher.createDecipher('AES-CBC', aesKeyBytes);
    decipher.start({ iv: ivBytes });
    decipher.update(forge.util.createBuffer(cipherTextBytes));
    const result = decipher.finish();

    if (!result) {
      throw new Error('AES Decryption failed.');
    }

    const plainText = decipher.output.toString('utf8');
    const plainData = JSON.parse(plainText);

    return { plainData, aesKeyBytes, ivBytes };
  } catch (error) {
    console.error('[Crypto Error] 복호화 실패:', error);
    throw new Error('데이터 복호화 중 오류가 발생했습니다.');
  }
}

/**
 * 클라이언트가 제공했던 AES Key로 응답 데이터를 암호화 (양방향 E2E)
 * @param {Object} data 응답할 JSON 데이터
 * @param {String} aesKeyBytes 클라이언트가 제공한 AES Key
 * @param {String} ivBytes 클라이언트가 제공한 IV
 * @returns {String} Base64 인코딩된 CipherText
 */
function encryptResponse(data, aesKeyBytes, ivBytes) {
  try {
    const plainText = JSON.stringify(data);
    
    const cipher = forge.cipher.createCipher('AES-CBC', aesKeyBytes);
    cipher.start({ iv: ivBytes });
    cipher.update(forge.util.createBuffer(plainText, 'utf8'));
    cipher.finish();

    return forge.util.encode64(cipher.output.getBytes());
  } catch (error) {
    console.error('[Crypto Error] 응답 암호화 실패:', error);
    throw new Error('응답 데이터 암호화 중 오류가 발생했습니다.');
  }
}

module.exports = {
  getPublicKey,
  decryptHybrid,
  encryptResponse
};
