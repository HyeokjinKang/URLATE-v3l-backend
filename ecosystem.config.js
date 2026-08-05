module.exports = {
  apps: [
    {
      name: "URLATE-v3l-backend",
      script: "./dist/index.js",

      // 재시작은 배포 워크플로가 pm2 startOrReload로 명시적으로 수행합니다
      // (.github/workflows/deploy.yml). watch는 켜지 않습니다.
      //
      // watch에 재시작을 맡기면 rsync가 파일을 순차 복사하는 도중 재시작이
      // 걸려 반쯤 복사된 트리로 기동할 수 있습니다. 또 ignore_watch를 지정하면
      // pm2의 기본 무시 규칙(/[\/\\]\.|node_modules/)이 통째로 대체되어
      // 의존성 변경까지 재시작을 유발합니다(pm2 lib/Watcher.js).
      watch: false,

      // SIGTERM을 받은 뒤 정리(진행 중 요청 종료, DB/Redis 연결 해제)를 마칠
      // 시간을 줍니다. 애플리케이션 쪽 상한(10초)보다 넉넉하게 잡습니다.
      kill_timeout: 15000,
    },
  ],
};
