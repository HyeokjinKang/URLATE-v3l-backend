import express from "express";
import signale from "signale";

import { createSuccessResponse, createErrorResponse } from "../api-response";
import { invalidate, keys } from "../cache";
import { knex } from "../db";
import { rateLimit } from "../middleware/rate-limit";
import { requireLogin } from "../middleware/require-login";
import { parseJson } from "../validate";

export const router = express.Router();

router.put(
  "/coupon",
  rateLimit({ windowSec: 300, max: 30, prefix: "coupon" }),
  requireLogin,
  async (req, res) => {
    // 검증 실패를 트랜잭션 롤백과 함께 전달하기 위한 타입입니다.
    class CouponError extends Error {
      constructor(
        public error: string,
        public description: string,
      ) {
        super(description);
      }
    }

    const userid = req.session.userid as string;
    // 객체/배열이 들어오면 knex가 의도치 않은 조회 조건을 만듭니다.
    const code = req.body.code;
    if (typeof code !== "string" || !code.length || code.length > 64) {
      res
        .status(400)
        .json(
          createErrorResponse("failed", "Invalid code", "Invalid code sent."),
        );
      return;
    }
    try {
      // 같은 코드의 동시 사용을 직렬화하기 위해 트랜잭션 + 행 잠금으로 처리합니다.
      await knex.transaction(async (trx) => {
        const couponArr = await trx("codes")
          .select("reward", "used", "usedUser")
          .where("code", code)
          .forUpdate();
        if (couponArr.length != 1) {
          throw new CouponError("Invalid code", "Invalid code sent.");
        }
        const coupon = couponArr[0];
        if (coupon.used) {
          throw new CouponError(
            "Used code",
            "The code sent has already been used.",
          );
        }
        // usedUser는 NULL이거나 "null"일 수 있습니다.
        const parsedUsedUser = parseJson(coupon.usedUser);
        const usedUser: string[] = Array.isArray(parsedUsedUser)
          ? parsedUsedUser
          : [];
        if (usedUser.indexOf(userid) != -1) {
          throw new CouponError(
            "Used code",
            "The code sent has already been used.",
          );
        }
        const reward = parseJson<{
          type?: string;
          content?: string;
          nolimit?: boolean;
        }>(coupon.reward);
        // 보상 정의가 깨져 있으면 명확한 오류로 끝냅니다.
        if (!reward || typeof reward !== "object") {
          throw new CouponError("Invalid code", "Invalid code sent.");
        }
        if (reward.type == "skin") {
          const statusArr = await trx("users")
            .select("skins")
            .where("userid", userid)
            .forUpdate();
          if (!statusArr.length) {
            throw new CouponError("Invalid user", "Cannot find user.");
          }
          const parsedSkins = parseJson(statusArr[0].skins);
          const skins: string[] = Array.isArray(parsedSkins) ? parsedSkins : [];
          if (typeof reward.content !== "string") {
            throw new CouponError("Invalid code", "Invalid code sent.");
          }
          if (skins.indexOf(reward.content) != -1) {
            throw new CouponError("Already have", "User already has the skin.");
          } else {
            skins.push(reward.content);
            await trx("users")
              .update({ skins: JSON.stringify(skins) })
              .where("userid", userid);
          }
        }
        if (!reward.nolimit) {
          await trx("codes").update({ used: 1 }).where("code", code);
        } else {
          usedUser.push(userid);
          await trx("codes")
            .update({ usedUser: JSON.stringify(usedUser) })
            .where("code", code);
        }
      });
      // 스킨 지급이 곧바로 반영되도록 본인 정보 캐시를 비웁니다.
      await invalidate(keys.user(userid), keys.profile(userid));
    } catch (e) {
      if (e instanceof CouponError) {
        res
          .status(400)
          .json(createErrorResponse("failed", e.error, e.description));
        return;
      }
      signale.error(e);
      res
        .status(500)
        .json(
          createErrorResponse(
            "failed",
            "Error occured while loading",
            "Internal server error.",
          ),
        );
      return;
    }
    res.status(200).json(createSuccessResponse("success"));
  },
);
