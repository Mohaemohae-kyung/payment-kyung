require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// 테스트 페이지 서빙 (Toss 리다이렉트를 위해 http://localhost:8081/ 환경 제공)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'));
});

// Toss Payments Secret Key 설정
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;
// Basic Auth 인증 헤더 (시크릿 키 뒤에 콜론(:)을 붙이고 Base64 인코딩)
const tossAuthorizationHeader = `Basic ${Buffer.from(TOSS_SECRET_KEY + ':').toString('base64')}`;

const MAIN_SERVER_URL = process.env.MAIN_SERVER_URL || 'https://can-fly.shop';

// ---------------------------------------------------------
// [결제 서버] 결제 승인 API 엔드포인트
// 프론트엔드가 토스 결제창 인증을 마치고 paymentKey를 받아오면 여기로 보냅니다.
// ---------------------------------------------------------
app.post('/api/payments/confirm', async (req, res) => {
  const { paymentKey, orderId, amount } = req.body;

  console.log(`\n[1] 결제 승인 요청 수신 - OrderId: ${orderId}, Amount: ${amount}`);

  // =========================================================================
  // --- [보안 교차 검증 로직 시작] ---
  // 이 부분이 없다면? -> 프론트에서 해커가 amount를 100원으로 조작해서 보내면 그대로 100원이 결제승인됨!
  // 이 부분이 있다면? -> 메인 서버 DB에 저장된 진짜 가격과 비교해서 위변조를 막음!
  // =========================================================================
  // try {
  //   console.log(`[2] 메인 서버(${MAIN_SERVER_URL})에 진짜 주문 금액 확인 요청...`);
    
  //   // 메인 서버 담당자가 만들어줄 "주문 정보 조회 API" 호출 (가상)
  //   // const response = await axios.get(`${MAIN_SERVER_URL}/api/internal/orders/${orderId}`);
  //   // const expectedAmount = response.data.amount;

  //   // TODO: 위 코드는 메인 서버(Back-Kyung)의 API가 완성되면 주석을 해제하세요.
  //   // 지금은 테스트를 위해 검증 로직을 시뮬레이션(가짜로 동작)합니다.
  //   const expectedAmount = Number(amount); // (테스트용: 무조건 맞다고 가정)
    
  //   if (Number(amount) !== expectedAmount) {
  //     console.error(`[보안 경고] 금액 위변조 의심! 프론트 전달 금액: ${amount}, 실제 금액: ${expectedAmount}`);
  //     return res.status(400).json({ error: '금액 위변조가 의심되어 결제가 거절되었습니다.' });
  //   }
  //   console.log(`[3] 메인 서버 금액 검증 통과 (금액 일치: ${amount}원)`);
  // } catch (error) {
  //   console.error('[오류] 메인 서버 금액 검증 실패', error.message);
  //   return res.status(500).json({ error: '메인 서버와 통신 중 오류가 발생했습니다.' });
  // }
  // --- [보안 교차 검증 로직 끝] ---
  // =========================================================================


  // =========================================================================
  // --- [토스페이먼츠 최종 승인 (Capture) API 호출] ---
  // 시크릿 키는 이 결제 서버만 가지고 있으므로 안전하게 승인할 수 있습니다.
  // =========================================================================
  try {
    console.log(`[4] 토스페이먼츠(Test) 승인 API 호출 중...`);
    
    // Toss API V1 Confirm 엔드포인트
    // (V2를 쓰신다면 https://api.tosspayments.com/v2/payments/confirm 사용 가능)
    const tossResponse = await axios.post(
      'https://api.tosspayments.com/v1/payments/confirm',
      {
        paymentKey: paymentKey,
        orderId: orderId,
        amount: amount,
      },
      {
        headers: {
          Authorization: tossAuthorizationHeader,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`[5] 토스 승인 성공! 결제 완료됨 (Receipt: ${tossResponse.data.receipt?.url})`);

    // =========================================================================
    // --- [결제 완료 상태 동기화] ---
    // 토스 승인이 떨어지면 메인 서버에 "이 주문 결제 완료(PAID)로 상태 바꿔줘" 라고 알려줍니다.
    // =========================================================================
    try {
      console.log(`[6] 메인 서버(${MAIN_SERVER_URL})에 결제 완료(PAID) 상태 업데이트 요청...`);
      await axios.post(`${MAIN_SERVER_URL}/api/payments/confirm`, {
        paymentKey: paymentKey,
        orderId: orderId,
        amount: Number(amount)
      });
      console.log(`[7] 메인 서버 동기화 완료! 프론트로 최종 성공 응답 반환`);
    } catch (syncError) {
      console.error('[오류] 메인 서버에 결제 완료 상태를 동기화하지 못했습니다.', syncError.message);
      // 참고: 동기화 실패하면 재시도 작업(Reconciliation)이나 결제 취소(Rollback) 처리가 필요할 수 있습니다.
    }

    // 프론트엔드로 성공 결과 반환
    return res.status(200).json({
      success: true,
      message: '결제가 성공적으로 완료되었습니다.',
      data: tossResponse.data,
    });

  } catch (error) {
    // 토스 승인 거절 (예: 잔액 부족, 카드 한도 초과 등)
    console.error(`[오류] 토스 결제 승인 실패:`, error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || '결제 승인 중 오류가 발생했습니다.',
    });
  }
});

const port = process.env.PORT || 8081; // 메인 서버가 8080을 쓸 수 있으므로 8081로 기본 설정
app.listen(port, () => {
  console.log(`=========================================`);
  console.log(`✅ [결제 서버] Payment Server가 실행되었습니다.`);
  console.log(`✅ [포트] http://localhost:${port}`);
  console.log(`=========================================`);
});
