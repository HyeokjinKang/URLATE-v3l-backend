export type BunnyZone = {
  endpoint: string;
  storageZone: string;
  accessKey: string;
};

export type BunnyObject = {
  ObjectName: string;
  Length: number;
  IsDirectory: boolean;
};

const TIMEOUT_MS = 15000;

const objectUrl = (zone: BunnyZone, objectPath: string) =>
  `https://${zone.endpoint}/${zone.storageZone}/${objectPath}`;

const fail = (status: number) =>
  new Error(`BunnyCDN storage responded with ${status}`);

export const putObject = async (
  zone: BunnyZone,
  objectPath: string,
  body: Uint8Array<ArrayBuffer>,
  contentType: string,
) => {
  const response = await fetch(objectUrl(zone, objectPath), {
    method: "PUT",
    headers: { AccessKey: zone.accessKey, "Content-Type": contentType },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw fail(response.status);
};

/** A path ending with "/" deletes the directory and everything under it. */
export const deleteObject = async (zone: BunnyZone, objectPath: string) => {
  const response = await fetch(objectUrl(zone, objectPath), {
    method: "DELETE",
    headers: { AccessKey: zone.accessKey },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 404) throw fail(response.status);
};

/** `dirPath` must end with "/", or be empty for the zone root. */
export const listObjects = async (
  zone: BunnyZone,
  dirPath: string,
): Promise<BunnyObject[]> => {
  const response = await fetch(objectUrl(zone, dirPath), {
    headers: { AccessKey: zone.accessKey, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw fail(response.status);
  const body: unknown = await response.json();
  return Array.isArray(body) ? (body as BunnyObject[]) : [];
};
