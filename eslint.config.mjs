import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    // 빌드 산출물과 생성 파일은 검사 대상이 아닙니다.
    // src/types는 `pnpm generate-types-from-schema`가 만들어 내며 손으로
    // 고치면 안 되는 파일이라, 여기서 걸러 두지 않으면 생성기가 넣는
    // /* eslint-disable */ 헤더가 매번 경고로 남습니다.
    ignores: ["dist/**", "src/types/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.node },
  },
  tseslint.configs.recommended,
]);
