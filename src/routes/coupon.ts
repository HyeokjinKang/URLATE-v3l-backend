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
    // Carries a validation failure out alongside the transaction rollback.
    class CouponError extends Error {
      constructor(
        public error: string,
        public description: string,
      ) {
        super(description);
      }
    }

    const userid = req.session.userid as string;
    // An object/array here would let knex build an unintended query condition.
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
      // Transaction + row lock to serialize concurrent uses of the same code.
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
        // usedUser can be NULL or the string "null".
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
        // Fail with a clear error if the reward definition is malformed.
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
      // Invalidate the caller's cache so the granted skin shows up immediately.
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
