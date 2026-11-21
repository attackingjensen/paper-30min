/** JPEG 结构校验：解析 SOF 尺寸并核验段结构与扫描边界（SPEC-pdf-import §4.3）。
 * 损坏或不受支持的编码按 parse-asset-missing 降级；超像素声明在解码前拒绝。 */

const PIXEL_BUDGET = 16_000_000;

/** SOF0–SOF15 中受支持的基线／渐进编码；差分、算术与无损编码不受支持。 */
const SUPPORTED_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcb]);

function unsupportedSof(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc &&
    !SUPPORTED_SOF.has(marker)
  );
}

export type JpegValidation = { status: "ok" } | { status: "invalid" } | { status: "pixel-budget-exceeded" };

/** 校验实际 JPEG 字节：段边界完整、SOF 尺寸受预算约束、扫描以 EOI 结束。 */
export function validateJpeg(bytes: Buffer): JpegValidation {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { status: "invalid" };
  let offset = 2;
  let width = 0;
  let height = 0;
  let components = 0;
  let sawSos = false;
  while (offset + 1 < bytes.length) {
    // 段标记前允许填充字节（规范允许任意个 0xFF）。
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return { status: "invalid" };
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) return sawSos && components > 0 ? { status: "ok" } : { status: "invalid" };
    if (marker === 0xd8 || offset + 2 > bytes.length) return { status: "invalid" };
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return { status: "invalid" };
    const payload = offset + 2;
    const end = offset + length;
    if (unsupportedSof(marker)) return { status: "invalid" };
    if (SUPPORTED_SOF.has(marker)) {
      if (components !== 0 || length < 8) return { status: "invalid" };
      height = bytes.readUInt16BE(payload + 1);
      width = bytes.readUInt16BE(payload + 3);
      components = bytes[payload + 5];
      if (
        height === 0 ||
        width === 0 ||
        (components !== 1 && components !== 3 && components !== 4) ||
        length !== 8 + 3 * components
      )
        return { status: "invalid" };
      if (width * height > PIXEL_BUDGET) return { status: "pixel-budget-exceeded" };
    }
    if (marker === 0xda) {
      // SOS 头之后是熵编码数据：跳过 stuffed 0xFF00 与 RSTn，直到真实 EOI。
      if (components === 0 || length < 6) return { status: "invalid" };
      const scanComponents = bytes[payload];
      if (scanComponents < 1 || scanComponents > components || length !== 6 + 2 * scanComponents)
        return { status: "invalid" };
      sawSos = true;
      offset = end;
      while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const next = bytes[offset + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        if (next === 0xff) {
          offset += 1;
          continue;
        }
        break;
      }
      if (offset + 1 >= bytes.length || bytes[offset] !== 0xff || bytes[offset + 1] !== 0xd9)
        return { status: "invalid" };
      return { status: "ok" };
    }
    offset = end;
  }
  return { status: "invalid" };
}
