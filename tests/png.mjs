/**
 * png.mjs —— 只够用的小 PNG 解码器（无第三方依赖）
 *
 * 为什么要自己解码：CDP 的 Page.captureScreenshot 只给 base64 PNG。
 * 要判断「气泡到底画成什么样」这种问题，读 CSS 声明没用——
 * 声明里写着 border-radius: 18px，画出来可能是方板。
 * 必须把像素拿回来自己看。
 *
 * 支持：8bit、RGB / RGBA、非隔行（Chrome 截图就是这个格式）。
 */

import zlib from 'node:zlib';

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit PNG，实际 ' + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (!channels) throw new Error('只支持 RGB/RGBA，colorType=' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const base = y * stride;
    const prev = base - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[base + x - channels] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = (y > 0 && x >= channels) ? out[prev + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[base + x] = v & 255;
    }
  }

  return {
    width, height, channels,
    /** 取一个像素，返回 [r,g,b] */
    px(x, y) {
      const cx = Math.min(width - 1, Math.max(0, Math.round(x)));
      const cy = Math.min(height - 1, Math.max(0, Math.round(y)));
      const i = cy * stride + cx * channels;
      return [out[i], out[i + 1], out[i + 2]];
    },
    /** 一条水平线上的颜色（用于扫描边界） */
    row(y, x0, x1) {
      const vals = [];
      for (let x = x0; x <= x1; x++) vals.push(this.px(x, y)[0]);
      return vals;
    },
  };
}

/** 两张同尺寸截图的像素差异比例（0..1），用于验证「不再通栏铺满」 */
export function diffRatio(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let n = 0, total = 0;
  for (let y = 0; y < a.height; y += 3) {
    for (let x = 0; x < a.width; x += 3) {
      const p = a.px(x, y), q = b.px(x, y);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 12) n++;
      total++;
    }
  }
  return total ? n / total : 0;
}

export const channelMaxDiff = (a, b) =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
