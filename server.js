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
// 메인 서버(Spring Boot)가 내부망(Tailscale)을 통해 이 곳으로 토스 승인을 위임합니다.
// ---------------------------------------------------------
app.post('/api/payments/toss-confirm', async (req, res) => {
  const { paymentKey, orderId, amount } = req.body;

  console.log(`\n[1] 메인 서버로부터 승인 위임 수신 - OrderId: ${orderId}, Amount: ${amount}`);

  try {
    console.log(`[2] 토스페이먼츠 승인 API 호출 중...`);
    
    // Toss API V1 Confirm 엔드포인트
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

    console.log(`[3] 토스 승인 성공! 결제 완료됨 (Receipt: ${tossResponse.data.receipt?.url})`);

    // 메인 서버(Spring Boot)로 성공 결과 반환
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
