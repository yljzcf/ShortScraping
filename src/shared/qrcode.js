/**
 * ShortScraping 极简二维码生成模块（无外部依赖）
 *
 * 为本项目自研实现，算法依 ISO/IEC 18004 标准，随项目以 MIT 许可分发。
 * 能力边界：仅 Byte 模式、纠错级别 M、版本 1-3（正文 ≤42 字节）——
 * 覆盖局域网链接（http://<IPv4>:<端口> ≤ 29 字节）绰绰有余，超长抛错。
 *
 * API：
 *   QrCode.generate(text) -> { version, size, mask, modules: boolean[][] }
 *   QrCode.drawToCanvas(canvas, text, moduleSize = 4, margin = 4)
 */
(function (global) {
  'use strict';

  // 版本参数（纠错级别 M，均为单纠错块）：size 边长、数据/纠错码字数、校正图案中心坐标
  const VERSIONS = [
    null,
    { size: 21, dataCodewords: 16, eccCodewords: 10, align: [] },
    { size: 25, dataCodewords: 28, eccCodewords: 16, align: [6, 18] },
    { size: 29, dataCodewords: 44, eccCodewords: 26, align: [6, 22] }
  ];

  // GF(256) 指数/对数表（本原多项式 0x11d）
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function initGf() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  // Reed-Solomon 生成多项式 ∏(x + α^i)，系数最高次在前
  function rsGeneratorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  // 多项式长除法取余，余数即纠错码字
  function rsEncode(data, degree) {
    const gen = rsGeneratorPoly(degree);
    const rem = data.concat(new Array(degree).fill(0));
    for (let i = 0; i < data.length; i++) {
      const factor = rem[i];
      if (factor === 0) continue;
      for (let j = 0; j < gen.length; j++) {
        rem[i + j] ^= gfMul(gen[j], factor);
      }
    }
    return rem.slice(data.length);
  }

  function pushBits(bits, value, count) {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }

  // Byte 模式装配：模式头 + 计数 + 数据 + 终止符 + 字节对齐 + 0xEC/0x11 交替填充 + RS 纠错
  function buildCodewords(bytes, ver) {
    const bits = [];
    pushBits(bits, 4, 4);
    pushBits(bits, bytes.length, 8);
    for (const b of bytes) pushBits(bits, b, 8);

    const capacity = ver.dataCodewords * 8;
    pushBits(bits, 0, Math.min(4, capacity - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    const padBytes = [0xec, 0x11];
    let padIndex = 0;
    while (bits.length < capacity) {
      pushBits(bits, padBytes[padIndex % 2], 8);
      padIndex++;
    }

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      data.push(byte);
    }
    return data.concat(rsEncode(data, ver.eccCodewords));
  }

  function createMatrix(size) {
    const rows = [];
    for (let r = 0; r < size; r++) rows.push(new Array(size).fill(false));
    return rows;
  }

  // 功能图形：定位/分隔、时序、校正、暗模块与格式信息保留区
  function drawFunctionPatterns(modules, isFunction, ver) {
    const size = ver.size;
    const setFunc = (r, c, dark) => {
      modules[r][c] = dark;
      isFunction[r][c] = true;
    };

    const drawFinder = (row, col) => {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = row + r;
          const cc = col + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const inFinder = r >= 0 && r <= 6 && c >= 0 && c <= 6;
          const dark = inFinder &&
            (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          setFunc(rr, cc, dark);
        }
      }
    };
    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // 时序图形
    for (let i = 8; i < size - 8; i++) {
      const dark = i % 2 === 0;
      setFunc(6, i, dark);
      setFunc(i, 6, dark);
    }

    // 校正图案（5×5，环形）：跳过与定位图案重叠的三个角
    for (const r of ver.align) {
      for (const c of ver.align) {
        if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            setFunc(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
          }
        }
      }
    }

    // 格式信息保留区（先占位，选定掩码后由 drawFormatBits 写真值）+ 固定暗模块
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        setFunc(8, i, false);
        setFunc(i, 8, false);
      }
      if (i < 8) setFunc(8, size - 1 - i, false);
      if (i < 7) setFunc(size - 1 - i, 8, false);
    }
    setFunc(size - 8, 8, true);
  }

  // 之字形布线：列对从右往左，跳过第 6 列时序线；剩余模块留白（版本 2/3 的 7 个余数位）
  function drawCodewords(modules, isFunction, codewords, size) {
    let bitIndex = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          const upward = ((right + 1) & 2) === 0;
          const row = upward ? size - 1 - vert : vert;
          if (isFunction[row][col] || bitIndex >= totalBits) continue;
          modules[row][col] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
      }
    }
  }

  // 8 种数据掩码（r 行 c 列）
  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0
  ];

  function applyMask(modules, isFunction, size, maskFn) {
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunction[r][c] && maskFn(r, c)) modules[r][c] = !modules[r][c];
      }
    }
  }

  // 15 位格式信息：M 级（级别位 00）左移 3 位并入掩码号，BCH(15,5) 补 10 位，再异或 0x5412
  function formatInfoBits(maskId) {
    const data = maskId;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function drawFormatBits(modules, isFunction, size, maskId) {
    const bits = formatInfoBits(maskId);
    const bit = i => ((bits >>> i) & 1) !== 0;
    const setFunc = (r, c, dark) => {
      modules[r][c] = dark;
      isFunction[r][c] = true;
    };

    // 第一份：绕左上定位图案
    for (let i = 0; i <= 5; i++) setFunc(i, 8, bit(i));
    setFunc(7, 8, bit(6));
    setFunc(8, 8, bit(7));
    setFunc(8, 7, bit(8));
    for (let i = 9; i < 15; i++) setFunc(8, 14 - i, bit(i));

    // 第二份：右上横排 + 左下竖排
    for (let i = 0; i < 8; i++) setFunc(8, size - 1 - i, bit(i));
    for (let i = 8; i < 15; i++) setFunc(size - 15 + i, 8, bit(i));
    setFunc(size - 8, 8, true);
  }

  // 掩码惩罚分（ISO 18004 四规则），分数越低可读性越好
  function penaltyScore(modules, size) {
    let score = 0;

    // 规则 1：行/列内连续同色 ≥5
    for (let axis = 0; axis < 2; axis++) {
      for (let i = 0; i < size; i++) {
        let runColor = null;
        let runLen = 0;
        for (let j = 0; j < size; j++) {
          const dark = axis === 0 ? modules[i][j] : modules[j][i];
          if (dark === runColor) {
            runLen++;
          } else {
            if (runLen >= 5) score += 3 + (runLen - 5);
            runColor = dark;
            runLen = 1;
          }
        }
        if (runLen >= 5) score += 3 + (runLen - 5);
      }
    }

    // 规则 2：2×2 同色块
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const d = modules[r][c];
        if (d === modules[r][c + 1] && d === modules[r + 1][c] && d === modules[r + 1][c + 1]) score += 3;
      }
    }

    // 规则 3：1011101 定位样式且一侧带 4 个空白（行与列两方向）
    const PATTERN = [true, false, true, true, true, false, true];
    for (let axis = 0; axis < 2; axis++) {
      const get = axis === 0
        ? (i, j) => modules[i][j]
        : (i, j) => modules[j][i];
      for (let i = 0; i < size; i++) {
        for (let start = 0; start + 7 <= size; start++) {
          let matched = true;
          for (let k = 0; k < 7; k++) {
            if (get(i, start + k) !== PATTERN[k]) {
              matched = false;
              break;
            }
          }
          if (!matched) continue;

          const clear = (from, len) => {
            if (from < 0 || from + len > size) return false;
            for (let k = 0; k < len; k++) {
              if (get(i, from + k)) return false;
            }
            return true;
          };
          if (clear(start - 4, 4) || clear(start + 7, 4)) score += 40;
        }
      }
    }

    // 规则 4：暗模块占比偏离 50% 的程度
    let dark = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (modules[r][c]) dark++;
      }
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;

    return score;
  }

  function generate(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));

    let version = 0;
    for (let v = 1; v < VERSIONS.length; v++) {
      // 模式头 4 位 + 计数 8 位，向下取整为字节容量
      const capacity = Math.floor((VERSIONS[v].dataCodewords * 8 - 12) / 8);
      if (bytes.length <= capacity) {
        version = v;
        break;
      }
    }
    if (version === 0) {
      throw new Error(`文本过长（${bytes.length} 字节），二维码模块最多支持 42 字节`);
    }

    const ver = VERSIONS[version];
    const size = ver.size;
    const codewords = buildCodewords(bytes, ver);

    // 基础矩阵：功能图形 + 未掩码数据
    const baseModules = createMatrix(size);
    const isFunction = createMatrix(size);
    drawFunctionPatterns(baseModules, isFunction, ver);
    drawCodewords(baseModules, isFunction, codewords, size);

    // 8 种掩码全试，取惩罚分最低者
    let best = null;
    for (let maskId = 0; maskId < 8; maskId++) {
      const modules = baseModules.map(row => row.slice());
      applyMask(modules, isFunction, size, MASKS[maskId]);
      drawFormatBits(modules, isFunction, size, maskId);
      const score = penaltyScore(modules, size);
      if (best === null || score < best.score) {
        best = { modules, maskId, score };
      }
    }

    return { version, size, mask: best.maskId, modules: best.modules };
  }

  // 画到 canvas：白底黑模块，margin 为四周静区模块数（标准建议 ≥4）
  function drawToCanvas(canvas, text, moduleSize, margin) {
    const scale = moduleSize || 4;
    const quiet = margin === undefined ? 4 : margin;
    const qr = generate(text);
    const dim = (qr.size + quiet * 2) * scale;
    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) {
          ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
      }
    }
    return qr;
  }

  global.QrCode = { generate, drawToCanvas };
})(typeof globalThis !== 'undefined' ? globalThis : this);
