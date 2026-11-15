import { randomUUID } from "crypto";

import express from "express";
import multer from "multer";
import signale from "signale";

import { createErrorResponse } from "../api-response";
import { invalidate, keys } from "../cache";
import { knex } from "../db";
import { rateLimit } from "../middleware/rate-limit";
import { requireLogin } from "../middleware/require-login";
import {
  MAX_UPLOAD_BYTES,
  ProfileImageType,
  deleteQuietly,
  encodeImage,
  isAllowedImage,
  isExplicit,
  isProfileImageReady,
  ownedStorageFile,
  publicUrl,
  uploadToBunny,
} from "../services/profile-image";

export const router = express.Router();

// explicit bitfield: 2=background, 1=picture.
const EXPLICIT_BIT: Record<ProfileImageType, number> = {
  picture: 1,
  background: 2,
};

const isProfileImageType = (value: string): value is ProfileImageType =>
  Object.hasOwn(EXPLICIT_BIT, value);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith("image/"));
  },
}).single("img");

const uploadFailed = (
  res: express.Response,
  status: number,
  error: string,
  description: string,
) => {
  res.status(status).json(createErrorResponse("failed", error, description));
};

router.post(
  "/profile/:type",
  requireLogin,
  rateLimit({
    windowSec: 60,
    max: 10,
    prefix: "profileImage",
    key: (req) => req.session.userid,
  }),
  (req, res, next) => {
    if (!isProfileImageType(req.params.type as string)) {
      uploadFailed(res, 400, "Invalid type", "Unknown profile image type.");
      return;
    }
    if (!isProfileImageReady()) {
      uploadFailed(
        res,
        503,
        "Unavailable",
        "Profile image upload is not available right now.",
      );
      return;
    }
    upload(req, res, (err: unknown) => {
      if (err) {
        uploadFailed(
          res,
          400,
          "Upload failed",
          err instanceof multer.MulterError
            ? err.message
            : "Could not read the upload.",
        );
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const userid = req.session.userid as string;
    const type = req.params.type as ProfileImageType;
    const file = req.file;

    if (!file || !(await isAllowedImage(file.buffer))) {
      uploadFailed(res, 400, "Invalid image", "Unsupported image.");
      return;
    }

    let image: Buffer;
    let explicit: boolean;
    try {
      image = await encodeImage(file.buffer, type);
      explicit = await isExplicit(image);
    } catch (e) {
      signale.error(e);
      uploadFailed(res, 400, "Invalid image", "Unsupported image.");
      return;
    }

    const filename = `${Date.now()}-${randomUUID()}.webp`;
    try {
      await uploadToBunny(filename, image);
    } catch (e) {
      signale.error(e);
      uploadFailed(res, 502, "Storage upload failed", "Failed to store image.");
      return;
    }

    const url = publicUrl(filename);
    let previous: unknown;
    let nickname: string | undefined;
    try {
      const found = await knex.transaction(async (trx) => {
        const users = await trx("users")
          .select(type, "explicit", "nickname")
          .where("userid", userid)
          .forUpdate();
        if (!users.length) return false;
        previous = users[0][type];
        nickname = users[0].nickname;
        const bit = EXPLICIT_BIT[type];
        const flags = Number(users[0].explicit);
        await trx("users")
          .update({
            [type]: url,
            explicit: explicit ? flags | bit : flags & ~bit,
          })
          .where("userid", userid);
        return true;
      });
      if (!found) {
        deleteQuietly(filename);
        uploadFailed(res, 400, "Failed to Load", "Cannot find user.");
        return;
      }
    } catch (e) {
      signale.error(e);
      deleteQuietly(filename);
      uploadFailed(
        res,
        500,
        "Error occurred while updating",
        "Internal server error.",
      );
      return;
    }

    await invalidate(
      keys.profile(userid),
      keys.user(userid),
      nickname ? keys.profilePic(nickname) : null,
    );
    deleteQuietly(ownedStorageFile(previous));

    res.status(200).json({ result: "success", url, explicit });
  },
);
