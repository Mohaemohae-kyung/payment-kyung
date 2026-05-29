require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const forge = require('node-forge');
const { getPublicKey, decryptHybrid, encryptResponse } = require('./cryptoUtil');

const app = express();
app.use(express.json());
app.use(cors());

// Toss Payments Secret Key 설정
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;
const tossAuthorizationHeader = `Basic ${Buffer.from(TOSS_SECRET_KEY + ':').toString('base64')}`;
const MAIN_SERVER_URL = process.env.MAIN_SERVER_URL || 'http://localhost:8080';

// In-memory Database for Transactions (Since Spring Boot is pure proxy)
const transactionDb = {};

// =========================================================
// 1. RSA 공개키 제공 API
// =========================================================
app.get('/api/crypto/public-key', (req, res) => {
  res.json({ publicKey: getPublicKey() });
});

// =========================================================
// 2. 결제 준비 (E2E 복호화 -> 로직 -> 응답 암호화)
// =========================================================
app.post('/api/payments/prepare', async (req, res) => {
  try {
    console.log('\n[Node Payment Server] /prepare 호출 됨');
    const userId = req.body.userId;
    
    // 1) E2E 해독
    const { plainData, aesKeyBytes, ivBytes } = decryptHybrid(req.body);
    
    // 2) Spring Boot 내부 API로 원가 조회 (프록시 백엔드에 요청)
    let url = `${MAIN_SERVER_URL}/api/payments/internal/target-info?targetType=${plainData.targetType}&targetId=${plainData.targetId}&userId=${userId}`;
    if (plainData.userCouponId) {
        url += `&userCouponId=${plainData.userCouponId}`;
    }
    
    const infoRes = await axios.get(url);
    const { baseAmount, discountAmount, orderName } = infoRes.data;

    // 3) [취약점 발현 로직] 클라이언트가 웰컴 쿠폰 금액을 변조해서 보낸 경우 그대로 신뢰
    let finalAmount = baseAmount;
    if (plainData.welcomeDiscountAmount != null && plainData.welcomeDiscountAmount !== '') {
        const fakeDiscount = Number(plainData.welcomeDiscountAmount);
        console.log(`⚠️ [VULNERABILITY] Client provided welcomeDiscountAmount trusted: ${fakeDiscount}`);
        finalAmount = Math.max(0, baseAmount - fakeDiscount);
    } else {
        // 일반 쿠폰 정상 로직
        finalAmount = Math.max(0, baseAmount - discountAmount);
    }

    // 4) Order ID 생성 및 DB 기록
    const orderId = `${plainData.targetType}-${plainData.targetId}-${Date.now()}`;
    transactionDb[orderId] = {
        targetType: plainData.targetType,
        targetId: plainData.targetId,
        userId: userId,
        userCouponId: plainData.userCouponId,
        paymentMethod: plainData.paymentMethod,
        pgProvider: plainData.pgProvider,
        baseAmount,
        finalAmount,
        orderName,
        status: 'READY'
    };
    
    console.log(`[Node Payment Server] Transaction 생성 완료: ${orderId}, 최종 승인 금액: ${finalAmount}`);

    // 5) Spring Boot로 결제 준비 데이터 전송하여 채팅 메시지 생성 요청 (채팅창 결제 시)
    try {
        await axios.post(`${MAIN_SERVER_URL}/api/payments/internal/ready`, {
            targetType: plainData.targetType,
            targetId: plainData.targetId,
            userId: userId,
            userCouponId: plainData.userCouponId,
            orderId: orderId,
            finalAmount: finalAmount,
            paymentMethod: plainData.paymentMethod,
            pgProvider: plainData.pgProvider
        });
    } catch (err) {
        console.error('[Node Payment Server] Spring Boot 내부 ready 통신 오류:', err.message);
    }

    // 6) 프론트엔드 모달에 보여줄 응답 구성 및 암호화
    const responseData = {
        orderId,
        finalAmount,
        orderName
    };
    
    const cipherText = encryptResponse(responseData, aesKeyBytes, ivBytes);

    return res.json({
      success: true,
      cipherText
    });
  } catch (error) {
    console.error('[Prepare 오류]', error.message);
    res.status(400).json({ success: false, message: error.message });
  }
});

// =========================================================
// 3. 결제 승인 (E2E 복호화 -> 2차 검증 -> Toss 승인 -> Spring Boot 결제 완료 통보)
// =========================================================
app.post('/api/payments/confirm', async (req, res) => {
  try {
    console.log('\n[Node Payment Server] /confirm 호출 됨');
    
    // 1) E2E 해독
    const { plainData, aesKeyBytes, ivBytes } = decryptHybrid(req.body);
    const { paymentKey, orderId, amount } = plainData;

    // 2) 메모리 DB에서 트랜잭션 찾기
    const tx = transactionDb[orderId];
    if (!tx) {
        throw new Error("Transaction을 찾을 수 없습니다.");
    }

    // [보안 2차 검증 취약점 발현]
    // 일반 쿠폰은 백엔드에 다시 물어봐서 원가를 대조해야 하지만, 웰컴 쿠폰은 생략함
    if (tx.userCouponId != null) {
        const infoRes = await axios.get(`${MAIN_SERVER_URL}/api/payments/internal/target-info?targetType=${tx.targetType}&targetId=${tx.targetId}&userId=${tx.userId}&userCouponId=${tx.userCouponId}`);
        const realFinalAmount = Math.max(0, infoRes.data.baseAmount - infoRes.data.discountAmount);
        if (realFinalAmount !== tx.finalAmount) {
            throw new Error("쿠폰 할인액 위조 감지 (2차 검증 실패)");
        }
    } else {
        console.log("⚠️ [VULNERABILITY] Confirm phase: No secondary validation for welcome discount! Trusting memory finalAmount.");
    }

    if (tx.finalAmount !== Number(amount)) {
        throw new Error("결제 승인 요청 금액이 서버의 승인 대기 금액과 일치하지 않습니다.");
    }

    // 3) 토스 페이먼츠 결제 승인 API 직접 호출
    console.log(`[Node Payment Server] 토스페이먼츠 승인 요청: ${amount}원`);
    const tossResponse = await axios.post(
      'https://api.tosspayments.com/v1/payments/confirm',
      { paymentKey, orderId, amount },
      {
        headers: {
          Authorization: tossAuthorizationHeader,
          'Content-Type': 'application/json',
        },
      }
    );

    // 4) 결제 성공 시 Spring Boot 내부 API를 찔러서 DB에 PAID 처리 지시
    console.log(`[Node Payment Server] 결제 승인 성공. Spring Boot DB 반영 요청`);
    await axios.post(`${MAIN_SERVER_URL}/api/payments/internal/complete`, {
        targetType: tx.targetType,
        targetId: tx.targetId,
        userId: tx.userId,
        orderId: orderId,
        finalAmount: tx.finalAmount,
        paymentKey: paymentKey,
        paymentMethod: tx.paymentMethod,
        pgProvider: tx.pgProvider,
        userCouponId: tx.userCouponId
    });

    tx.status = 'PAID';

    // 5) 결과 암호화 후 반환
    const cipherText = encryptResponse(tossResponse.data, aesKeyBytes, ivBytes);

    return res.json({
      success: true,
      cipherText
    });
  } catch (error) {
    const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error(`[Confirm 오류]`, errorMsg);
    res.status(error.response ? error.response.status : 400).json({ 
      success: false, 
      message: errorMsg 
    });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`=========================================`);
  console.log(`✅ [결제 전담 서버] 양방향 E2E 통제 및 검증 서버 실행 (Node.js)`);
  console.log(`✅ [포트] http://localhost:${port}`);
  console.log(`=========================================`);
});
