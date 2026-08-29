/**
 * 创建简单的图标文件
 * 运行: node create-icons.js
 */

const fs = require('fs');
const path = require('path');

// 简单的 16x16 PNG 图标 (蓝色方形)
// 这是一个最小化的 PNG 文件
function createSimplePNG(size) {
  // 创建一个简单的 PNG 文件
  const width = size;
  const height = size;

  // PNG 签名
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const ihdr = createChunk('IHDR', ihdrData);

  // IDAT chunk (简单的图像数据)
  // 每行: filter byte (0) + RGB pixels
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter: none
    for (let x = 0; x < width; x++) {
      // 简单的蓝色图标
      if (x < width/3) {
        // 红色部分
        rawData.push(88, 166, 255); // #58a6ff
      } else if (x < width*2/3) {
        // 绿色部分
        rawData.push(188, 140, 255); // #bc8cff
      } else {
        // 蓝色部分
        rawData.push(63, 185, 80); // #3fb950
      }
    }
  }

  const zlib = require('zlib');
  const compressed = zlib.deflateSync(Buffer.from(rawData));
  const idat = createChunk('IDAT', compressed);

  // IEND chunk
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type);
  const crcData = Buffer.concat([typeBuffer, data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = crc ^ buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return (crc ^ (-1)) >>> 0;
}

// 生成图标
const iconsDir = path.join(__dirname);

[16, 48, 128].forEach(size => {
  const png = createSimplePNG(size);
  const filename = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filename, png);
  console.log(`Created: icon${size}.png (${png.length} bytes)`);
});

console.log('Done!');
