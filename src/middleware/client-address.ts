import { isIPv4, isIPv6 } from "net";

const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

const expandIPv6 = (address: string): string[] => {
  const [head, tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = address.includes("::") && tail ? tail.split(":") : [];
  const fill = address.includes("::") ? 8 - left.length - right.length : 0;
  return [...left, ...Array(fill).fill("0"), ...right];
};

export const addressBucket = (address: string): string => {
  const mapped = IPV4_MAPPED.exec(address);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (!isIPv6(address)) return address;
  const groups = expandIPv6(address.split("%")[0].toLowerCase());
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":")}::/64`;
};
