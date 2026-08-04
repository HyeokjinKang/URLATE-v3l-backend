module.exports = {
  apps: [
    {
      name: "URLATE-v3l-backend",
      script: "./dist/index.js",

      // 배포(.github/workflows/deploy.yml)는 rsync만 수행하고 재시작 명령이
      // 없으므로, 이 watch가 곧 배포의 재시작 트리거입니다. 끄면 배포된 코드가
      // 반영되지 않습니다.
      //
      // 감시 대상을 빌드 산출물로 좁힙니다. watch: true는 앱 디렉터리 전체를
      // 감시하는데, ignore_watch를 지정하면 pm2의 기본 무시 규칙
      // (/[\/\\]\.|node_modules/)이 통째로 대체되어 node_modules 변경까지
      // 재시작을 유발합니다(pm2 lib/Watcher.js).
      watch: ["dist"],
      ignore_watch: ["node_modules", "logs", ".git"],

      // 변경 감지 후 재시작까지의 지연입니다. pm2는 첫 변경에서 restarting
      // 플래그를 세우고 이 시간만큼 기다린 뒤 한 번만 재시작하므로, rsync가
      // 파일을 순차 복사하는 동안 반쯤 복사된 트리로 재시작하는 것을 막습니다.
      watch_delay: 15000,

      // SIGTERM을 받은 뒤 정리(진행 중 요청 종료, DB/Redis 연결 해제)를 마칠
      // 시간을 줍니다. 애플리케이션 쪽 상한(10초)보다 넉넉하게 잡습니다.
      kill_timeout: 15000,
    },
  ],
};
