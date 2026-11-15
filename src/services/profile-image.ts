import path from "path";

import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-wasm";
import * as nsfw from "nsfwjs";
import sharp from "sharp";
import signale from "signale";

import config from "../config";
import { deleteObject, putObject } from "./bunny-storage";

export type ProfileImageType = "picture" | "background";

const RESIZE: Record<ProfileImageType, sharp.ResizeOptions> = {
  picture: { width: 256, height: 256 },
  background: {
    width: 2560,
    height: 2560,
    fit: "inside",
    withoutEnlargement: true,
  },
};

export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

const MAX_INPUT_PIXELS = 40_000_000;
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp", "gif"]);
const CLASSIFY_SIZE = 512;
const SAFE_CLASSES = new Set(["Drawing", "Neutral"]);

const PROFILE_FILENAME =
  /^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;

// pfp.webp is the default picture shared by every user who never uploaded one.
const PROTECTED_FILENAMES = new Set(["pfp.webp"]);

const BUNNY_PATH = String(config.bunny?.path ?? "profiles").replace(
  /^\/+|\/+$/g,
  "",
);

let model: nsfw.NSFWJS | undefined;

export const isProfileImageReady = () => !!model && !!config.bunny;

export const initProfileImage = async () => {
  if (!config.bunny) {
    signale.warn("bunny is not configured, profile image upload is disabled.");
    return;
  }
  if (!config.project.nsfw) {
    signale.warn(
      "project.nsfw is not configured, profile image upload is disabled.",
    );
    return;
  }
  await tf.setBackend("wasm");
  await tf.ready();
  model = await nsfw.load(`${config.project.nsfw}/mobilenet_v2/`);
  signale.success("NSFW model loaded.");
};

const storagePath = (filename: string) => `${BUNNY_PATH}/${filename}`;

export const publicUrl = (filename: string) =>
  `${config.project.cdn}/${BUNNY_PATH}/${filename}`;

export const uploadToBunny = (filename: string, buffer: Buffer) =>
  putObject(
    config.bunny!,
    storagePath(filename),
    new Uint8Array(buffer),
    "image/webp",
  );

export const deleteFromBunny = (filename: string) =>
  deleteObject(config.bunny!, storagePath(filename));

export const deleteQuietly = (filename: string | null) => {
  if (!filename) return;
  deleteFromBunny(filename).catch((err) => {
    signale.warn(`Failed to delete ${filename} from BunnyCDN storage.`);
    signale.warn(err);
  });
};

export const ownedStorageFile = (fileUrl: unknown): string | null => {
  if (typeof fileUrl !== "string") return null;
  if (!fileUrl.startsWith(`${config.project.cdn}/${BUNNY_PATH}/`)) return null;
  let filename: string;
  try {
    filename = path.basename(new URL(fileUrl).pathname);
  } catch {
    return null;
  }
  if (PROTECTED_FILENAMES.has(filename) || !PROFILE_FILENAME.test(filename))
    return null;
  return filename;
};

export const isAllowedImage = async (buffer: Buffer): Promise<boolean> => {
  try {
    const { format, width, height } = await sharp(buffer, {
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
    return ALLOWED_FORMATS.has(format) && width * height <= MAX_INPUT_PIXELS;
  } catch {
    return false;
  }
};

export const encodeImage = (buffer: Buffer, type: ProfileImageType) =>
  sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(RESIZE[type])
    .flatten({ background: "#ffffff" })
    .webp({ quality: 70, effort: 6 })
    .toBuffer();

export const isExplicit = async (buffer: Buffer): Promise<boolean> => {
  if (!model) throw new Error("NSFW model is not loaded");
  const { data, info } = await sharp(buffer)
    .resize({
      width: CLASSIFY_SIZE,
      height: CLASSIFY_SIZE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = tf.tensor3d(
    new Uint8Array(data),
    [info.height, info.width, info.channels],
    "int32",
  );
  try {
    const predictions = await model.classify(image);
    return !SAFE_CLASSES.has(predictions[0].className);
  } finally {
    image.dispose();
  }
};
