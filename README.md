# Toss Payments Node.js Payment Server (payment-kyung)

이 프로젝트는 토스페이먼츠(Toss Payments) API 연동을 중개하고 안전한 결제 승인 및 메인 백엔드(`Back-Kyung`)와의 결제 데이터 동기화를 처리하는 전용 Node.js 결제 서버입니다.

## 아키텍처 개요

```
[ Frontend (React) ] 
       │  
       ├─ (1) 결제창 호출 및 사용자 결제 완료
       ▼
[ Frontend (React) ] ── (2) 결제 승인 요청 (Redirect / Success) ──► [ Payment Server (Node.js) ]
                                                                             │
                                                                   (3) 토스 승인 API 호출 (Secret Key)
                                                                   (4) 결제 성공 시 메인 백엔드로 동기화
                                                                             │
                                                                             ▼
                                                                  [ Main Backend (Spring Boot) ]
```

1. **결제창 요청**: 프론트엔드(`front`)에서 토스페이먼츠 SDK를 이용해 결제창을 띄우고 결제를 완료합니다.
2. **리다이렉트 및 승인 요청**: 결제가 완료되면 토스에서 `PaymentSuccess` 페이지로 리다이렉트하며, 이 페이지에서 본 결제 서버(`payment-server`)의 `/api/payments/confirm` API로 승인 동기화 요청을 보냅니다.
3. **토스 승인 API 호출**: 결제 서버가 안전하게 시크릿 키(`TOSS_SECRET_KEY`)를 사용하여 토스페이먼츠 승인 API를 호출합니다.
4. **메인 백엔드 상태 동기화**: 결제가 성공적으로 승인되면, 메인 백엔드(`Back-Kyung` / `https://can-fly.shop`)에 결제 정보(`orderId`, `paymentKey`, `amount`)를 전송하여 주문 상태를 즉시 `PAID`로 변경하고 예약을 확정합니다.

---

## 주요 기능

- **보안 강화**: 프론트엔드에 시크릿 키가 노출되지 않도록 서버 측에서 토스페이먼츠 API와 통신합니다.
- **상태 동기화**: 결제 성공 시 메인 백엔드 서버로 즉시 결제 완료 전문을 전달하여 데이터 일치성을 보장합니다.
- **에러 핸들링**: 토스페이먼츠의 에러 응답 및 네트워크 예외 상황을 프론트엔드에 알기 쉬운 에러 메세지로 반환합니다.

---

## 시작하기 (Getting Started)

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경 변수 설정
루트 디렉토리에 `.env` 파일을 생성하고 아래와 같이 설정합니다. (템플릿으로 `.env.example` 파일을 참고하세요.)

```env
# 서버 포트
PORT=4000

# 토스페이먼츠 시크릿 키 (테스트용 또는 라이브용)
TOSS_SECRET_KEY=your_toss_secret_key_here

# 메인 백엔드(Spring Boot) API 주소
MAIN_SERVER_URL=https://can-fly.shop
```

### 3. 개발 서버 실행
```bash
npm start
```
또는
```bash
node server.js
```

### 4. 프로덕션 환경 백그라운드 실행 (PM2 권장)
서버가 꺼지지 않고 백그라운드에서 상시 작동하도록 **PM2**를 사용하여 관리하는 것을 적극 권장합니다.

```bash
# PM2 글로벌 설치
npm install -g pm2

# 결제 서버 백그라운드 실행 및 프로세스 등록
pm2 start server.js --name "payment-server"

# 서버 재부팅 시 자동 실행 설정
pm2 startup
pm2 save

# 서버 모니터링 및 로그 확인
pm2 status
pm2 logs payment-server
```

---

## API 스펙

### 결제 승인 요청 (Confirm Payment)

- **URL**: `/api/payments/confirm`
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
```json
{
  "paymentKey": "tgen_20260528092026123456",
  "orderId": "BOOKING-1-20260528092026-ab12cd34",
  "amount": 66000
}
```
- **Response**:
  - **성공 (200 OK)**: 토스페이먼츠 승인 결과 데이터와 메인 백엔드 동기화 결과를 반환합니다.
  - **실패 (400/500)**: 에러 사유와 메시지를 반환합니다.
