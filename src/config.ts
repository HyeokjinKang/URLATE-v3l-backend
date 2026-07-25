import { URLATEConfig } from "./types/config.schema";

// 설정 파일을 한 곳에서만 읽어 모듈 간 중복 로드를 없앱니다.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config: URLATEConfig = require(__dirname + "/../config/config.json");

export default config;
