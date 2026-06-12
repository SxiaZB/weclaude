// LAN IPv4 lookup for detail URLs. 当 daemon 绑 0.0.0.0 时, 详情链接里塞回环地址
// 手机端就打不开; 这里挑一张物理网卡的私网 IP 替换回环。
//
// 排序策略: 物理网卡 (en0/eth0/wlan0) > 普通 > 隧道/Docker/虚拟网卡。
// VPN 在跑的时候 utun* 会有公网/内网 IP, 但企微桌面端走系统 DNS, 让物理网段优先更稳。
import { networkInterfaces } from "node:os";

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const PHYS = /^(en0|eth0|wlan0|en1)$/;
const VIRT = /^(utun|tun|tap|docker|br-|veth|vmnet|vboxnet|awdl|llw|bridge)/;

const score = (name: string): number =>
  PHYS.test(name) ? 0 : VIRT.test(name) ? 2 : 1;

// 网卡枚举本身很便宜, 但每次构造 detail URL 都查一次也无意义。30s 缓存够用;
// 拔网线/切 WiFi 后最多 30s 内 URL 还指向旧 IP — 详情页是 nice-to-have, 不影响主流程。
const TTL_MS = 30_000;
let cached: { ip: string | undefined; at: number } | null = null;

export const getLanIP = (): string | undefined => {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.ip;
  const ip = Object.entries(networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).map((i) => ({ name, ...i })))
    .filter(
      (i) =>
        i.family === "IPv4" &&
        !i.internal &&
        PRIVATE.test(i.address) &&
        !i.address.startsWith("169.254."),
    )
    .sort((a, b) => score(a.name) - score(b.name))[0]?.address;
  cached = { ip, at: Date.now() };
  return ip;
};

// 仅在 host 是通配地址时把回环替换成 LAN IP; 显式 127.0.0.1 / 自定义 host 保持原样。
export const resolvePublicHost = (host: string): string => {
  if (host === "0.0.0.0" || host === "::" || host === "") {
    return getLanIP() ?? "127.0.0.1";
  }
  return host;
};
