# 보안 운영 가이드 (URLATE-v3l-backend)

이 문서는 백엔드 서버를 안전하게 운영하기 위해 애플리케이션 밖(리버스 프록시,
배포 환경)에서 반드시 갖추어야 하는 설정을 정리합니다. 애플리케이션 코드에서
처리하는 항목은 소스에 주석으로 표기되어 있습니다.

## 1. 리버스 프록시 / TLS

백엔드는 HTTPS를 종단하는 리버스 프록시(nginx 등) 뒤에서 동작하는 것을 전제로 합니다.

- 애플리케이션은 `app.set("trust proxy", 1)`로 설정되어 있어, 프록시가 전달하는
  `X-Forwarded-Proto` 헤더를 신뢰해 세션 쿠키의 `secure` 플래그가 정상 동작합니다.
- 따라서 프록시는 **반드시 `X-Forwarded-Proto`(및 `X-Forwarded-For`)를 올바르게
  전달**해야 합니다. 그렇지 않으면 production 모드에서 secure 쿠키가 설정되지 않아
  로그인이 실패할 수 있습니다.
- `config.project.mode`가 `"production"`(기본값)일 때 세션 쿠키에 `secure: true`가
  적용됩니다. 로컬 HTTP 개발 환경에서는 `"test"`로 설정하세요.

## 2. CORS

CORS 헤더는 **리버스 프록시에서 처리**합니다. 애플리케이션은 CORS 헤더를
설정하지 않으므로, 프록시에서 다음 원칙을 지켜야 합니다.

- `Access-Control-Allow-Origin`은 **와일드카드(`*`)를 사용하지 않고**, 신뢰하는
  프론트엔드 오리진(`config.project.url`, 예: `https://example.com`)만 허용합니다.
- 세션 쿠키를 사용하므로 `Access-Control-Allow-Credentials: true`가 필요합니다.
  이때 `Access-Control-Allow-Origin`은 반드시 특정 오리진이어야 하며 `*`와 함께
  쓸 수 없습니다.
- 허용 오리진이 여러 개(운영/스테이징)라면 요청 `Origin`을 화이트리스트와 대조해
  일치할 때만 반영하세요.
- 앱과 프록시가 **동시에** CORS 헤더를 넣으면 헤더가 중복되어 브라우저가 요청을
  차단합니다. CORS는 프록시 한 곳에서만 처리해야 합니다.

### nginx 예시

```nginx
# 신뢰 오리진만 허용
set $cors_origin "";
if ($http_origin = "https://example.com") { set $cors_origin $http_origin; }

add_header Access-Control-Allow-Origin  $cors_origin always;
add_header Access-Control-Allow-Credentials "true" always;
add_header Vary Origin always;

proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header Host              $host;
```

## 3. 세션 쿠키

애플리케이션에서 다음 플래그를 설정합니다(코드 참조).

- `httpOnly: true` — JavaScript 접근 차단(XSS로 인한 세션 탈취 완화)
- `secure: <production>` — HTTPS 전용 전송
- `sameSite: "lax"` — CSRF 완화. 프론트엔드와 API가 같은 상위 도메인(eTLD+1)을
  공유해야 쿠키가 전송됩니다(예: `example.com` ↔ `api.example.com`).

## 4. Rate limiting

Redis 기반 IP별 rate limit이 적용되어 있습니다.

- 전역: IP당 분당 600회
- `/auth/login`: 5분당 20회
- `/coupon`: 5분당 30회

프록시가 여러 대의 백엔드로 로드밸런싱하더라도 카운터는 Redis에서 공유됩니다.
정확한 IP 식별을 위해 프록시의 `X-Forwarded-For` 전달이 필요합니다.

## 5. 알려진 잔여 리스크

- **점수(record) 무결성**: `/playRecord`는 판정 카운트/정확도/랭크의 서버측
  정합성 검증과 점수 상한 검증을 수행하지만, 최종 점수 값 자체는 여전히
  클라이언트 계산값입니다. 완전한 치팅 방지에는 입력 리플레이 재생을 통한
  서버 권위 점수 재계산이 필요하며, 이는 후속 과제입니다.
