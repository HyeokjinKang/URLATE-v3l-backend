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

게임 서버(`URLATE-v3l-game`)는 **같은 세션 저장소를 공유**하므로 쿠키 옵션도
동일해야 합니다. 한쪽이라도 옵션이 다르면 같은 세션 ID가 다른 속성으로 다시
내려가 서로를 가릴 수 있습니다.

로그아웃은 `session.destroy()`로 저장소에서 세션을 제거하고 쿠키도 회수합니다.

## 4. CSRF

상태 변경 요청(`GET`/`HEAD`/`OPTIONS` 외)은 `Origin`(없으면 `Referer`)이
`config.project.url` 또는 `config.project.api`와 일치할 때만 통과합니다.

- `Origin`과 `Referer`가 **모두 없는** 요청은 통과시킵니다. 브라우저는 상태
  변경 요청에 `Origin`을 반드시 붙이므로, 이 경우는 서버 간 호출이며 해당
  경로는 project secret으로 따로 인증합니다.
- `GET /auth/logout`은 최상위 내비게이션용이라 GET을 유지하지만, 출처를 직접
  확인해 로그아웃 CSRF를 막습니다. 새 클라이언트는 `POST /auth/logout`을
  쓰세요.
- 프록시가 `Origin`/`Referer` 헤더를 제거하면 안 됩니다.

## 5. Rate limiting

Redis 기반 IP별 rate limit이 적용되어 있습니다.

- 전역: IP당 분당 600회
- `/auth/login`: 5분당 20회
- `/coupon`: 5분당 30회

프록시가 여러 대의 백엔드로 로드밸런싱하더라도 카운터는 Redis에서 공유됩니다.
정확한 IP 식별을 위해 프록시의 `X-Forwarded-For` 전달이 필요합니다.

## 6. Redis 장애 시 동작

Redis 클라이언트는 `disableOfflineQueue`로 동작합니다. 연결이 끊긴 동안의
명령은 큐에 쌓이지 않고 즉시 실패하며, 각 계층이 폴백합니다.

- 캐시: DB 직접 조회
- rate limit: 통과(가용성 우선)
- 순위: `users` 테이블 `COUNT(*)` 폴백
- **세션: 폴백이 없습니다.** Redis가 없으면 로그인 상태를 읽을 수 없어 인증이
  필요한 요청이 실패합니다. Redis는 가용성 구성이 필요한 구성 요소입니다.

기동 시 Redis 연결은 최대 5초만 기다리고, 실패해도 포트는 엽니다.
`SIGTERM`/`SIGINT`에서는 진행 중인 요청을 처리한 뒤 DB·Redis 연결을 정리합니다
(최대 10초, 초과 시 강제 종료). pm2의 `kill_timeout`은 이보다 길어야 합니다.

## 7. 다중 인스턴스

`node-schedule`은 프로세스마다 독립적으로 동작합니다. PM2를 cluster 모드로
올릴 경우를 대비해, 하루 한 번 도는 작업(랭크 갱신, 로그 정리)은 Redis의
날짜 단위 락(`src/job-lock.ts`)으로 한 인스턴스만 실행합니다.

## 8. 데이터베이스 인덱스

스키마를 코드로 관리하지 않으므로, 소스의 쿼리 패턴에서 도출한 권장 인덱스를
`schema/indexes.sql`에 정리해 두었습니다. 순위표와 개인 기록 조회는 인덱스가
없으면 `trackRecords` 전체를 훑습니다. 운영 DB에 한 번 적용하세요.

## 9. project secret

`project.secretKey`는 프론트엔드 서버가 백엔드의 프로필 이미지 갱신
(`PUT /profile/picture`, `PUT /profile/background`)을 호출할 때 쓰는 서버 간
자격 증명입니다.

- 이 값은 **서버끼리만** 공유해야 하며 브라우저로 내려보내면 안 됩니다.
- 비교는 `crypto.timingSafeEqual` 기반입니다(`src/secret.ts`).
- `alias`/`banner`처럼 사용자가 직접 바꾸는 값은 secret이 아니라 **세션**으로
  인가합니다. 두 요소는 secret만으로 임의 userid를 지정할 수 없습니다.
- 노출이 의심되면 세 저장소(백엔드/프론트엔드/게임 서버)의 설정을 동시에
  교체해야 합니다.

## 10. 리플레이 로그 보존

`/playRecord`는 플레이당 리플레이 로그 파일 하나를 `logs/` 아래에 남깁니다.

- 기본 보관 기간은 14일이며 매일 04:30에 만료분을 삭제합니다.
- `project.replayLogRetentionDays`로 조정할 수 있고, `0`이면 로그를 남기지
  않습니다.
- 로그에는 닉네임과 플레이 입력이 포함되므로, 별도 백업을 두는 경우 같은
  보존 기준을 적용하세요.

## 11. 알려진 잔여 리스크

- **점수(record) 무결성**: `/playRecord`는 판정 카운트/정확도/랭크의 서버측
  정합성 검증과 점수 상한 검증을 수행하지만, 최종 점수 값 자체는 여전히
  클라이언트 계산값입니다. 완전한 치팅 방지에는 입력 리플레이 재생을 통한
  서버 권위 점수 재계산이 필요하며, 이는 후속 과제입니다.
- **쿠키 도메인 범위**: 세션 쿠키가 상위 도메인 전체로 열려 있어, 서브도메인
  하나가 장악되면 세션이 함께 노출됩니다. Origin 검증이 한 겹 더 있지만
  같은 상위 도메인 안의 오리진은 걸러내지 못합니다.
- **`/ranking` 응답의 userid**: Google `sub`가 그대로 노출됩니다. 이 값은
  `/profile/:uid`의 공개 키이기도 해 현재 구조상 준공개 식별자입니다.
